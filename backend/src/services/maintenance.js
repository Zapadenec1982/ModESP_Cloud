'use strict';

/**
 * Maintenance hints — "the same alarm keeps coming back" (plan epic 2.4,
 * ROADMAP phase 18).
 *
 * The controller decides what is a fault and raises the alarm; the cloud keeps
 * the history. What the cloud can add that the controller cannot is a look
 * back over that history: the same alarm raised on the same cabinet again and
 * again is a service call, not another acknowledgement. Once an hour
 * (MAINTENANCE_EVAL_INTERVAL_MIN, 0 disables) every organisation whose plan
 * carries the `maintenance` feature is evaluated against one rule:
 *
 *   alarm_repeat — the same alarm code raised on a device at least `threshold`
 *                  times within `window_hours` (platform default: 3 in 168 h).
 *                  `value` on the hint is the count inside the window.
 *
 * One open hint per (device, alarm code): opened when the count reaches the
 * line (WebSocket `hint`, notification to the organisation's administrators),
 * refreshed while it stays there, closed as `resolved` once the sliding window
 * holds fewer. Acknowledging keeps a hint open; dismissing closes it, and the
 * next sweep reopens it if the evidence is still there.
 *
 * `device_offline` is the platform's own connectivity alarm, not the
 * controller's, and is not counted.
 *
 * Rules resolve per device, most specific first: the organisation's row for
 * that device model → the organisation's row for any model → the platform
 * default for that model → the platform default. A disabled row at any level
 * switches the rule off for that scope; a switched-off rule leaves open hints
 * as they are (nothing is closed without evidence).
 */

const db      = require('./db');
const mqttSvc = require('./mqtt');
const pushSvc = require('./push');

const RULES = {
  alarm_repeat: { unit: 'count', source: 'alarms' },
};
const RULE_KEYS = Object.keys(RULES);
const DEFAULT_WINDOW_HOURS = 168;
/** Raised by the platform, not by the controller: never counted. */
const EXCLUDED_CODES = ['device_offline'];

const BOOT_DELAY_MS  = 90_000;
const BOOT_JITTER_MS = 60_000;

let logger    = null;
let bootTimer = null;
let poller    = null;
let running   = false;

function log() { return logger || { info() {}, warn() {}, error() {}, debug() {} }; }
function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Rule resolution ────────────────────────────────────────

async function loadRules() {
  const { rows } = await db.query(
    `SELECT id, tenant_id, rule_key, model, threshold::float AS threshold, window_hours, severity, enabled
       FROM maintenance_rules`
  );
  return rows;
}

/**
 * Pick the rule row that applies to one device, or null when the rule is
 * switched off for it. `rules` is the full table; small enough to scan.
 */
function resolveRule(rules, ruleKey, tenantId, model) {
  const pick = (scopeTenant, scopeModel) => rules.find(r =>
    r.rule_key === ruleKey &&
    (scopeTenant ? r.tenant_id === tenantId : r.tenant_id === null) &&
    (scopeModel ? (r.model !== null && model && r.model === model) : r.model === null));
  const row = pick(true, true) || pick(true, false) || pick(false, true) || pick(false, false) || null;
  return row && row.enabled ? row : null;
}

/** Effective rules of one organisation for the settings page. */
async function effectiveRules(tenantId) {
  const rules = await loadRules();
  return RULE_KEYS.map(key => {
    const global   = rules.find(r => r.rule_key === key && r.tenant_id === null && r.model === null) || null;
    const override = rules.find(r => r.rule_key === key && r.tenant_id === tenantId && r.model === null) || null;
    const models   = rules.filter(r => r.rule_key === key && r.tenant_id === tenantId && r.model !== null);
    const eff = override || global;
    return {
      rule_key: key, unit: RULES[key].unit,
      threshold: eff ? eff.threshold : null, window_hours: eff ? eff.window_hours : null,
      severity: eff ? eff.severity : 'info', enabled: eff ? eff.enabled : false,
      overridden: !!override,
      default: global ? { threshold: global.threshold, window_hours: global.window_hours, severity: global.severity, enabled: global.enabled } : null,
      model_overrides: models.map(m => ({ model: m.model, threshold: m.threshold, window_hours: m.window_hours, severity: m.severity, enabled: m.enabled })),
    };
  });
}

// ── Evidence ───────────────────────────────────────────────

/**
 * Every controller alarm of one organisation raised inside the longest window
 * any of its rules uses, grouped by device.
 * Returns Map<mqtt_device_id, { device, alarms: [{ alarm_code, triggered_at }] }>.
 */
async function collectAlarms(tenantId, now, maxWindowHours) {
  const from = new Date(now.getTime() - maxWindowHours * 3600e3);
  const { rows: devices } = await db.query(
    `SELECT id, mqtt_device_id, name, model FROM devices WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId]
  );
  const out = new Map();
  if (devices.length === 0) return out;

  const { rows } = await db.query(
    `SELECT device_id, alarm_code, triggered_at FROM alarms
      WHERE tenant_id = $1 AND triggered_at > $2 AND triggered_at <= $3
        AND NOT (alarm_code = ANY($4::text[]))
      ORDER BY device_id, alarm_code, triggered_at`,
    [tenantId, from, now, EXCLUDED_CODES]
  );
  const byDevice = new Map();
  for (const a of rows) {
    if (!byDevice.has(a.device_id)) byDevice.set(a.device_id, []);
    byDevice.get(a.device_id).push(a);
  }
  for (const d of devices) out.set(d.mqtt_device_id, { device: d, alarms: byDevice.get(d.mqtt_device_id) || [] });
  return out;
}

/** How many times each alarm code was raised after `from`. */
function countByCode(alarms, from) {
  const counts = new Map();
  for (const a of alarms) {
    if (a.triggered_at <= from) continue;
    counts.set(a.alarm_code, (counts.get(a.alarm_code) || 0) + 1);
  }
  return counts;
}

// ── Evaluation ─────────────────────────────────────────────

async function evaluateTenant(tenant, rules, now) {
  const tenantRules = rules.filter(r => r.tenant_id === null || r.tenant_id === tenant.id);
  if (tenantRules.length === 0) return { opened: 0, refreshed: 0, closed: 0, devices: 0 };
  const maxWindow = Math.max(...tenantRules.map(r => r.window_hours || DEFAULT_WINDOW_HOURS));
  const collected = await collectAlarms(tenant.id, now, maxWindow);

  const { rows: openRows } = await db.query(
    `SELECT id, device_id, rule_key, alarm_code FROM maintenance_hints
      WHERE tenant_id = $1 AND rule_key = 'alarm_repeat' AND closed_at IS NULL`,
    [tenant.id]
  );
  const open = new Map(openRows.map(h => [`${h.device_id}|${h.alarm_code || ''}`, h]));
  const result = { opened: 0, refreshed: 0, closed: 0, devices: collected.size };

  for (const [deviceId, { device, alarms }] of collected) {
    const rule = resolveRule(tenantRules, 'alarm_repeat', tenant.id, device.model);
    if (!rule) continue;
    const windowHours = rule.window_hours || DEFAULT_WINDOW_HOURS;
    const counts = countByCode(alarms, new Date(now.getTime() - windowHours * 3600e3));

    // Codes to look at: those raised in the window, plus those with an open hint
    // (their count may have dropped to nothing at all).
    const codes = new Set(counts.keys());
    for (const h of openRows) if (h.device_id === deviceId && h.alarm_code) codes.add(h.alarm_code);

    for (const code of codes) {
      const value    = counts.get(code) || 0;
      const existing = open.get(`${deviceId}|${code}`);
      const base = { tenantId: tenant.id, tenantSlug: tenant.slug, deviceId, deviceUuid: device.id,
                     ruleKey: 'alarm_repeat', alarmCode: code, severity: rule.severity,
                     value, threshold: rule.threshold, windowHours };

      if (value >= rule.threshold) {
        if (existing) {
          await db.query(`UPDATE maintenance_hints SET value = $2, threshold = $3, window_hours = $4, last_seen_at = $5 WHERE id = $1`,
            [existing.id, value, rule.threshold, windowHours, now]);
          result.refreshed++;
        } else {
          const { rows } = await db.query(
            `INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, alarm_code, rule_id, severity, value, threshold, window_hours, opened_at, last_seen_at)
             VALUES ($1, $2, 'alarm_repeat', $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
            [tenant.id, deviceId, code, rule.id, rule.severity, value, rule.threshold, windowHours, now]
          );
          result.opened++;
          const evt = { ...base, hintId: rows[0].id, active: true };
          mqttSvc.emit('hint', evt);
          // Awaited on purpose: the sweep is hourly and nothing waits on it, while
          // a notification still in flight after the sweep returns is a race for
          // whoever observes the sweep (tests, the on-demand endpoint).
          try { await pushSvc.notifyHint(evt); }
          catch (err) { log().error({ err, deviceId, code }, 'Hint notification failed'); }
        }
      } else if (existing) {
        await db.query(
          `UPDATE maintenance_hints SET closed_at = $2, closed_reason = 'resolved', value = $3 WHERE id = $1 AND closed_at IS NULL`,
          [existing.id, now, value]);
        result.closed++;
        mqttSvc.emit('hint', { ...base, hintId: existing.id, active: false });
      }
    }
  }
  return result;
}

/**
 * Evaluate every organisation whose plan includes the feature. Returns a
 * per-tenant report; never throws (one organisation's failure is logged and
 * the sweep goes on).
 */
async function evaluateAll({ now = new Date() } = {}) {
  const rules = await loadRules();
  const { rows: tenants } = await db.query(
    `SELECT t.id, t.slug FROM tenants t JOIN plan_limits p ON p.plan = t.plan
      WHERE t.id <> $1 AND t.status IN ('trial', 'active', 'past_due') AND p.features ? 'maintenance'`,
    [db.SYSTEM_TENANT_ID]
  );
  const report = {};
  for (const tenant of tenants) {
    try {
      report[tenant.slug] = await evaluateTenant(tenant, rules, now);
    } catch (err) {
      log().error({ err, tenant: tenant.slug }, 'Maintenance evaluation failed');
      report[tenant.slug] = { error: err.message };
    }
  }
  return report;
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const report = await evaluateAll();
    const sum = Object.values(report).reduce((a, r) => ({ opened: a.opened + (r.opened || 0), closed: a.closed + (r.closed || 0) }), { opened: 0, closed: 0 });
    log().info({ tenants: Object.keys(report).length, ...sum }, 'Maintenance hints evaluated');
  } catch (err) {
    log().error({ err }, 'Maintenance sweep failed');
  } finally {
    running = false;
  }
}

// ── Lifecycle ──────────────────────────────────────────────

function start(log_) {
  if (log_) logger = log_.child({ svc: 'maintenance' });
  const intervalMin = envInt('MAINTENANCE_EVAL_INTERVAL_MIN', 60);
  if (intervalMin <= 0) { log().info('Maintenance hints: disabled (MAINTENANCE_EVAL_INTERVAL_MIN=0)'); return; }
  if (bootTimer || poller) return;
  const bootDelayMs = BOOT_DELAY_MS + Math.floor(Math.random() * BOOT_JITTER_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runOnce();
    poller = setInterval(runOnce, intervalMin * 60_000);
    if (poller.unref) poller.unref();
  }, bootDelayMs);
  if (bootTimer.unref) bootTimer.unref();
  log().info({ intervalMin, bootDelayMs }, 'Maintenance hints evaluator started');
}

/** Must stay in the index.js shutdown() list. */
function shutdown() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (poller)    { clearInterval(poller);   poller = null; }
}

module.exports = {
  start, shutdown, evaluateAll, effectiveRules,
  RULES, RULE_KEYS, EXCLUDED_CODES,
  __test: { evaluateTenant, collectAlarms, countByCode, resolveRule, setLogger(l) { logger = l; } },
};
