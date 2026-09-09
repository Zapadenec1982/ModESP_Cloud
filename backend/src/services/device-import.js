'use strict';

/**
 * CSV import of devices and sites as a background job (plan epic 2.12,
 * grown out of POST /devices/pending/batch).
 *
 * The request parses and validates the file, checks the plan capacity and
 * creates an `imports` row (202). run() claims the row and walks the rows one
 * by one: a pending controller of the system tenant is assigned to the
 * organisation (credentials over MQTT, paced by IMPORT_MQTT_PACE_MS), an
 * unknown one is pre-registered, an active one is skipped. Unknown sites are
 * created and geocoded through the bulk lane. Progress counters are written
 * as the job goes so the UI can poll; per-row results are stored without
 * secrets; the new MQTT credentials are kept encrypted and handed out once.
 */

const { parse } = require('csv-parse');
const bcrypt = require('bcrypt');
const db = require('./db');
const mqttSvc = require('./mqtt');
const mqttAuth = require('./mqtt-auth');
const geocodeSvc = require('./geocode');
const { encryptSecret, decryptSecret } = require('./mfa');

const envInt = (name, fallback) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) ? n : fallback; };
const maxRows = () => envInt('IMPORT_MAX_ROWS', 2000);
const paceMs = () => envInt('IMPORT_MQTT_PACE_MS', 300);
const PROGRESS_EVERY = 5;           // rows between progress writes
const MAX_STORED_ERRORS = 200;
const HASH_BATCH = 8;
// geo_source flips to 'failed' after this many fruitless attempts (mirrors routes/sites.js)
const GEO_FAIL_AFTER_ATTEMPTS = 3;

let logger = null;
let autoRun = true;
const log = () => logger || { info() {}, warn() {}, error() {}, debug() {} };
function init(log_) {
  if (log_) logger = log_.child({ svc: 'import' });
  // A restart interrupted whatever was running; pending jobs are picked up again
  resumePending().catch(err => log().error({ err }, 'Import resume failed'));
}

// ── CSV format ────────────────────────────────────────────

// Header aliases: export format → internal name (unlisted headers are
// lower-cased with spaces → underscores, so "Site Name" needs no alias)
const haccpPresets = require('../lib/haccp-presets');
const { normalizeClaimCode, generateClaimCode } = require('../lib/claim-code');

const CSV_HEADER_ALIASES = {
  'device id':        'mqtt_device_id',
  'device_id':        'mqtt_device_id',
  'serial':           'serial_number',
  'manufactured':     'manufactured_at',
  'manufacture date': 'manufactured_at',
  'manufactured at':  'manufactured_at',
  'site':             'site_name',
  'address':          'address_line',
  'postal':           'postal_code',
  'zip':              'postal_code',
};

// maxLen mirrors the DDL (schema.sql devices, 021_sites.sql) — a longer value
// must fail validation, not blow up mid-import with a 22001.
const CSV_FIELDS = {
  mqtt_device_id:  { required: true,  pattern: /^[A-Fa-f0-9]{6,12}$/, maxLen: 12 },
  name:            { required: true,  maxLen: 128 },
  // The code printed on the controller. A pending controller belongs to the
  // organisation that claims it with this code, and the import may take one only
  // when that organisation is this one — either because it was claimed already
  // (POST /devices/claim) or because the row carries the code. Without it the CSV
  // was a way around the claim entirely: an admin who listed someone else's
  // six-digit ids took their controllers out of their queue.
  claim_code:      { required: false, pattern: /^[A-Za-z0-9\s-]{6,14}$/, maxLen: 14 },
  serial_number:   { required: false, maxLen: 64 },
  location:        { required: false, maxLen: 256 },
  model:           { required: false, maxLen: 64 },
  comment:         { required: false, maxLen: 500 },
  manufactured_at: { required: false, pattern: /^(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/, maxLen: 10 },
  // Site (торгова точка) columns — all optional, all ignored unless site_name is set
  site_name:       { required: false, maxLen: 256 },
  country:         { required: false, maxLen: 64 },
  region:          { required: false, maxLen: 128 },
  city:            { required: false, maxLen: 128 },
  address_line:    { required: false, maxLen: 256 },
  postal_code:     { required: false, maxLen: 16 },
  // HACCP critical limits (migrations 046/047): a preset by what the equipment stores
  // (lib/haccp-presets) and/or explicit numbers; explicit columns win over the preset.
  haccp_preset:    { required: false, pattern: new RegExp(`^(${haccpPresets.KEYS.join('|')})$`, 'i'), maxLen: 16 },
  haccp_min:       { required: false, pattern: /^[-−]?\d{1,2}([.,]\d)?$/, maxLen: 6 },
  haccp_max:       { required: false, pattern: /^[-−]?\d{1,2}([.,]\d)?$/, maxLen: 6 },
  haccp_tolerance: { required: false, pattern: /^(\d|[12]\d|30)([.,]\d)?$/, maxLen: 4 },
  haccp_product:   { required: false, maxLen: 96 },
};
const COLUMNS = Object.keys(CSV_FIELDS);
const TEMPLATE_EXAMPLE = ['A1B2C3', 'Вітрина 1', 'K7M2QPXR', 'SN-000123', 'Торговий зал, ліворуч', 'ModESP-VM4', '', '2026-01-15',
  'Магазин №12', 'UA', 'Львівська область', 'Львів', 'вул. Городоцька 15', '79000',
  'freezer', '', '', '', 'заморожені напівфабрикати'];

/** "−18,5" → -18.5; empty → null. The pattern check has already run. */
const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace('−', '-').replace(',', '.')));

/** The HACCP columns of a row → device fields (null = leave the column as it is). */
function haccpOf(row, lang = 'uk') {
  const out = { haccp_min: null, haccp_max: null, haccp_tolerance: null, haccp_product: null };
  const preset = haccpPresets.fieldsOf(csvField(row, 'haccp_preset'), lang);
  if (preset) Object.assign(out, preset);
  for (const k of ['haccp_min', 'haccp_max', 'haccp_tolerance']) { const v = toNum(csvField(row, k)); if (v !== null) out[k] = v; }
  const product = csvField(row, 'haccp_product');
  if (product) out.haccp_product = product;
  return out;
}

/** The CSV template an operator fills in: every column, one example row, BOM for Excel. */
function template() {
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + COLUMNS.join(',') + '\n' + TEMPLATE_EXAMPLE.map(cell).join(',') + '\n';
}

/**
 * Parse a CSV buffer row by row (async csv-parse stream) into normalised
 * objects with `_line`. Stops as soon as the row cap is exceeded, so a huge
 * file costs a bounded amount of work.
 * @throws {Error} with code 'parse_error' | 'too_many_rows'
 */
async function parseCsv(buffer, { limit = maxRows() } = {}) {
  let text = buffer.toString('utf-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const parser = parse(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
  const rows = [];
  let i = 0;
  try {
    for await (const record of parser) {
      const normalized = { _line: i + 2 };   // +2: 1-indexed + header row
      for (const [key, val] of Object.entries(record)) {
        const normKey = CSV_HEADER_ALIASES[key.toLowerCase()] || key.toLowerCase().replace(/\s+/g, '_');
        normalized[normKey] = typeof val === 'string' ? val : (val == null ? '' : String(val));
      }
      rows.push(normalized);
      i++;
      if (rows.length > limit) {
        parser.destroy();
        throw Object.assign(new Error(`CSV has more than ${limit} rows`), { code: 'too_many_rows', limit });
      }
    }
  } catch (err) {
    if (err.code === 'too_many_rows') throw err;
    throw Object.assign(new Error(`CSV parse error: ${err.message}`), { code: 'parse_error' });
  }
  return rows;
}

function validateRows(rows) {
  const errors = [];
  const seenIds = new Set();

  if (rows.length > 0) {
    const firstRow = rows[0];
    for (const [field, rule] of Object.entries(CSV_FIELDS)) {
      if (rule.required && !(field in firstRow)) {
        errors.push({ row: 1, field, message: `Missing required column: ${field}` });
      }
    }
    if (errors.length > 0) return errors;
  }

  for (const row of rows) {
    const line = row._line;
    for (const [field, rule] of Object.entries(CSV_FIELDS)) {
      const val = (row[field] || '').trim();
      if (rule.required && !val) {
        errors.push({ row: line, field, message: `${field} is required` });
        continue;
      }
      if (val && rule.pattern && !rule.pattern.test(val)) {
        errors.push({ row: line, field, message: `${field} has invalid format` });
      }
      if (val && rule.maxLen && val.length > rule.maxLen) {
        errors.push({ row: line, field, message: `${field} exceeds ${rule.maxLen} chars` });
      }
    }
    const hMin = toNum((row.haccp_min || '').trim()), hMax = toNum((row.haccp_max || '').trim());
    if (hMin !== null && hMax !== null && hMin >= hMax) {
      errors.push({ row: line, field: 'haccp_min', message: 'haccp_min must be below haccp_max' });
    }
    const devId = (row.mqtt_device_id || '').trim().toUpperCase();
    if (devId) {
      if (seenIds.has(devId)) errors.push({ row: line, field: 'mqtt_device_id', message: `Duplicate device ID: ${devId}` });
      seenIds.add(devId);
    }
    if (errors.length >= MAX_STORED_ERRORS) break;
  }
  return errors;
}

// ── Sites ─────────────────────────────────────────────────

const IMPORT_SITE_COLUMNS = `id, tenant_id, name, country_code, country, region, city,
                             address_line, postal_code, latitude, longitude, geo_source`;

const csvField = (row, field) => (row[field] || '').trim() || null;

function truncate(value, maxLen) {
  const s = (value === undefined || value === null) ? '' : String(value).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/** A bare 2-letter `country` is an ISO code ("UA"), anything longer a country name. */
function splitCountry(value) {
  if (!value) return { country_code: null, country: null };
  return /^[A-Za-z]{2}$/.test(value)
    ? { country_code: value.toUpperCase(), country: null }
    : { country_code: null, country: truncate(value, CSV_FIELDS.country.maxLen) };
}

function addressOf(row) {
  const { country_code, country } = splitCountry(csvField(row, 'country'));
  return {
    country_code, country,
    region:       truncate(csvField(row, 'region'), CSV_FIELDS.region.maxLen),
    city:         truncate(csvField(row, 'city'), CSV_FIELDS.city.maxLen),
    address_line: truncate(csvField(row, 'address_line'), CSV_FIELDS.address_line.maxLen),
    postal_code:  truncate(csvField(row, 'postal_code'), CSV_FIELDS.postal_code.maxLen),
  };
}

/**
 * Find (case/whitespace-insensitively, matching uq_sites_tenant_name) or create the
 * site named in a CSV row. Existing sites are linked as-is and never modified: an
 * import must not silently overwrite an address an admin curated by hand.
 */
async function findOrCreateImportSite(tenantId, siteName, address) {
  const select = `SELECT ${IMPORT_SITE_COLUMNS} FROM sites
                   WHERE tenant_id = $1 AND lower(btrim(name)) = lower(btrim($2::text))`;
  const found = await db.query(select, [tenantId, siteName]);
  if (found.rows.length > 0) return { site: found.rows[0], created: false };

  const inserted = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city, address_line, postal_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING ${IMPORT_SITE_COLUMNS}`,
    [tenantId, truncate(siteName, CSV_FIELDS.site_name.maxLen),
     address.country_code, address.country, address.region, address.city, address.address_line, address.postal_code]
  );
  if (inserted.rows.length > 0) return { site: inserted.rows[0], created: true };

  const again = await db.query(select, [tenantId, siteName]);
  return again.rows.length > 0 ? { site: again.rows[0], created: false } : null;
}

/**
 * Geocode a freshly imported site through the bulk lane. Never rejects; resolves
 * 'ok' | 'failed' | 'skipped' so the job can count. Honours GEOCODER_BULK_ENABLED.
 */
async function geocodeImportedSite(site) {
  try {
    const out = (await geocodeSvc.resolveAddress({
      name: site.name, address_line: site.address_line, city: site.city, region: site.region,
      postal_code: site.postal_code, country: site.country, country_code: site.country_code,
    }, { lane: 'bulk' })) || {};

    // BUSY: the queue was full — not the address's fault, so not an attempt either
    if (out.status === geocodeSvc.OUTCOME.DISABLED || out.status === geocodeSvc.OUTCOME.BUSY) return 'skipped';

    if (out.status === geocodeSvc.OUTCOME.OK && out.result) {
      const addr = out.result.address || {};
      // Never store coordinates that contradict the country the CSV named
      const want = (site.country_code || '').trim().toUpperCase();
      const got  = (addr.country_code || '').trim().toUpperCase();
      if (want && got && want !== got) {
        await recordImportGeocodeFailure(site, `country_mismatch:${got}`);
        return 'failed';
      }
      await db.query(
        `UPDATE sites
            SET latitude = $1, longitude = $2, geo_source = 'geocoded', geo_precision = $3, geocoded_at = NOW(),
                osm_type = $4, osm_id = $5,
                country_code = COALESCE(NULLIF(btrim(country_code), ''), $6),
                country      = COALESCE(NULLIF(btrim(country), ''), $7),
                region       = COALESCE(NULLIF(btrim(region), ''), $8),
                city         = COALESCE(NULLIF(btrim(city), ''), $9),
                address_line = COALESCE(NULLIF(btrim(address_line), ''), $10),
                postal_code  = COALESCE(NULLIF(btrim(postal_code), ''), $11),
                geo_attempts = 0, geo_error = NULL, updated_at = NOW()
          WHERE id = $12 AND tenant_id = $13`,
        [
          out.result.latitude, out.result.longitude,
          truncate(out.result.precision, 16), truncate(out.result.osm_type, 16),
          Number.isFinite(out.result.osm_id) ? out.result.osm_id : null,
          addr.country_code ? String(addr.country_code).trim().toUpperCase().slice(0, 2) : null,
          truncate(addr.country, 64),
          // Kyiv carries no `state`: group it under its own name
          truncate(addr.region || addr.city, 128),
          truncate(addr.city, 128), truncate(addr.address_line, 256), truncate(addr.postal_code, 16),
          site.id, site.tenant_id,
        ]
      );
      return 'ok';
    }
    await recordImportGeocodeFailure(site, out.status === geocodeSvc.OUTCOME.FAILED ? 'provider_error' : 'no_match');
    return 'failed';
  } catch (err) {
    log().warn({ err, siteId: site.id }, 'CSV import: background geocode failed');
    return 'failed';
  }
}

/** Failure bookkeeping; coordinates and geo_source of an already placed site stay. */
async function recordImportGeocodeFailure(site, reason) {
  try {
    await db.query(
      `UPDATE sites
          SET geo_attempts = geo_attempts + 1, geo_last_attempt_at = NOW(), geo_error = $3,
              geo_source = CASE WHEN geo_source = 'none' AND geo_attempts + 1 >= $4 THEN 'failed' ELSE geo_source END,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [site.id, site.tenant_id, String(reason).slice(0, 200), GEO_FAIL_AFTER_ATTEMPTS]
    );
  } catch (err) {
    log().warn({ err, siteId: site.id }, 'CSV import: could not record geocode failure');
  }
}

// ── Planning (in the request) ─────────────────────────────

/**
 * Would this row assign, pre-register, or be skipped — and why?
 *
 * One decision shared by the preview and the run, so the operator is never
 * promised an assignment the run then refuses.
 *
 * A pending controller may be taken only by the organisation that claimed it.
 * POST /devices/pending/:mqttId/assign has always enforced that; the import did
 * not, so an admin who listed someone else's six-digit ids took their controllers
 * out of their queue. A row may claim as it imports by carrying the code printed
 * on the controller — the bulk form of POST /devices/claim, and the only way in
 * besides having claimed the device beforehand.
 *
 * @param {object} row  the CSV row
 * @param {object|undefined} dev  the devices row for this id, if any
 * @returns {{action: 'assign'|'pre_register'|'skip', reason?: string}}
 */
function decideRow(row, dev, tenantId) {
  if (!dev) return { action: 'pre_register' };
  if (!(dev.status === 'pending' && dev.tenant_id === db.SYSTEM_TENANT_ID)) {
    return { action: 'skip', reason: 'Device already active' };
  }
  if (dev.claimed_by_tenant_id === tenantId) return { action: 'assign' };
  if (dev.claimed_by_tenant_id) return { action: 'skip', reason: 'Claimed by another organization' };

  const rowCode = normalizeClaimCode(csvField(row, 'claim_code'));
  if (rowCode && dev.claim_code && rowCode === dev.claim_code) return { action: 'assign' };
  return {
    action: 'skip',
    reason: rowCode
      ? 'Claim code does not match this controller'
      : 'Not claimed by your organization — add the claim_code column or claim it first',
  };
}

const CLAIM_COLUMNS = 'id, status, tenant_id, claim_code, claimed_by_tenant_id';

/**
 * Decide what each row would do today and count what the import would add:
 * the plan capacity check needs the numbers before anything is written.
 */
async function plan(tenantId, rows) {
  const ids = rows.map(r => r.mqtt_device_id.trim().toUpperCase());
  const { rows: known } = await db.query(
    `SELECT mqtt_device_id, ${CLAIM_COLUMNS} FROM devices WHERE mqtt_device_id = ANY($1)`, [ids]);
  const byId = new Map(known.map(d => [d.mqtt_device_id, d]));
  let assign = 0, preRegister = 0, skip = 0;
  const siteNames = new Set();
  for (const row of rows) {
    const id = row.mqtt_device_id.trim().toUpperCase();
    const { action } = decideRow(row, byId.get(id), tenantId);
    if (action === 'assign') {
      assign++;
      const s = csvField(row, 'site_name');
      if (s) siteNames.add(s.toLowerCase().trim());
    } else if (action === 'skip') skip++;
    else preRegister++;
  }
  let newSites = 0;
  if (siteNames.size > 0) {
    const { rows: existing } = await db.query(
      `SELECT lower(btrim(name)) AS key FROM sites WHERE tenant_id = $1 AND lower(btrim(name)) = ANY($2)`,
      [tenantId, [...siteNames]]);
    const have = new Set(existing.map(r => r.key));
    newSites = [...siteNames].filter(k => !have.has(k)).length;
  }
  return { assign, pre_register: preRegister, skip, new_sites: newSites };
}

// ── Jobs ──────────────────────────────────────────────────

const JOB_FIELDS = ['id', 'tenant_id', 'requested_by', 'status', 'file_name', 'total_rows', 'processed_rows', 'assigned', 'pre_registered',
  'skipped', 'failed_rows', 'sites_created', 'devices_with_site', 'geocode_queued', 'geocoded', 'geocode_failed',
  'credentials_downloaded_at', 'cancel_requested', 'error', 'created_at', 'started_at', 'completed_at'];
/** The job columns, qualified with `alias` when the query joins another table. */
function jobColumns(alias = '') {
  const p = alias ? `${alias}.` : '';
  return JOB_FIELDS.map(c => p + c).join(', ') + `, (${p}credentials_enc IS NOT NULL) AS credentials_available`;
}
const JOB_COLUMNS = jobColumns();

/** Create the job row; the caller answers 202 and schedule() runs it. */
async function create({ tenantId, requestedBy, fileName, rows }) {
  const { rows: [job] } = await db.query(
    `INSERT INTO imports (tenant_id, requested_by, file_name, total_rows, rows)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${JOB_COLUMNS}`,
    [tenantId, requestedBy || null, fileName ? String(fileName).slice(0, 160) : null, rows.length, JSON.stringify(rows)]);
  return job;
}

function schedule(importId) {
  if (!autoRun) return false;
  setImmediate(() => run(importId).catch(err => log().error({ err, importId }, 'CSV import crashed')));
  return true;
}

async function resumePending() {
  await db.query(`UPDATE imports SET status = 'failed', error = 'interrupted by a restart', completed_at = now(), rows = NULL WHERE status = 'running'`);
  const { rows } = await db.query(`SELECT id FROM imports WHERE status = 'pending' ORDER BY created_at`);
  for (const r of rows) schedule(r.id);
}

async function requestCancel(tenantId, importId) {
  const { rows } = await db.query(
    `UPDATE imports SET cancel_requested = true WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running') RETURNING id`,
    [importId, tenantId]);
  if (rows.length === 0) return null;
  // A job nobody has claimed yet ends right here
  const { rows: ended } = await db.query(
    `UPDATE imports SET status = 'cancelled', completed_at = now(), rows = NULL WHERE id = $1 AND status = 'pending' RETURNING id`, [importId]);
  return ended.length > 0 ? 'cancelled' : 'requested';
}

const toDate = (s) => {
  if (!s) return null;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [dd, mm, yyyy] = s.split('-'); return `${yyyy}-${mm}-${dd}`; }
  return s;
};

/**
 * Claim a pending job and process it to the end. Resolves the final row, or
 * null when someone else already has it.
 */
async function run(importId) {
  const { rows: claimed } = await db.query(
    `UPDATE imports SET status = 'running', started_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [importId]);
  const job = claimed[0];
  if (!job) return null;
  const tenantId = job.tenant_id;
  const rows = Array.isArray(job.rows) ? job.rows : [];
  const counters = { assigned: 0, pre_registered: 0, skipped: 0, failed_rows: 0, sites_created: 0, devices_with_site: 0, geocode_queued: 0, geocoded: 0, geocode_failed: 0 };
  const results = [];
  const credentials = [];
  const geocodes = [];
  const siteCache = new Map();
  const bulkGeocode = geocodeSvc.isBulkEnabled();
  let processed = 0;
  let cancelled = false;

  const { rows: tRows } = await db.query(
    'SELECT t.slug, s.locale FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1', [tenantId]);
  const tenantSlug = tRows[0] ? tRows[0].slug : null;
  const tenantLang = (tRows[0] && tRows[0].locale) || 'uk';

  const flush = async (extra = {}) => db.query(
    `UPDATE imports SET processed_rows = $2, assigned = $3, pre_registered = $4, skipped = $5, failed_rows = $6, sites_created = $7,
            devices_with_site = $8, geocode_queued = $9, geocoded = $10, geocode_failed = $11 ${extra.sql || ''} WHERE id = $1`,
    [importId, processed, counters.assigned, counters.pre_registered, counters.skipped, counters.failed_rows, counters.sites_created,
      counters.devices_with_site, counters.geocode_queued, counters.geocoded, counters.geocode_failed, ...(extra.params || [])]);

  try {
    if (!tenantSlug) throw new Error('Tenant not found');

    // Decide each row's action now — the world may have moved since planning — and
    // hash the passwords of the rows to assign, eight at a time.
    for (const row of rows) {
      const mqttId = row.mqtt_device_id.trim().toUpperCase();
      row._mqttId = mqttId;
      const { rows: devRows } = await db.query(
        `SELECT ${CLAIM_COLUMNS} FROM devices WHERE mqtt_device_id = $1`, [mqttId]);
      const decision = decideRow(row, devRows[0], tenantId);
      row._action = decision.action;
      if (decision.reason) row._skipReason = decision.reason;
      if (decision.action === 'assign') { row._dbId = devRows[0].id; row._password = mqttAuth.generatePassword(); }
    }
    const toAssign = rows.filter(r => r._action === 'assign');
    for (let i = 0; i < toAssign.length; i += HASH_BATCH) {
      await Promise.all(toAssign.slice(i, i + HASH_BATCH).map(r => bcrypt.hash(r._password, 12).then(h => { r._hash = h; })));
    }

    for (const row of rows) {
      if (processed % PROGRESS_EVERY === 0) {
        const { rows: [state] } = await db.query('SELECT cancel_requested FROM imports WHERE id = $1', [importId]);
        if (state && state.cancel_requested) { cancelled = true; break; }
      }
      const mqttId = row._mqttId;
      const name = (row.name || '').trim();
      const location = csvField(row, 'location');
      const model = csvField(row, 'model');
      const serialNumber = csvField(row, 'serial_number');
      const comment = csvField(row, 'comment');
      const manufacturedAt = toDate(csvField(row, 'manufactured_at'));
      const haccp = haccpOf(row, tenantLang);
      const base = { row: row._line, mqtt_device_id: mqttId, name };

      try {
        if (row._action === 'skip') {
          counters.skipped++;
          results.push({ ...base, status: 'skipped', error: row._skipReason });
        } else if (row._action === 'assign') {
          // Optional site link. Only the assign path may set site_id: the device's
          // tenant becomes the organisation here; a pre-registered row stays in the
          // system tenant, which owns no sites.
          let siteId = null, siteName = null;
          const csvSiteName = csvField(row, 'site_name');
          if (csvSiteName) {
            const cacheKey = csvSiteName.toLowerCase();
            try {
              let resolved = siteCache.get(cacheKey);
              if (resolved === undefined) {
                resolved = await findOrCreateImportSite(tenantId, csvSiteName, addressOf(row));
                siteCache.set(cacheKey, resolved);
                if (resolved && resolved.created) {
                  counters.sites_created++;
                  if (bulkGeocode && (resolved.site.address_line || resolved.site.city)) {
                    counters.geocode_queued++;
                    geocodes.push(geocodeImportedSite(resolved.site).then(r => {
                      if (r === 'ok') counters.geocoded++;
                      else if (r === 'failed') counters.geocode_failed++;
                    }));
                  }
                }
              }
              if (resolved) { siteId = resolved.site.id; siteName = resolved.site.name; counters.devices_with_site++; }
            } catch (err) {
              // A bad site must not cost the operator the device row
              log().warn({ err, site: csvSiteName, row: row._line }, 'CSV import: site link failed');
            }
          }

          const newUsername = `device_${mqttId}`;
          let sentCreds = false;
          try { mqttSvc.sendJsonCommand('pending', mqttId, '_set_mqtt_creds', { user: newUsername, pass: row._password }); sentCreds = true; }
          catch (_) { /* MQTT may be unavailable */ }
          try { mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug, { qos: 1, retain: true }); }
          catch (_) { /* MQTT may be unavailable */ }

          await db.query(
            `UPDATE devices
                SET tenant_id = $1, status = 'active', mqtt_username = $2, mqtt_password_hash = $3,
                    claimed_by_tenant_id = $1,
                    name = COALESCE($4, name), location = COALESCE($5, location), model = COALESCE($6, model),
                    serial_number = COALESCE($7, serial_number), comment = COALESCE($8, comment),
                    manufactured_at = COALESCE($9, manufactured_at), site_id = $10, assigned_at = NOW(),
                    haccp_min = COALESCE($12, haccp_min), haccp_max = COALESCE($13, haccp_max),
                    haccp_tolerance = COALESCE($14, haccp_tolerance), haccp_product = COALESCE($15, haccp_product)
              WHERE id = $11 AND status = 'pending'`,
            [tenantId, newUsername, row._hash, name || null, location, model, serialNumber, comment, manufacturedAt, siteId, row._dbId,
             haccp.haccp_min, haccp.haccp_max, haccp.haccp_tolerance, haccp.haccp_product]);
          mqttSvc.recordAssign(mqttId);
          mqttSvc.clearPendingRetained(mqttId);

          counters.assigned++;
          results.push({ ...base, status: 'assigned', site_id: siteId, site_name: siteName, credentials_sent: sentCreds });
          credentials.push({ mqtt_device_id: mqttId, name, username: newUsername, password: row._password, sent_via_mqtt: sentCreds });

          // Let the controller take its credentials and reconnect before the next one
          if (paceMs() > 0) await new Promise(resolve => setTimeout(resolve, paceMs()));
        } else {
          // The row is claimed for the organisation that listed it, exactly as
          // POST /devices/bootstrap does for a device an admin registers by hand.
          // Without it the pre-registered controller stayed unclaimed and invisible:
          // the pending queue only shows what the organisation has claimed, so the
          // operator could not assign the very row they had just created.
          const { rowCount } = await db.query(
            `INSERT INTO devices (tenant_id, mqtt_device_id, status, name, location, model, serial_number, comment, manufactured_at,
                                  haccp_min, haccp_max, haccp_tolerance, haccp_product, claim_code, claimed_by_tenant_id)
             VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (mqtt_device_id) DO NOTHING`,
            [db.SYSTEM_TENANT_ID, mqttId, name || null, location, model, serialNumber, comment, manufacturedAt,
             haccp.haccp_min, haccp.haccp_max, haccp.haccp_tolerance, haccp.haccp_product,
             normalizeClaimCode(csvField(row, 'claim_code')) || generateClaimCode(), tenantId]);
          if (rowCount === 0) {
            counters.skipped++;
            results.push({ ...base, status: 'skipped', error: 'Device appeared during processing' });
          } else {
            counters.pre_registered++;
            results.push({ ...base, status: 'pre_registered' });
          }
        }
      } catch (err) {
        counters.failed_rows++;
        results.push({ ...base, status: 'failed', error: String(err.message || err).slice(0, 200) });
        log().warn({ err, row: row._line, mqttId }, 'CSV import: row failed');
      }
      processed++;
      if (processed % PROGRESS_EVERY === 0) await flush();
    }

    if (counters.assigned > 0) {
      await mqttSvc.refreshRegistries();
      mqttSvc.emit('pending_device', { action: 'batch_assigned', count: counters.assigned });
    }
    if (counters.pre_registered > 0) mqttSvc.emit('pending_device', { action: 'batch_pre_registered', count: counters.pre_registered });

    // The geocoder paces itself; wait for the sites this import created
    await Promise.allSettled(geocodes);

    const status = cancelled ? 'cancelled' : 'done';
    await flush({
      sql: `, status = $12, completed_at = now(), rows = NULL, results = $13, credentials_enc = $14`,
      params: [status, JSON.stringify(results), credentials.length ? encryptSecret(JSON.stringify(credentials)) : null],
    });
    log().info({ importId, tenantId, ...counters, processed, status }, 'CSV import finished');
  } catch (err) {
    log().error({ err, importId }, 'CSV import failed');
    await flush({
      sql: `, status = 'failed', completed_at = now(), rows = NULL, error = $12, results = $13, credentials_enc = $14`,
      params: [String(err.message || err).slice(0, 500), JSON.stringify(results), credentials.length ? encryptSecret(JSON.stringify(credentials)) : null],
    }).catch(() => {});
  }
  const { rows: [final] } = await db.query(`SELECT ${JOB_COLUMNS}, results FROM imports WHERE id = $1`, [importId]);
  return final;
}

/** Hand the credentials out once: the encrypted blob is wiped in the same transaction. */
async function takeCredentialsTx(tenantId, importId) {
  return db.transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT credentials_enc, credentials_downloaded_at, status FROM imports WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [importId, tenantId]);
    if (rows.length === 0) return { status: 'not_found' };
    if (!rows[0].credentials_enc) return { status: rows[0].credentials_downloaded_at ? 'gone' : 'none' };
    await client.query(`UPDATE imports SET credentials_enc = NULL, credentials_downloaded_at = now() WHERE id = $1`, [importId]);
    return { status: 'ok', credentials: JSON.parse(decryptSecret(rows[0].credentials_enc)) };
  });
}

/** Per-row summary for the API (counts as the UI shows them). */
function summaryOf(job) {
  return {
    total: job.total_rows, processed: job.processed_rows, assigned: job.assigned, pre_registered: job.pre_registered,
    skipped: job.skipped, failed: job.failed_rows, sites_created: job.sites_created, devices_with_site: job.devices_with_site,
    geocode_queued: job.geocode_queued, geocoded: job.geocoded, geocode_failed: job.geocode_failed,
  };
}

module.exports = {
  init, parseCsv, validateRows, plan, create, schedule, run, requestCancel, takeCredentials: takeCredentialsTx, template, summaryOf,
  CSV_FIELDS, COLUMNS, JOB_COLUMNS, jobColumns, maxRows, haccpOf, decideRow,
  __test: { setAutoRun(v) { autoRun = !!v; }, setLogger(l) { logger = l; }, findOrCreateImportSite, geocodeImportedSite, splitCountry },
};
