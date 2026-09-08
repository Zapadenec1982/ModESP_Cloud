'use strict';

/**
 * Scheduled reports (plan epic 2.7).
 *
 * A schedule (report_schedules) is a standing order: every week or every
 * month, the HACCP, alarm or energy report of one site — or of every site of
 * the organisation — is generated for the period that has just ended, kept
 * in the archive (report_exports.pdf) and e-mailed to the recipients with the
 * PDFs attached.
 *
 * Periods are whole local weeks (Monday–Sunday) and whole local months in the
 * site's time zone (the organisation's for an all-sites schedule); the report
 * goes out at RUN_HOUR local time on the first day after the period. A
 * schedule remembers the end of the last period it delivered, so a period
 * never goes out twice — a manual run from the Reports page counts.
 *
 * The scheduler is its own hourly timer (REPORT_SCHEDULE_INTERVAL_MIN, 0
 * disables). Archived PDFs are dropped after REPORT_ARCHIVE_DAYS; the code,
 * hash and metadata of the report stay for verification.
 */

const db            = require('./db');
const emailSvc      = require('./email');
const planMw        = require('../middleware/plan');
const haccp         = require('./haccp-report');
const periodReports = require('./period-reports');

const TYPES    = ['haccp', 'alarms', 'energy'];
const CADENCES = ['weekly', 'monthly'];
const RUN_HOUR = 6;                       // local time of the send
const MAX_ATTACHMENTS = 10;               // per e-mail; more sites → more parts
const MAX_SITES = 100;
const DEFAULT_TZ = 'Europe/Kyiv';
const OPEN_STATUSES = ['trial', 'active', 'past_due'];
const HACCP_CHANNELS = ['air', 'evap', 'setpoint'];

const BOOT_DELAY_MS  = 90_000;
const BOOT_JITTER_MS = 30_000;

let logger    = null;
let bootTimer = null;
let poller    = null;
let running   = false;

function log() { return logger || { info() {}, warn() {}, error() {}, debug() {} }; }
function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}
function appBaseUrl() {
  return (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/+$/, '');
}

// ── Local-time arithmetic ─────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Civil date and time of an instant in a zone. */
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WEEKDAYS.indexOf(p.weekday) };
}

/** The instant at which the wall clock of `tz` shows y-m-d h:00. */
function zonedToUtc(y, m, d, h, tz) {
  const wanted = Date.UTC(y, m - 1, d, h, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(new Date(guess), tz);
    guess += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(guess);
}

function shiftCivil({ y, m, d }, days) {
  const c = new Date(Date.UTC(y, m - 1, d + days));
  return { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() };
}

/** Start (civil date) of the period `now` is in: the 1st of the month or the Monday. */
function currentPeriodStart(cadence, tz, now) {
  const p = tzParts(now, tz);
  if (cadence === 'monthly') return { y: p.y, m: p.m, d: 1 };
  return shiftCivil(p, -((p.wd + 6) % 7));
}

function previousPeriodStart(cadence, start) {
  if (cadence === 'monthly') return start.m === 1 ? { y: start.y - 1, m: 12, d: 1 } : { y: start.y, m: start.m - 1, d: 1 };
  return shiftCivil(start, -7);
}

function nextPeriodStart(cadence, start) {
  if (cadence === 'monthly') return start.m === 12 ? { y: start.y + 1, m: 1, d: 1 } : { y: start.y, m: start.m + 1, d: 1 };
  return shiftCivil(start, 7);
}

/** The whole period that ended most recently before `now`: [from, to) as instants. */
function periodFor(cadence, tz, now = new Date()) {
  const start = currentPeriodStart(cadence, tz, now);
  const prev  = previousPeriodStart(cadence, start);
  return { from: zonedToUtc(prev.y, prev.m, prev.d, 0, tz), to: zonedToUtc(start.y, start.m, start.d, 0, tz) };
}

/** The next send after `now`: RUN_HOUR on the first day of the current period if still ahead, else of the next one. */
function nextRunAfter(cadence, tz, now = new Date()) {
  const start = currentPeriodStart(cadence, tz, now);
  const candidate = zonedToUtc(start.y, start.m, start.d, RUN_HOUR, tz);
  if (candidate > now) return candidate;
  const next = nextPeriodStart(cadence, start);
  return zonedToUtc(next.y, next.m, next.d, RUN_HOUR, tz);
}

// ── Data ─────────────────────────────────────────────────

async function loadTenant(tenantId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.slug, t.status, t.legal_name, t.tax_id, t.electricity_rate, t.electricity_currency,
            COALESCE(s.timezone, $2) AS timezone, s.locale,
            COALESCE(s.raw_retention_days, p.retention_days, 90) AS retention_days,
            COALESCE(s.brand_name, par.brand_name) AS brand_name,
            COALESCE(s.brand_url, par.brand_url)   AS brand_url
       FROM tenants t
       LEFT JOIN tenant_settings s   ON s.tenant_id = t.id
       LEFT JOIN tenant_settings par ON par.tenant_id = t.parent_tenant_id
       LEFT JOIN plan_limits p       ON p.plan = t.plan
      WHERE t.id = $1`,
    [tenantId, DEFAULT_TZ]);
  return rows[0] || null;
}

async function loadSites(tenantId, siteId = null) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, name, address_line, city, region, country, timezone
       FROM sites WHERE tenant_id = $1${siteId ? ' AND id = $2' : ''} ORDER BY name, id LIMIT ${MAX_SITES}`,
    siteId ? [tenantId, siteId] : [tenantId]);
  return rows;
}

async function loadDevices(tenantId, siteId) {
  const { rows } = await db.query(
    `SELECT id, mqtt_device_id, tenant_id, name, location, serial_number, model, haccp_min, haccp_max, haccp_product, last_state
       FROM devices WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY name, mqtt_device_id LIMIT 50`,
    [siteId, tenantId]);
  return rows;
}

/** The zone the periods of a schedule are cut in. */
function scheduleTimezone(schedule, tenant, sites) {
  if (schedule.site_id && sites[0] && sites[0].timezone) return sites[0].timezone;
  return (tenant && tenant.timezone) || DEFAULT_TZ;
}

/** `<type>_<site>_<first day>_<last day>.pdf`, the days in the site's local time. */
function fileNameFor({ type, site, from, to, tz = DEFAULT_TZ }) {
  const name = String(site.name || 'site').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'site';
  const lastDay = new Date(new Date(to).getTime() - 1);
  return `${type}_${name}_${haccp.localFmt(from, tz, false)}_${haccp.localFmt(lastDay, tz, false)}.pdf`;
}

async function buildReport({ type, tenant, site, from, to, bucketKey, lang, scheduleId, now }) {
  const query = (sql, params) => db.query(sql, params);
  if (type === 'haccp') {
    const devices = await loadDevices(tenant.id, site.id);
    if (devices.length === 0) return { empty: true, source: 'raw' };
    return haccp.generate({
      query, kind: 'site', tenant, site, devices, channels: HACCP_CHANNELS, from, to, bucketKey: bucketKey || '1h', lang,
      rawRetentionDays: tenant.retention_days, generatedBy: 'schedule', scheduleId, now,
    });
  }
  return periodReports.generate({
    query, type, tenant, site, from, to, lang, rawRetentionDays: tenant.retention_days, generatedBy: 'schedule', scheduleId, now,
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [[]];
}

/**
 * Run one schedule for the period that ended most recently before `now`.
 * `force` regenerates and re-sends a period that already went out (the
 * "run now" button); otherwise a delivered period is skipped.
 */
async function runSchedule(schedule, { now = new Date(), force = false } = {}) {
  const tenant = await loadTenant(schedule.tenant_id);
  if (!tenant) return { status: 'error', error: 'tenant_missing', reports: [] };
  const sites = await loadSites(schedule.tenant_id, schedule.site_id);
  const tz = scheduleTimezone(schedule, tenant, sites);
  const period = periodFor(schedule.cadence, tz, now);
  const nextRunAt = nextRunAfter(schedule.cadence, tz, now);

  if (!force && schedule.last_period_to && new Date(schedule.last_period_to) >= period.to) {
    await db.query('UPDATE report_schedules SET next_run_at = $2, updated_at = now() WHERE id = $1', [schedule.id, nextRunAt]);
    return { status: 'skipped', period, tz, reports: [], emailed: false };
  }

  const errors = [];
  const results = [];
  const lang = schedule.lang || tenant.locale || 'uk';
  const featureOk = (await planMw.hasFeature(tenant.id, 'reports')) && (schedule.type !== 'energy' || await planMw.hasFeature(tenant.id, 'energy'));
  if (!featureOk) {
    errors.push('plan_feature');
  } else {
    for (const site of sites) {
      try {
        const r = await buildReport({ type: schedule.type, tenant, site, from: period.from, to: period.to, bucketKey: schedule.bucket, lang, scheduleId: schedule.id, now });
        const fileName = r.empty ? null : fileNameFor({ type: schedule.type, site, from: period.from, to: period.to, tz: site.timezone || tz });
        if (!r.empty) await haccp.archivePdf({ query: (sql, params) => db.query(sql, params), code: r.code, buffer: r.buffer, fileName });
        results.push({ site, ...r, fileName });
      } catch (err) {
        log().error({ err, scheduleId: schedule.id, siteId: site.id }, 'Scheduled report: generation failed');
        results.push({ site, error: err.message, empty: true });
        errors.push(`${site.name}: ${err.message}`);
      }
    }
  }

  const attachments = results.filter(r => r.buffer).map(r => ({ filename: r.fileName, content: r.buffer.toString('base64') }));
  let emailed = false;
  if (featureOk && sites.length > 0 && Array.isArray(schedule.recipients) && schedule.recipients.length > 0) {
    const parts = chunk(attachments, MAX_ATTACHMENTS);
    for (let i = 0; i < parts.length; i++) {
      try {
        const ok = await emailSvc.sendScheduledReport({
          to: schedule.recipients, lang, tenantName: tenant.name, type: schedule.type, cadence: schedule.cadence,
          periodFrom: period.from, periodTo: period.to, tz,
          sites: results.map(r => ({ name: r.site.name, code: r.code ? haccp.fmtCode(r.code) : null, empty: !!r.empty, error: !!r.error })),
          attachments: parts[i], part: i + 1, parts: parts.length, link: `${appBaseUrl()}/#/reports`,
        });
        emailed = emailed || ok === true;
      } catch (err) {
        log().error({ err, scheduleId: schedule.id }, 'Scheduled report: e-mail failed');
        errors.push(`email: ${err.message}`);
      }
    }
  }

  const status = errors.length ? 'error' : attachments.length ? 'ok' : 'empty';
  await db.query(
    `UPDATE report_schedules
        SET last_run_at = $2, last_period_to = $3, last_status = $4, last_error = $5, next_run_at = $6, updated_at = now()
      WHERE id = $1`,
    [schedule.id, now, period.to, status, errors.length ? errors.join('; ').slice(0, 1000) : null, nextRunAt]);
  log().info({ scheduleId: schedule.id, tenantId: tenant.id, type: schedule.type, status, reports: attachments.length, emailed }, 'Scheduled report run');
  return {
    status, period, tz, emailed, next_run_at: nextRunAt,
    reports: results.map(r => ({
      site_id: r.site.id, site: r.site.name, code: r.code ? haccp.fmtCode(r.code) : null,
      file_name: r.fileName || null, empty: !!r.empty, error: r.error || null, source: r.source || null,
    })),
  };
}

/** Enabled schedules whose send time has passed, in open organisations. */
async function listDue(now = new Date()) {
  const { rows } = await db.query(
    `SELECT s.* FROM report_schedules s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.enabled AND s.next_run_at <= $1 AND t.status = ANY($2)
      ORDER BY s.next_run_at LIMIT 500`,
    [now, OPEN_STATUSES]);
  return rows;
}

async function runDue({ now = new Date() } = {}) {
  const due = await listDue(now);
  const out = [];
  for (const s of due) {
    try {
      out.push({ id: s.id, ...(await runSchedule(s, { now })) });
    } catch (err) {
      log().error({ err, scheduleId: s.id }, 'Scheduled report failed');
      await db.query(
        `UPDATE report_schedules SET last_run_at = $2, last_status = 'error', last_error = $3, next_run_at = $4, updated_at = now() WHERE id = $1`,
        [s.id, now, String(err.message || err).slice(0, 1000), nextRunAfter(s.cadence, DEFAULT_TZ, now)]);
      out.push({ id: s.id, status: 'error', error: err.message });
    }
  }
  return out;
}

/** Drop archived PDFs older than REPORT_ARCHIVE_DAYS (metadata, code and hash stay). Resolves the rows touched. */
async function purgeArchive({ now = new Date() } = {}) {
  const days = envInt('REPORT_ARCHIVE_DAYS', 1095);
  if (days <= 0) return 0;
  const { rowCount } = await db.query(
    'UPDATE report_exports SET pdf = NULL WHERE pdf IS NOT NULL AND generated_at < $1',
    [new Date(now.getTime() - days * 86_400_000)]);
  return rowCount;
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const ran = await runDue();
    if (ran.length) log().info({ count: ran.length, errors: ran.filter(r => r.status === 'error').length }, 'Report scheduler: schedules run');
    const purged = await purgeArchive();
    if (purged) log().info({ purged }, 'Report scheduler: archived PDFs dropped');
  } catch (err) {
    log().error({ err }, 'Report scheduler failed');
  } finally {
    running = false;
  }
}

// ── Lifecycle ──────────────────────────────────────────────

function start(log_) {
  if (log_) logger = log_.child({ svc: 'reports' });
  const intervalMin = envInt('REPORT_SCHEDULE_INTERVAL_MIN', 60);
  if (intervalMin <= 0) { log().info('Report scheduler: disabled (REPORT_SCHEDULE_INTERVAL_MIN=0)'); return; }
  if (bootTimer || poller) return;
  const bootDelayMs = BOOT_DELAY_MS + Math.floor(Math.random() * BOOT_JITTER_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runOnce();
    poller = setInterval(runOnce, intervalMin * 60_000);
    if (poller.unref) poller.unref();
  }, bootDelayMs);
  if (bootTimer.unref) bootTimer.unref();
  log().info({ intervalMin, bootDelayMs, runHour: RUN_HOUR }, 'Report scheduler started');
}

/** Must stay in the index.js shutdown() list. */
function shutdown() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (poller)    { clearInterval(poller);   poller = null; }
}

module.exports = {
  TYPES, CADENCES, RUN_HOUR, DEFAULT_TZ, MAX_ATTACHMENTS,
  periodFor, nextRunAfter, scheduleTimezone, loadTenant, loadSites, fileNameFor,
  runSchedule, listDue, runDue, purgeArchive, runOnce, start, shutdown,
  __test: { setLogger(l) { logger = l; }, tzParts, zonedToUtc },
};
