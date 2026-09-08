'use strict';

/**
 * Organisation lifecycle sweep (plan epic 2.1).
 *
 * A trial ends when `trial_expires_at` passes: the organisation moves to
 * `past_due` — still open for login and for its devices, but with the banner
 * that asks its administrator to choose a plan — and every administrator gets
 * one e-mail. The superadmin decides what happens after that on the
 * Organisations page (a plan, `active`, or `closed`); the billing dunning of
 * plan epic 2.2 only ever suspends over an unpaid invoice, never over a trial.
 *
 * The sweep is its own hourly timer (TRIAL_SWEEP_INTERVAL_MIN, 0 disables) so
 * it keeps running on a server where the billing timer is switched off.
 *
 * It also ends closed organisations (plan epic 2.10): CLOSED_RETENTION_DAYS
 * after `closed_at` the operational data is purged and the controllers go
 * back to the pending queue — the organisation, its users and its invoices
 * stay — and data-export files past their TTL are removed.
 */

const db       = require('./db');
const emailSvc = require('./email');
const planMw   = require('../middleware/plan');
const tenantDelete = require('./tenant-delete');
const exportSvc    = require('./tenant-export');

const BOOT_DELAY_MS  = 60_000;
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

/** Move every trial whose end has passed to past_due; resolves the organisations moved. */
async function expireTrials({ now = new Date() } = {}) {
  const { rows } = await db.query(
    `UPDATE tenants SET status = 'past_due'
      WHERE status = 'trial' AND trial_expires_at IS NOT NULL AND trial_expires_at <= $1
      RETURNING id, name, slug, trial_expires_at`,
    [now]);
  if (rows.length === 0) return rows;

  for (const t of rows) planMw.invalidate(t.id);
  try { await require('./mqtt').refreshRegistries(); }
  catch (err) { log().warn({ err }, 'Broker registry refresh failed'); }

  const { adminRecipients } = require('./registration');
  for (const t of rows) {
    log().info({ tenantId: t.id, slug: t.slug }, 'Trial ended — organisation is past_due');
    for (const r of await adminRecipients(t.id)) {
      try {
        await emailSvc.sendTrialEnded({ ...r, link: `${appBaseUrl()}/#/billing` });
      } catch (err) {
        log().warn({ err, tenantId: t.id }, 'Trial-ended e-mail failed');
      }
    }
  }
  return rows;
}

function closedRetentionDays() { return envInt('CLOSED_RETENTION_DAYS', 30); }

/**
 * Purge every organisation closed longer than CLOSED_RETENTION_DAYS ago
 * (a negative value never purges). Resolves the organisations purged.
 */
async function purgeClosed({ now = new Date() } = {}) {
  const days = closedRetentionDays();
  if (days < 0) return [];
  const { rows } = await db.query(
    `SELECT id, name, slug FROM tenants
      WHERE status = 'closed' AND purged_at IS NULL AND closed_at IS NOT NULL
        AND closed_at <= $1::timestamptz - make_interval(days => $2) AND id <> $3
      ORDER BY closed_at`,
    [now, days, db.SYSTEM_TENANT_ID]);
  const done = [];
  for (const t of rows) {
    try {
      const r = await db.transaction(client => tenantDelete.purgeTenant(client, t.id, { now }));
      planMw.invalidate(t.id);
      const mqtt = require('./mqtt');
      for (const mqttId of r.devices) {
        // The controller may still sit on the old prefix: point it at the queue
        try { mqtt.sendCommand(t.slug, mqttId, '_set_tenant', 'pending', { qos: 1 }); } catch { /* broker offline */ }
      }
      log().info({ tenantId: t.id, slug: t.slug, counts: r.counts, devices: r.movedDevices }, 'Closed organisation purged');
      done.push({ ...t, counts: r.counts, devices: r.devices });
    } catch (err) {
      log().error({ err, tenantId: t.id }, 'Purge of a closed organisation failed');
    }
  }
  if (done.length) {
    try { await require('./mqtt').refreshRegistries(); }
    catch (err) { log().warn({ err }, 'Broker registry refresh failed'); }
  }
  return done;
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const moved = await expireTrials();
    if (moved.length) log().info({ count: moved.length }, 'Trial sweep: organisations moved to past_due');
  } catch (err) {
    log().error({ err }, 'Trial sweep failed');
  }
  try {
    const purged = await purgeClosed();
    if (purged.length) log().info({ count: purged.length }, 'Lifecycle: closed organisations purged');
  } catch (err) {
    log().error({ err }, 'Purge sweep failed');
  }
  try {
    const expired = await exportSvc.expire();
    if (expired) log().info({ count: expired }, 'Lifecycle: data exports expired');
  } catch (err) {
    log().error({ err }, 'Export expiry failed');
  }
  running = false;
}

// ── Lifecycle ──────────────────────────────────────────────

function start(log_) {
  if (log_) logger = log_.child({ svc: 'lifecycle' });
  const intervalMin = envInt('TRIAL_SWEEP_INTERVAL_MIN', 60);
  if (intervalMin <= 0) { log().info('Trial sweep: disabled (TRIAL_SWEEP_INTERVAL_MIN=0)'); return; }
  if (bootTimer || poller) return;
  const bootDelayMs = BOOT_DELAY_MS + Math.floor(Math.random() * BOOT_JITTER_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runOnce();
    poller = setInterval(runOnce, intervalMin * 60_000);
    if (poller.unref) poller.unref();
  }, bootDelayMs);
  if (bootTimer.unref) bootTimer.unref();
  log().info({ intervalMin, bootDelayMs }, 'Trial sweep started');
}

/** Must stay in the index.js shutdown() list. */
function shutdown() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (poller)    { clearInterval(poller);   poller = null; }
}

module.exports = { start, shutdown, runOnce, expireTrials, purgeClosed, closedRetentionDays, __test: { setLogger(l) { logger = l; } } };
