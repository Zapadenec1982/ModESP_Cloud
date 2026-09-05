'use strict';

/**
 * Maintenance hints — repair-prevention rules (plan epic 2.4, ROADMAP phase 18).
 *
 * Once an hour (MAINTENANCE_EVAL_INTERVAL_MIN, 0 disables) every organisation
 * whose plan carries the `maintenance` feature is evaluated against five rules.
 * Each rule reads what the platform already stores — compressor / door events,
 * the `cond` telemetry channel, the controller's live defrost counters — and
 * compares a metric with a line (maintenance_rules). Over the line: one open
 * hint per (device, rule) is opened (or refreshed); back under: the hint is
 * closed as `resolved`. Acknowledging keeps a hint open; dismissing closes it.
 *
 * Rules are resolved per device, most specific first: the organisation's row
 * for that device model → the organisation's row for any model → the platform
 * default for that model → the platform default. A disabled row at any level
 * switches the rule off for that scope.
 *
 * Offline devices and devices without enough data are skipped entirely — an
 * open hint is never closed on silence, only on evidence.
 *
 * Metrics (window_hours = W, default 24):
 *   compressor_starts  compressor_on events in W / W            starts per hour
 *   compressor_duty    time compressor ON in W / W × 100         percent
 *   defrost_timeouts   defrost.consecutive_timeouts (live state)  count
 *   door_openings      door_open events in W                      count
 *   cond_temp          avg(telemetry.cond) in W, ≥ 12 samples     °C
 */

const db      = require('./db');
const mqttSvc = require('./mqtt');
const pushSvc = require('./push');

const RULES = {
  compressor_starts: { unit: 'starts/h', source: 'events'    },
  compressor_duty:   { unit: '%',        source: 'events'    },
  defrost_timeouts:  { unit: 'count',    source: 'state'     },
  door_openings:     { unit: 'count',    source: 'events'    },
  cond_temp:         { unit: '°C',       source: 'telemetry' },
};
const RULE_KEYS = Object.keys(RULES);
const MIN_COND_SAMPLES = 12;

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

// ── Metrics ────────────────────────────────────────────────

/**
 * Share of [from, to] the compressor spent ON, from compressor_on/off events
 * inside the window plus the last known state before it. Returns null when
 * nothing is known about the device at all.
 */
function dutyPercent(events, priorOn, from, to) {
  if (priorOn === null && events.length === 0) return null;
  let on = priorOn === true;
  let cursor = from.getTime();
  let onMs = 0;
  for (const e of events) {
    const t = Math.min(Math.max(e.time.getTime(), from.getTime()), to.getTime());
    if (on) onMs += t - cursor;
    cursor = t;
    on = e.event_type === 'compressor_on';
  }
  if (on) onMs += to.getTime() - cursor;
  const total = to.getTime() - from.getTime();
  return total > 0 ? (onMs / total) * 100 : null;
}

/**
 * Compute every metric for every active device of one organisation.
 * Returns Map<mqtt_device_id, { device, metrics: { [ruleKey]: number|null } }>.
 * A metric is null when the device is offline or there is no evidence.
 */
async function collectMetrics(tenantId, now, maxWindowHours) {
  const from = new Date(now.getTime() - maxWindowHours * 3600e3);
  const { rows: devices } = await db.query(
    `SELECT id, mqtt_device_id, name, model, online, last_state
       FROM devices WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId]
  );
  const out = new Map();
  if (devices.length === 0) return out;

  const [{ rows: evRows }, { rows: priorRows }, { rows: condRows }] = await Promise.all([
    db.query(
      `SELECT device_id, event_type, time FROM events
        WHERE tenant_id = $1 AND time > $2 AND time <= $3
          AND event_type IN ('compressor_on', 'compressor_off', 'door_open')
        ORDER BY device_id, time`,
      [tenantId, from, now]
    ),
    db.query(
      `SELECT DISTINCT ON (device_id) device_id, event_type FROM events
        WHERE tenant_id = $1 AND time <= $2 AND event_type IN ('compressor_on', 'compressor_off')
        ORDER BY device_id, time DESC`,
      [tenantId, from]
    ),
    db.query(
      `SELECT device_id, avg(value)::float AS v, count(*)::int AS n FROM telemetry
        WHERE tenant_id = $1 AND channel = 'cond' AND time > $2 AND time <= $3
        GROUP BY device_id`,
      [tenantId, from, now]
    ),
  ]);

  const byDevice = new Map();
  for (const e of evRows) {
    if (!byDevice.has(e.device_id)) byDevice.set(e.device_id, []);
    byDevice.get(e.device_id).push(e);
  }
  const prior = new Map(priorRows.map(r => [r.device_id, r.event_type === 'compressor_on']));
  const cond  = new Map(condRows.map(r => [r.device_id, r]));

  for (const d of devices) {
    const meta   = mqttSvc.getDeviceMeta(d.mqtt_device_id);
    const online = meta ? !!meta.online : !!d.online;
    const live   = mqttSvc.getDeviceState(d.mqtt_device_id) || d.last_state || {};
    const metrics = { compressor_starts: null, compressor_duty: null, defrost_timeouts: null, door_openings: null, cond_temp: null };

    if (online) {
      const evs = byDevice.get(d.mqtt_device_id) || [];
      metrics.compressor_starts = evs.filter(e => e.event_type === 'compressor_on').length / maxWindowHours;
      metrics.door_openings     = evs.filter(e => e.event_type === 'door_open').length;
      const comp = evs.filter(e => e.event_type !== 'door_open');
      metrics.compressor_duty   = dutyPercent(comp, prior.has(d.mqtt_device_id) ? prior.get(d.mqtt_device_id) : null, from, now);
      const t = Number(live['defrost.consecutive_timeouts']);
      metrics.defrost_timeouts  = Number.isFinite(t) ? t : null;
      const c = cond.get(d.mqtt_device_id);
      metrics.cond_temp         = c && c.n >= MIN_COND_SAMPLES ? c.v : null;
    }
    out.set(d.mqtt_device_id, { device: d, metrics, windowHours: maxWindowHours });
  }
  return out;
}

// ── Evaluation ─────────────────────────────────────────────

async function evaluateTenant(tenant, rules, now) {
  const tenantRules = rules.filter(r => r.tenant_id === null || r.tenant_id === tenant.id);
  if (tenantRules.length === 0) return { opened: 0, refreshed: 0, closed: 0, devices: 0 };
  const maxWindow = Math.max(...tenantRules.map(r => r.window_hours || 24));
  const collected = await collectMetrics(tenant.id, now, maxWindow);

  const { rows: openRows } = await db.query(
    `SELECT id, device_id, rule_key FROM maintenance_hints WHERE tenant_id = $1 AND closed_at IS NULL`,
    [tenant.id]
  );
  const open = new Map(openRows.map(h => [`${h.device_id}|${h.rule_key}`, h]));
  const result = { opened: 0, refreshed: 0, closed: 0, devices: collected.size };

  for (const [deviceId, { device, metrics }] of collected) {
    for (const key of RULE_KEYS) {
      const rule = resolveRule(tenantRules, key, tenant.id, device.model);
      const raw  = metrics[key];
      if (!rule || raw === null || raw === undefined) continue;   // no evidence → leave as is

      // The metric was collected over the longest window; scale rate-type
      // metrics to this rule's own window where that differs.
      let value = raw;
      if (key === 'door_openings' && rule.window_hours !== maxWindow) value = raw * (rule.window_hours / maxWindow);
      value = Math.round(value * 100) / 100;

      const k = `${deviceId}|${key}`;
      const existing = open.get(k);
      if (value > rule.threshold) {
        if (existing) {
          await db.query(`UPDATE maintenance_hints SET value = $2, threshold = $3, last_seen_at = $4 WHERE id = $1`,
            [existing.id, value, rule.threshold, now]);
          result.refreshed++;
        } else {
          const { rows } = await db.query(
            `INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, rule_id, severity, value, threshold, window_hours, opened_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
            [tenant.id, deviceId, key, rule.id, rule.severity, value, rule.threshold, rule.window_hours, now]
          );
          result.opened++;
          const evt = { tenantId: tenant.id, tenantSlug: tenant.slug, deviceId, deviceUuid: device.id, hintId: rows[0].id,
                        ruleKey: key, severity: rule.severity, value, threshold: rule.threshold, windowHours: rule.window_hours, active: true };
          mqttSvc.emit('hint', evt);
          // Awaited on purpose: the sweep is hourly and nothing waits on it, while
          // a notification still in flight after the sweep returns is a race for
          // whoever observes the sweep (tests, the on-demand endpoint).
          try { await pushSvc.notifyHint(evt); }
          catch (err) { log().error({ err, deviceId, key }, 'Hint notification failed'); }
        }
      } else if (existing) {
        await db.query(
          `UPDATE maintenance_hints SET closed_at = $2, closed_reason = 'resolved', value = $3 WHERE id = $1 AND closed_at IS NULL`,
          [existing.id, now, value]);
        result.closed++;
        mqttSvc.emit('hint', { tenantId: tenant.id, tenantSlug: tenant.slug, deviceId, deviceUuid: device.id, hintId: existing.id,
                               ruleKey: key, severity: rule.severity, value, threshold: rule.threshold, active: false });
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
  RULES, RULE_KEYS,
  __test: { evaluateTenant, collectMetrics, resolveRule, dutyPercent, setLogger(l) { logger = l; } },
};
