'use strict';

/**
 * Webhooks (plan epic 2.6): the organisation's events, delivered to its
 * systems (a CMMS, an ERP, an automation) as signed HTTP POSTs.
 *
 * Events come off the MQTT service's emitter — the same source the WebSocket
 * and the notification channels listen to — and are mapped to public names:
 *   alarm.raised / alarm.cleared / alarm.acknowledged
 *   device.offline / device.online
 *   work_order.created / updated / assigned / started / closed / cancelled
 *   hint.opened
 * A hook subscribes to some of them (or to `*`). Each event becomes one
 * delivery row per hook; deliveries are attempted at once and retried with
 * backoff (1 min, 5 min, 30 min, 2 h, 12 h), then marked dead. Ten failed
 * attempts in a row switch the hook off; re-enabling resets the count.
 *
 * Every request carries `X-ModESP-Signature: v1=<hex>` — HMAC-SHA256 of
 * `<timestamp>.<body>` with the hook's secret — plus the event name, the
 * delivery id and the timestamp, so the receiver can verify and de-duplicate.
 * Targets must be public http(s) hosts; private and loopback addresses are
 * refused unless WEBHOOK_ALLOW_PRIVATE=true (LAN installs, tests).
 */

const crypto = require('crypto');
const dns    = require('dns').promises;
const net    = require('net');
const db     = require('./db');
const mqttSvc = require('./mqtt');
const { encryptSecret, decryptSecret } = require('./mfa');

const EVENTS = [
  'alarm.raised', 'alarm.cleared', 'alarm.acknowledged',
  'device.offline', 'device.online',
  'work_order.created', 'work_order.updated', 'work_order.assigned', 'work_order.started', 'work_order.closed', 'work_order.cancelled',
  'hint.opened',
  'ota.rollout_completed', 'ota.rollout_paused',
];
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];   // attempt 1..5 → next try; then dead
const MAX_ATTEMPTS = BACKOFF_MS.length;
const DISABLE_AFTER = 10;
const TIMEOUT_MS = 10_000;
const BATCH = 50;

let logger  = null;
let timer   = null;
let running = false;
let rerun = false;      // work arrived while a pass was running: run once more when it ends
let attached = false;

function log() { return logger || { info() {}, warn() {}, error() {}, debug() {} }; }
function envInt(name, fallback) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) ? n : fallback; }

// ── Target validation (SSRF guard) ────────────────────────

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

/** Throws with code `invalid_url` when the target is not a public http(s) host. */
async function assertPublicUrl(raw) {
  const fail = (m) => { const e = new Error(m); e.code = 'invalid_url'; throw e; };
  let u;
  try { u = new URL(raw); } catch { fail('Not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) fail('Only http and https targets are allowed');
  if (u.username || u.password) fail('Credentials in the URL are not allowed');
  if (process.env.WEBHOOK_ALLOW_PRIVATE === 'true') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) fail('Private hosts are not allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => fail('Host does not resolve'));
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) fail('Private or unroutable addresses are not allowed');
  return u;
}

// ── Signing / sending ─────────────────────────────────────

function sign(secret, timestamp, body) {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function post(url, secret, delivery) {
  const body = JSON.stringify(delivery.payload);
  const ts = Math.floor(Date.now() / 1000);
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST', body, signal: ctrl.signal, redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ModESP-Cloud-Webhooks/1',
        'X-ModESP-Event': delivery.event,
        'X-ModESP-Delivery': delivery.id,
        'X-ModESP-Timestamp': String(ts),
        'X-ModESP-Signature': sign(secret, ts, body),
      },
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: null, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err).slice(0, 200), ms: Date.now() - started };
  } finally {
    clearTimeout(kill);
  }
}

// ── Queue ─────────────────────────────────────────────────

function envelope(id, event, tenantId, data, now) {
  return { id, event, created_at: now.toISOString(), tenant_id: tenantId, data };
}

/** Queue `event` for every enabled hook of the organisation that listens to it. Resolves the delivery ids. */
async function enqueue(tenantId, event, data, { now = new Date() } = {}) {
  const { rows: hooks } = await db.query(
    `SELECT id FROM webhooks WHERE tenant_id = $1 AND enabled AND ($2 = ANY(events) OR '*' = ANY(events))`, [tenantId, event]);
  if (hooks.length === 0) return [];
  const ids = [];
  for (const h of hooks) {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, tenant_id, event, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, h.id, tenantId, event, JSON.stringify(envelope(id, event, tenantId, data, now)), now]);
    ids.push(id);
  }
  setImmediate(() => deliverDue().catch(err => log().error({ err }, 'Webhook delivery failed')));
  return ids;
}

async function recordAttempt(delivery, hook, result, now) {
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'ok', attempts = $2, status_code = $3, error = NULL, duration_ms = $4, delivered_at = $5 WHERE id = $1`,
      [delivery.id, attempts, result.status, result.ms, now]);
    await db.query(`UPDATE webhooks SET failures = 0, last_delivery_at = $2, last_status = $3 WHERE id = $1`, [hook.id, now, result.status]);
    return;
  }
  const dead = attempts >= MAX_ATTEMPTS;
  const next = dead ? null : new Date(now.getTime() + BACKOFF_MS[attempts - 1]);
  await db.query(
    `UPDATE webhook_deliveries SET status = $2, attempts = $3, status_code = $4, error = $5, duration_ms = $6, next_attempt_at = COALESCE($7, next_attempt_at) WHERE id = $1`,
    [delivery.id, dead ? 'dead' : 'pending', attempts, result.status, result.error, result.ms, next]);
  const { rows } = await db.query(
    `UPDATE webhooks SET failures = failures + 1, last_delivery_at = $2, last_status = $3 WHERE id = $1 RETURNING failures`, [hook.id, now, result.status]);
  if (rows[0] && rows[0].failures >= DISABLE_AFTER) {
    await db.query(`UPDATE webhooks SET enabled = false, disabled_at = $2, disabled_reason = 'failures' WHERE id = $1 AND enabled`, [hook.id, now]);
    log().warn({ webhookId: hook.id, tenantId: hook.tenant_id }, 'Webhook disabled after repeated failures');
  }
}

/** Send every pending delivery whose time has come. Resolves the number attempted. */
async function deliverDue({ now = new Date() } = {}) {
  // One pass at a time; a delivery queued while a pass runs is not lost — the
  // pass repeats once it is through (the timer alone would delay it by a whole
  // WEBHOOK_INTERVAL_SEC, or forever in tests that disable the timer).
  if (running) { rerun = true; return 0; }
  running = true;
  let total = 0;
  let at = now;
  try {
    do {
      rerun = false;
      const { rows } = await db.query(
        `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret, w.tenant_id, w.enabled
           FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
          WHERE d.status = 'pending' AND d.next_attempt_at <= $1
          ORDER BY d.next_attempt_at LIMIT ${BATCH}`, [at]);
      for (const d of rows) {
        const hook = { id: d.webhook_id, tenant_id: d.tenant_id, url: d.url, enabled: d.enabled };
        if (!hook.enabled) {
          await db.query(`UPDATE webhook_deliveries SET status = 'dead', error = 'webhook disabled' WHERE id = $1`, [d.id]);
          continue;
        }
        const result = await post(hook.url, decryptSecret(d.secret), { id: d.id, event: d.event, payload: d.payload });
        await recordAttempt(d, hook, result, at);
      }
      total += rows.length;
      at = new Date();
    } while (rerun);
    return total;
  } finally {
    running = false;
    rerun = false;
  }
}

/** Send a `ping` right now, outside the queue; resolves the attempt result. */
async function test(hook, { now = new Date() } = {}) {
  const id = crypto.randomUUID();
  const payload = envelope(id, 'ping', hook.tenant_id, { name: hook.name, events: hook.events }, now);
  const result = await post(hook.url, decryptSecret(hook.secret), { id, event: 'ping', payload });
  await db.query(`UPDATE webhooks SET last_delivery_at = $2, last_status = $3 WHERE id = $1`, [hook.id, now, result.status]);
  return result;
}

/** Queue a copy of a delivery (the same payload and id lineage) for another try. */
async function redeliver(deliveryId, tenantId, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT webhook_id, event, payload FROM webhook_deliveries WHERE id = $1 AND tenant_id = $2`, [deliveryId, tenantId]);
  if (!rows[0]) return null;
  const id = crypto.randomUUID();
  const payload = { ...rows[0].payload, id, redelivery_of: deliveryId };
  await db.query(
    `INSERT INTO webhook_deliveries (id, webhook_id, tenant_id, event, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, rows[0].webhook_id, tenantId, rows[0].event, JSON.stringify(payload), now]);
  setImmediate(() => deliverDue().catch(err => log().error({ err }, 'Webhook redelivery failed')));
  return id;
}

// ── Event mapping ─────────────────────────────────────────

async function deviceInfo(tenantId, mqttId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.site_id, s.name AS site_name FROM devices d LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.tenant_id = $1 AND d.mqtt_device_id = $2`, [tenantId, mqttId]);
  const d = rows[0];
  return { device_id: mqttId, device_uuid: d ? d.id : null, device_name: d ? d.name : null, site_id: d ? d.site_id : null, site_name: d ? d.site_name : null };
}

async function tenantIdFor(evt) {
  if (evt.tenantId) return evt.tenantId;
  if (!evt.tenantSlug || evt.tenantSlug === 'pending') return null;
  const { rows } = await db.query('SELECT id FROM tenants WHERE slug = $1', [evt.tenantSlug]);
  return rows[0] ? rows[0].id : null;
}

async function onAlarm(evt) {
  const tenantId = await tenantIdFor(evt);
  if (!tenantId) return;
  const data = { ...(await deviceInfo(tenantId, evt.deviceId)), alarm_id: evt.alarmId || null, alarm_code: evt.alarmCode, severity: evt.severity || null, active: !!evt.active };
  await enqueue(tenantId, evt.active ? 'alarm.raised' : 'alarm.cleared', data);
}

async function onAlarmAck(evt) {
  const tenantId = await tenantIdFor(evt);
  if (!tenantId) return;
  const data = { ...(await deviceInfo(tenantId, evt.deviceId)), alarm_id: evt.alarmId || null, alarm_code: evt.alarmCode || null, acknowledged_by: evt.userEmail || evt.acknowledgedBy || null, note: evt.note || null };
  await enqueue(tenantId, 'alarm.acknowledged', data);
}

async function onDeviceStatus(evt) {
  const tenantId = await tenantIdFor(evt);
  if (!tenantId) return;
  const data = { ...(await deviceInfo(tenantId, evt.deviceId)), online: !!evt.online, last_seen: evt.lastSeen || null };
  await enqueue(tenantId, evt.online ? 'device.online' : 'device.offline', data);
}

async function onWorkOrder(evt) {
  const tenantId = await tenantIdFor(evt);
  if (!tenantId) return;
  const action = String(evt.action || 'updated');
  const data = { ...(evt.deviceId ? await deviceInfo(tenantId, evt.deviceId) : {}), work_order_id: evt.orderId, status: evt.status || null, assigned_to: evt.assignedTo || null, action };
  await enqueue(tenantId, `work_order.${action}`, data);
}

async function onHint(evt) {
  if (!evt.active) return;
  const tenantId = await tenantIdFor(evt);
  if (!tenantId) return;
  const data = { ...(await deviceInfo(tenantId, evt.deviceId)), hint_id: evt.hintId, rule_key: evt.ruleKey, alarm_code: evt.alarmCode || null, severity: evt.severity || null, value: evt.value, threshold: evt.threshold, window_hours: evt.windowHours };
  await enqueue(tenantId, 'hint.opened', data);
}

/** A firmware rollout completed or paused itself (plan epic 2.8). */
async function onRollout(evt) {
  if (!evt.tenantId || !['completed', 'paused'].includes(evt.event)) return;
  await enqueue(evt.tenantId, `ota.rollout_${evt.event}`, {
    rollout_id: evt.rolloutId, firmware_version: evt.firmwareVersion || null,
    total: evt.total ?? 0, succeeded: evt.succeeded ?? 0, failed: evt.failed ?? 0,
    fail_pct: evt.failPct ?? 0, fail_threshold_pct: evt.threshold ?? null, paused_reason: evt.pausedReason || null,
  });
}

const guard = (fn) => (evt) => fn(evt).catch(err => log().error({ err, event: evt }, 'Webhook mapping failed'));

// ── Lifecycle ─────────────────────────────────────────────

function attach() {
  if (attached) return;
  attached = true;
  mqttSvc.on('alarm',         guard(onAlarm));
  mqttSvc.on('alarm_ack',     guard(onAlarmAck));
  mqttSvc.on('device_status', guard(onDeviceStatus));
  mqttSvc.on('work_order',    guard(onWorkOrder));
  mqttSvc.on('hint',          guard(onHint));
  mqttSvc.on('rollout',       guard(onRollout));
}

function start(log_) {
  if (log_) logger = log_.child({ svc: 'webhooks' });
  const sec = envInt('WEBHOOK_INTERVAL_SEC', 30);
  attach();
  if (sec <= 0) { log().info('Webhooks: retry timer disabled (WEBHOOK_INTERVAL_SEC=0)'); return; }
  if (timer) return;
  timer = setInterval(() => deliverDue().catch(err => log().error({ err }, 'Webhook delivery sweep failed')), sec * 1000);
  if (timer.unref) timer.unref();
  log().info({ intervalSec: sec }, 'Webhooks started');
}

function shutdown() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  EVENTS, MAX_ATTEMPTS, DISABLE_AFTER, BACKOFF_MS,
  assertPublicUrl, sign, enqueue, deliverDue, test, redeliver, start, shutdown, attach,
  encryptSecret, decryptSecret, generateSecret: () => crypto.randomBytes(32).toString('base64url'),
  __test: { setLogger(l) { logger = l; }, isPrivateIp, post },
};
