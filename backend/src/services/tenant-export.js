'use strict';

/**
 * Data export (plan epic 2.10): everything an organisation owns, as one zip.
 *
 * A request (tenant_exports row) is built in the background: a CSV per table
 * with the organisation's rows — people and credentials columns left out —
 * plus a HACCP PDF per site for the last year, a manifest with row counts
 * and a README. The file lives under EXPORT_DIR for EXPORT_TTL_DAYS and is
 * handed out by GET /api/tenants/:id/exports/:exportId/download; the sweep
 * in tenant-lifecycle.js removes it afterwards.
 *
 * Tables are read in key-ordered chunks, so a year of telemetry streams into
 * the archive without being held in memory.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { once } = require('events');
const archiver = require('archiver');
const { stringify } = require('csv-stringify');
const db        = require('./db');
const haccp     = require('./haccp-report');
const scheduler = require('./report-scheduler');

const CHUNK = 20_000;
const REPORT_DAYS = 365;

// Never exported: secrets, second factors, tokens, stored files
const HIDDEN = new Set([
  'password_hash', 'mfa_secret', 'mfa_pending_secret', 'mfa_backup_codes', 'mfa_last_step',
  'mqtt_password_hash', 'token_hash', 'pdf', 'email_verify_hash', 'email_verify_expires',
  'password_reset_code', 'password_reset_expires', 'telegram_link_code', 'telegram_link_expires',
  'push_token', 'tenant_id', 'secret', 'key_hash',
]);

// Order of the archive; keys are the page order when the table has no primary key
const TABLES = [
  { name: 'sites' }, { name: 'devices' }, { name: 'device_models' }, { name: 'users' },
  { name: 'alarms' }, { name: 'events' }, { name: 'service_records' }, { name: 'work_orders' },
  { name: 'maintenance_hints' }, { name: 'notification_subscribers' }, { name: 'notification_log' },
  { name: 'invoices' }, { name: 'usage_snapshots' }, { name: 'report_schedules' }, { name: 'report_exports' },
  { name: 'audit_log' }, { name: 'webhooks' },
  { name: 'telemetry_hourly', keys: ['hour', 'device_id', 'channel'] },
  { name: 'telemetry',        keys: ['time', 'device_id', 'channel'] },
];

let logger  = null;
let autoRun = true;

function log() { return logger || { info() {}, warn() {}, error() {}, debug() {} }; }
function init(log_) { if (log_) logger = log_.child({ svc: 'export' }); }
function envInt(name, fallback) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) ? n : fallback; }
function ttlDays() { return envInt('EXPORT_TTL_DAYS', 7); }
function exportDir() { return process.env.EXPORT_DIR || path.join(__dirname, '../../exports'); }
const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

// ── Table access ──────────────────────────────────────────

async function columnsOf(table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map(r => r.column_name).filter(c => !HIDDEN.has(c));
}

async function primaryKeyOf(table) {
  const { rows } = await db.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`, [table]);
  return rows.map(r => r.attname).filter(c => c !== 'tenant_id');
}

/** The organisation's rows of a table, in key order, a chunk at a time. */
async function* rowsOf(table, cols, keys, tenantId) {
  const keyList = keys.map(q).join(', ');
  let last = null;
  for (;;) {
    const params = [tenantId];
    let where = 'tenant_id = $1';
    if (last) {
      const ph = keys.map((_, i) => `$${i + 2}`).join(', ');
      params.push(...keys.map(k => last[k]));
      where += ` AND (${keyList}) > (${ph})`;
    }
    const { rows } = await db.query(
      `SELECT ${cols.map(q).join(', ')} FROM ${q(table)} WHERE ${where}${keys.length ? ` ORDER BY ${keyList}` : ''} LIMIT ${CHUNK}`, params);
    for (const r of rows) yield r;
    if (rows.length < CHUNK || keys.length === 0) return;
    last = rows[rows.length - 1];
  }
}

// ── Archive helpers ───────────────────────────────────────

function entryDone(archive, name) {
  return new Promise((resolve, reject) => {
    const onEntry = (e) => { if (e.name === name) { archive.off('entry', onEntry); archive.off('error', reject); resolve(); } };
    archive.on('entry', onEntry);
    archive.once('error', reject);
  });
}

async function appendCsv(archive, name, cols, iterator) {
  const csv = stringify({
    header: true, columns: cols, bom: true,
    cast: { date: d => d.toISOString(), boolean: b => (b ? 'true' : 'false'), object: o => JSON.stringify(o) },
  });
  const done = entryDone(archive, name);
  archive.append(csv, { name });
  let n = 0;
  for await (const row of iterator) {
    n++;
    if (!csv.write(cols.map(c => row[c]))) await once(csv, 'drain');
  }
  csv.end();
  await done;
  return n;
}

async function appendBuffer(archive, name, buffer) {
  const done = entryDone(archive, name);
  archive.append(buffer, { name });
  await done;
}

function safeName(s) {
  return String(s || '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// ── Build ─────────────────────────────────────────────────

async function build({ tenantId, filePath, now }) {
  const tenant = await scheduler.loadTenant(tenantId);
  if (!tenant) throw new Error('Organisation not found');
  const manifest = { organisation: { id: tenant.id, name: tenant.name, slug: tenant.slug }, generated_at: now.toISOString(), tables: {}, reports: [] };

  const output = fs.createWriteStream(filePath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const closed = once(output, 'close');
  archive.on('warning', err => log().warn({ err }, 'Export archive warning'));
  archive.pipe(output);

  const failed = new Promise((_, reject) => { archive.once('error', reject); output.once('error', reject); });
  const work = (async () => {
    for (const t of TABLES) {
      const cols = await columnsOf(t.name);
      if (cols.length === 0) continue;
      const pk = t.keys || await primaryKeyOf(t.name);
      const keys = pk.filter(k => cols.includes(k));
      manifest.tables[t.name] = await appendCsv(archive, `${t.name}.csv`, cols, rowsOf(t.name, cols, keys, tenantId));
    }

    // One HACCP log per site for the last year (the hourly archive covers what raw retention dropped)
    const from = new Date(now.getTime() - REPORT_DAYS * 86_400_000);
    for (const site of await scheduler.loadSites(tenantId)) {
      const devices = await db.query(
        `SELECT id, mqtt_device_id, tenant_id, name, location, serial_number, model, haccp_min, haccp_max, haccp_product, last_state
           FROM devices WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY name, mqtt_device_id LIMIT 50`,
        [site.id, tenantId]);
      if (devices.rows.length === 0) continue;
      try {
        const r = await haccp.generate({
          query: (sql, params) => db.query(sql, params), kind: 'site', tenant, site, devices: devices.rows,
          channels: ['air', 'evap', 'setpoint'], from, to: now, bucketKey: '1h', lang: tenant.locale || 'uk',
          rawRetentionDays: tenant.retention_days, generatedBy: 'export', now,
        });
        if (r.empty) continue;
        const name = `reports/haccp_${safeName(site.name)}_${site.id.slice(0, 8)}.pdf`;
        await appendBuffer(archive, name, r.buffer);
        manifest.reports.push({ site_id: site.id, site: site.name, file: name, code: haccp.fmtCode(r.code), sha256: r.hash });
      } catch (err) {
        log().warn({ err, siteId: site.id }, 'Export: HACCP report skipped');
      }
    }

    const readme = [
      `ModESP Cloud — data export for "${tenant.name}" (${tenant.slug})`,
      `Generated: ${manifest.generated_at}`,
      '',
      'One CSV per table (UTF-8 with BOM, ISO 8601 timestamps, JSON in cells where the column is JSON).',
      'Passwords, second factors, tokens and stored files are not included.',
      'reports/ holds the HACCP temperature log of every site for the last 12 months; each carries a',
      'verification code and SHA-256 that /api/public/report/<code> confirms.',
      'manifest.json lists the row count of every table.',
      '',
      'Експорт даних організації ModESP Cloud: CSV на кожну таблицю, PDF HACCP на кожну точку за останній рік,',
      'manifest.json з кількістю рядків. Паролі, другі фактори й токени не експортуються.',
    ].join('\n');
    await appendBuffer(archive, 'README.txt', Buffer.from(readme, 'utf8'));
    await appendBuffer(archive, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    await archive.finalize();
    await closed;
    return manifest;
  })();

  return Promise.race([work, failed]);
}

// ── Jobs ──────────────────────────────────────────────────

/** Claim a pending request and build it. Resolves the row, or null when someone else already has it. */
async function run(exportId, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `UPDATE tenant_exports SET status = 'running' WHERE id = $1 AND status = 'pending' RETURNING id, tenant_id`, [exportId]);
  const job = rows[0];
  if (!job) return null;
  const { rows: t } = await db.query('SELECT slug FROM tenants WHERE id = $1', [job.tenant_id]);
  const dir = path.join(exportDir(), job.tenant_id);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `modesp_${safeName(t[0] ? t[0].slug : 'export')}_${now.toISOString().slice(0, 10)}_${String(exportId).slice(0, 8)}.zip`;
  const filePath = path.join(dir, fileName);
  try {
    const manifest = await build({ tenantId: job.tenant_id, filePath, now });
    const bytes = fs.statSync(filePath).size;
    const sha = await sha256File(filePath);
    const { rows: done } = await db.query(
      `UPDATE tenant_exports
          SET status = 'ready', file_path = $2, file_name = $3, bytes = $4, sha256 = $5, manifest = $6,
              completed_at = $7::timestamptz, expires_at = $7::timestamptz + make_interval(days => $8), error = NULL
        WHERE id = $1 RETURNING id, tenant_id, requested_by, status, file_path, file_name, bytes::float8 AS bytes, sha256, manifest, error, created_at, completed_at, expires_at`,
      [exportId, filePath, fileName, bytes, sha, JSON.stringify(manifest), now, ttlDays()]);
    log().info({ exportId, tenantId: job.tenant_id, bytes }, 'Data export ready');
    return done[0];
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch { /* nothing written */ }
    log().error({ err, exportId }, 'Data export failed');
    const { rows: failedRow } = await db.query(
      `UPDATE tenant_exports SET status = 'failed', error = $2, completed_at = $3 WHERE id = $1 RETURNING *`,
      [exportId, String(err.message || err).slice(0, 1000), now]);
    return failedRow[0];
  }
}

/** Kick a build off in the background (the request already answered 202). */
function schedule(exportId) {
  if (!autoRun) return false;
  setImmediate(() => run(exportId).catch(err => log().error({ err, exportId }, 'Data export crashed')));
  return true;
}

/** Drop the files of exports past their TTL; the rows stay as history. Resolves the number expired. */
async function expire({ now = new Date() } = {}) {
  const { rows } = await db.query(
    `WITH due AS (SELECT id, file_path FROM tenant_exports WHERE status = 'ready' AND expires_at <= $1)
     UPDATE tenant_exports t SET status = 'expired', file_path = NULL FROM due WHERE t.id = due.id RETURNING due.file_path`,
    [now]);
  for (const r of rows) {
    if (r.file_path) { try { fs.unlinkSync(r.file_path); } catch { /* already gone */ } }
  }
  return rows.length;
}

module.exports = {
  init, run, schedule, expire, build, ttlDays, exportDir, TABLES, HIDDEN,
  __test: { setAutoRun(v) { autoRun = !!v; }, setLogger(l) { logger = l; } },
};
