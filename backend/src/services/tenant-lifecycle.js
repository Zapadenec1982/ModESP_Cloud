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
 */

const db       = require('./db');
const emailSvc = require('./email');
const planMw   = require('../middleware/plan');

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

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const moved = await expireTrials();
    if (moved.length) log().info({ count: moved.length }, 'Trial sweep: organisations moved to past_due');
  } catch (err) {
    log().error({ err }, 'Trial sweep failed');
  } finally {
    running = false;
  }
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

module.exports = { start, shutdown, runOnce, expireTrials, __test: { setLogger(l) { logger = l; } } };
