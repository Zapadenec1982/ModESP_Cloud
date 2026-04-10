'use strict';

const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const db       = require('./db');
const mqttAuth = require('./mqtt-auth');

const emitter = new EventEmitter();

// ── Config ────────────────────────────────────────────────
const TELEMETRY_INTERVAL = parseInt(process.env.TELEMETRY_INTERVAL_MS, 10) || 300000;
const OFFLINE_THRESHOLD  = parseInt(process.env.OFFLINE_THRESHOLD_MS, 10)  || 90000;
const STATE_DEBOUNCE     = parseInt(process.env.STATE_DEBOUNCE_MS, 10)     || 30000;
const REGISTRY_REFRESH   = parseInt(process.env.REGISTRY_REFRESH_MS, 10)   || 60000;
const STATE_CHECK_MS     = 5000;    // check dirty devices every 5 s
const OFFLINE_CHECK_MS   = 30000;   // scan for offline devices every 30 s

// Pre-computed bcrypt hash of shared bootstrap password (from env)
// All ESP32 devices are flashed with this password; replaced with unique on assign
let BOOTSTRAP_HASH = null;

// Telemetry channels to sample from stateMap
const TELEMETRY_CHANNELS = [
  { key: 'equipment.air_temp',  channel: 'air' },
  { key: 'equipment.evap_temp', channel: 'evap' },
  { key: 'equipment.cond_temp', channel: 'cond' },
  { key: 'thermostat.effective_setpoint', channel: 'setpoint' },
  { key: 'equipment.compressor', channel: 'comp',    bool: true },
  { key: 'defrost.active',      channel: 'defrost',  bool: true },
];

// Alarm keys: protection.*_alarm (bool)
const ALARM_KEYS = new Set([
  'protection.high_temp_alarm',
  'protection.low_temp_alarm',
  'protection.sensor1_alarm',
  'protection.sensor2_alarm',
  'protection.door_alarm',
  'protection.short_cycle_alarm',
  'protection.rapid_cycle_alarm',
  'protection.continuous_run_alarm',
  'protection.pulldown_alarm',
  'protection.rate_alarm',
]);

// Event-transition keys
const EVENT_KEYS = {
  'equipment.compressor': { on: 'compressor_on', off: 'compressor_off' },
  'defrost.active':       { on: 'defrost_start', off: 'defrost_end' },
};

// ── In-memory registries ──────────────────────────────────
/** @type {Map<string, {id: string, active: boolean}>}  slug → tenant */
const tenantRegistry = new Map();
/** @type {Map<string, {id: string, tenantId: string, status: string}>}  mqttDeviceId → device */
const deviceRegistry = new Map();
/**
 * stateMap: mqttDeviceId → object with metadata + state keys
 * Metadata keys prefixed with _ :
 *   _tenantId, _tenantSlug, _lastSeen, _online, _dirty, _lastDbWrite
 * @type {Map<string, Object>}
 */
const stateMap = new Map();

/** @type {Map<string, number>}  mqttDeviceId → timestamp of last assign/reassign */
const recentAssigns = new Map();

/** @type {Map<string, {compressor_kw:number, evap_fan_kw:number, cond_fan_kw:number, defrost_heater_kw:number, standby_kw:number}>} */
const powerProfiles = new Map();
const ASSIGN_GRACE_MS = 120_000; // 2 minutes grace before auto-reset

let client = null;
let logger = null;
let timers = [];
let connected = false;
let startupTime = 0;
const STARTUP_GRACE_MS = 120_000; // 2 min — ignore stuck detection while receiving retained messages

// ── Public API ────────────────────────────────────────────

/**
 * Start the MQTT service.
 * @param {import('pino').Logger} log
 */
async function start(log) {
  logger = log;
  startupTime = Date.now();

  // Pre-hash bootstrap password at startup (one-time cost)
  const bootstrapPass = process.env.MQTT_BOOTSTRAP_PASSWORD;
  if (bootstrapPass) {
    const bcrypt = require('bcrypt');
    BOOTSTRAP_HASH = await bcrypt.hash(bootstrapPass, 12);
    logger.info('MQTT bootstrap password hash computed');

    // Populate mqtt_bootstrap table for go-auth fallback
    await db.query(
      `INSERT INTO mqtt_bootstrap (id, password_hash) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET password_hash = $1`,
      [BOOTSTRAP_HASH]
    );
    logger.info('mqtt_bootstrap table populated for go-auth fallback');
  } else {
    logger.warn('MQTT_BOOTSTRAP_PASSWORD not set — new devices will not get bootstrap credentials');
  }

  await loadRegistries();
  await bootstrapStateMap();

  const url  = process.env.MQTT_URL  || 'mqtt://localhost:1883';
  const user = process.env.MQTT_USER || '';
  const pass = process.env.MQTT_PASS || '';

  client = mqtt.connect(url, {
    username: user || undefined,
    password: pass || undefined,
    clientId: `modesp-cloud-${process.pid}`,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on('connect', onConnect);
  client.on('message', onMessage);
  client.on('error', (err) => {
    logger.error({ err }, 'MQTT client error');
  });
  client.on('close', () => {
    connected = false;
    logger.warn('MQTT disconnected');
  });

  // ── Periodic timers ──
  timers.push(setInterval(telemetrySampler,       TELEMETRY_INTERVAL));
  timers.push(setInterval(stateWriter,            STATE_CHECK_MS));
  timers.push(setInterval(offlineDetector,        OFFLINE_CHECK_MS));
  timers.push(setInterval(refreshRegistries,      REGISTRY_REFRESH));
  timers.push(setInterval(flushEvents,            1000));       // batch events every 1s
  timers.push(setInterval(stateMapMonitor,        60000));      // log stateMap stats every 60s
  timers.push(setInterval(softDeleteCleanup,      3_600_000));  // purge soft-deleted devices every hour
  timers.push(setInterval(checkMissingDevices,    300_000));    // auto-recover missing devices every 5 min
}

function isConnected() { return connected; }

async function shutdown() {
  for (const t of timers) clearInterval(t);
  timers = [];

  // Clear pending nuisance alarm timers
  for (const timer of pendingAlarms.values()) clearTimeout(timer);
  pendingAlarms.clear();

  // Flush remaining buffered events before closing
  if (eventBuffer.length > 0) {
    logger.info({ count: eventBuffer.length }, 'Flushing event buffer on shutdown');
    await flushEvents().catch(err => logger.error({ err }, 'Failed to flush events on shutdown'));
  }

  if (client) {
    logger.info('Closing MQTT connection');
    client.end(true);
    client = null;
    connected = false;
  }
}

// ── MQTT callbacks ────────────────────────────────────────

function onConnect() {
  connected = true;
  logger.info('MQTT connected');

  // v1 subscriptions
  client.subscribe('modesp/v1/+/+/state/+');
  client.subscribe('modesp/v1/+/+/status');
  client.subscribe('modesp/v1/+/+/heartbeat');
  client.subscribe('modesp/v1/+/+/backfill');
  client.subscribe('modesp/v1/+/+/backfill/events');
  client.subscribe('modesp/v1/+/+/backfill/done');

  // Legacy
  client.subscribe('modesp/+/state/+');
  client.subscribe('modesp/+/status');

  logger.info('Subscribed to MQTT topics');
}

function onMessage(topic, payload, packet) {
  try {
    const msg = payload.toString().trim();
    const parsed = parseTopic(topic);
    if (!parsed) return;

    const { tenantSlug, deviceId, subtopic, stateKey } = parsed;
    const isRetained = packet && packet.retain;

    switch (subtopic) {
      case 'state':
        if (stateKey) handleStateKey(tenantSlug, deviceId, stateKey, msg, isRetained);
        break;
      case 'status':
        handleStatus(tenantSlug, deviceId, msg, isRetained);
        break;
      case 'heartbeat':
        handleHeartbeat(tenantSlug, deviceId, msg, isRetained);
        break;
      case 'backfill':
        if (stateKey === 'events') handleBackfillEvents(tenantSlug, deviceId, msg);
        else if (stateKey === 'done') handleBackfillDone(tenantSlug, deviceId);
        else handleBackfill(tenantSlug, deviceId, msg);
        break;
      default:
        // cmd and unknown — ignore on cloud side
        break;
    }
  } catch (err) {
    logger.error({ err, topic: topic.toString() }, 'Failed to process MQTT message');
  }
}

// ── Topic parsing ─────────────────────────────────────────

/**
 * Parse MQTT topic into structured parts.
 * v1:     modesp/v1/{tenant}/{device}/{subtopic}[/{key}]
 * legacy: modesp/{device}/{subtopic}/{key}
 * @returns {{ tenantSlug: string, deviceId: string, subtopic: string, stateKey?: string } | null}
 */
function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts[0] !== 'modesp') return null;

  if (parts[1] === 'v1') {
    // v1: modesp / v1 / {tenant} / {device} / {subtopic} [/ {key}]
    if (parts.length < 5) return null;
    return {
      tenantSlug: parts[2],
      deviceId:   parts[3],
      subtopic:   parts[4],
      stateKey:   parts[5] || undefined,
    };
  }

  // legacy: modesp / {device} / {subtopic} [/ {key}]
  if (parts.length < 3) return null;
  return {
    tenantSlug: 'pending',       // legacy devices have no tenant
    deviceId:   parts[1],
    subtopic:   parts[2],
    stateKey:   parts[3] || undefined,
  };
}

/**
 * Parse scalar payload string to typed value.
 * "-2.50" → -2.5,  "true" → true,  "false" → false,  "cooling" → "cooling"
 */
function parseScalar(payload) {
  if (payload === 'true')  return true;
  if (payload === 'false') return false;
  const num = Number(payload);
  if (payload !== '' && !isNaN(num)) return num;
  return payload;  // string
}

// ── Handlers ──────────────────────────────────────────────

async function handleStateKey(tenantSlug, deviceId, key, rawPayload, isRetained) {
  const value = parseScalar(rawPayload);
  const now   = Date.now();

  // Skip retained messages for unknown devices (prevents phantom devices after deletion)
  if (isRetained && !stateMap.has(deviceId) && !deviceRegistry.has(deviceId)) return;

  // Ensure stateMap entry exists
  let state = stateMap.get(deviceId);
  if (!state) {
    const tenantInfo = resolveTenant(tenantSlug);
    state = {
      _tenantId:    tenantInfo.id,
      _tenantSlug:  tenantSlug,
      _lastSeen:    now,
      _online:      true,
      _dirty:       true,
      _lastDbWrite: 0,
    };
    stateMap.set(deviceId, state);
  }

  // Always sync observed tenant slug + UUID with actual MQTT topic
  // (device may still publish as "pending" even though DB says "cocacola")
  if (state._tenantSlug !== tenantSlug) {
    logger.info({ deviceId, from: state._tenantSlug, to: tenantSlug }, 'Tenant slug updated from MQTT');
    state._tenantSlug = tenantSlug;
    const tenantInfo = resolveTenant(tenantSlug);
    state._tenantId = tenantInfo.id;
  }

  // Detect alarm transitions BEFORE updating state
  if (ALARM_KEYS.has(key)) {
    const prev = state[key];
    if (prev !== undefined && prev !== value) {
      await detectAlarm(tenantSlug, deviceId, key, value, state);
    } else if (prev === undefined && value === false) {
      // After backend restart, stateMap is empty. If device reports alarm=false
      // but DB still has active=true, reconcile by clearing stale alarms.
      const tenantInfo = resolveTenant(tenantSlug);
      const alarmCode = key.replace('protection.', '');
      const { rowCount } = await db.query(
        `UPDATE alarms SET active = false, cleared_at = NOW()
         WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = $3 AND active = true`,
        [tenantInfo.id, deviceId, alarmCode]
      ).catch(err => { logger.error({ err, deviceId, alarmCode }, 'Failed to reconcile alarm'); return { rowCount: 0 }; });
      if (rowCount > 0) {
        logger.info({ deviceId, alarmCode }, 'Reconciled stale alarm after restart');
        emitter.emit('alarm', { tenantSlug, deviceId, alarmCode, active: false, severity: alarmSeverity(alarmCode) });
      }
    }
  }

  // Detect event transitions (compressor, defrost)
  if (key in EVENT_KEYS) {
    const prev = state[key];
    if (prev !== undefined && prev !== value) {
      detectEvent(tenantSlug, deviceId, key, value, state);
    }
  }

  // Reject internal metadata keys — prevent state injection and prototype pollution
  if (key.startsWith('_') || key === '__proto__' || key === 'constructor') {
    logger.warn({ deviceId, key }, 'Rejected dangerous state key');
    return;
  }

  // Update state
  state[key]       = value;
  state._lastSeen  = now;
  state._online    = true;
  state._dirty     = true;

  // Emit delta for WebSocket broadcast
  emitter.emit('state_delta', { tenantSlug, deviceId, changes: { [key]: value } });

  // Ensure device exists in registry (auto-discovery for unknown devices)
  // Skip for retained messages — prevents re-creating deleted devices on restart
  if (!isRetained) ensureDevice(tenantSlug, deviceId);

  // Detect stuck devices (active in DB but publishing as pending)
  checkStuckDevice(tenantSlug, deviceId);
}

function handleStatus(tenantSlug, deviceId, payload, isRetained) {
  const online = (payload === 'online');
  const now    = Date.now();

  // Skip retained messages for unknown devices
  if (isRetained && !stateMap.has(deviceId) && !deviceRegistry.has(deviceId)) return;

  let state = stateMap.get(deviceId);
  if (!state) {
    const tenantInfo = resolveTenant(tenantSlug);
    state = {
      _tenantId:    tenantInfo.id,
      _tenantSlug:  tenantSlug,
      _lastSeen:    now,
      _online:      online,
      _dirty:       true,
      _lastDbWrite: 0,
    };
    stateMap.set(deviceId, state);
  } else {
    state._online   = online;
    state._lastSeen = now;
    state._dirty    = true;
  }

  // Always sync observed tenant slug + UUID with actual MQTT topic
  if (state._tenantSlug !== tenantSlug) {
    logger.info({ deviceId, from: state._tenantSlug, to: tenantSlug }, 'Tenant slug updated from MQTT');
    state._tenantSlug = tenantSlug;
    const resolved = resolveTenant(tenantSlug);
    state._tenantId = resolved.id;
  }

  // Update DB immediately for status changes
  const tenantInfo = resolveTenant(tenantSlug);
  db.query(
    `UPDATE devices SET online = $1, last_seen = NOW()
     WHERE tenant_id = $2 AND mqtt_device_id = $3`,
    [online, tenantInfo.id, deviceId]
  ).catch(err => logger.error({ err, deviceId }, 'Failed to update device status'));

  // Log event
  if (online) {
    insertEvent(tenantInfo.id, deviceId, 'device_online');
  } else {
    insertEvent(tenantInfo.id, deviceId, 'device_offline');
  }

  // Auto-discovery — skip for retained messages
  if (!isRetained) ensureDevice(tenantSlug, deviceId);

  // Detect stuck devices (active in DB but publishing as pending)
  checkStuckDevice(tenantSlug, deviceId);

  // Emit for WebSocket broadcast
  emitter.emit('device_status', {
    tenantSlug, deviceId, online,
    lastSeen: new Date().toISOString(),
  });

  logger.info({ tenantSlug, deviceId, online }, 'Device status');
}

function handleHeartbeat(tenantSlug, deviceId, rawPayload, isRetained) {
  const now = Date.now();

  // Skip retained messages for unknown devices
  if (isRetained && !stateMap.has(deviceId) && !deviceRegistry.has(deviceId)) return;

  let state = stateMap.get(deviceId);
  if (!state) {
    const tenantInfo = resolveTenant(tenantSlug);
    state = {
      _tenantId:    tenantInfo.id,
      _tenantSlug:  tenantSlug,
      _lastSeen:    now,
      _online:      true,
      _dirty:       true,
      _lastDbWrite: 0,
    };
    stateMap.set(deviceId, state);
  }
  state._lastSeen = now;
  state._online   = true;

  // Always sync observed tenant slug with actual MQTT topic
  if (state._tenantSlug !== tenantSlug) {
    logger.info({ deviceId, from: state._tenantSlug, to: tenantSlug }, 'Tenant slug updated from MQTT');
    state._tenantSlug = tenantSlug;
  }

  // Guard: skip empty/non-JSON payloads (e.g. truncated messages during disconnect)
  if (!rawPayload || rawPayload.length < 2 || rawPayload[0] !== '{') return;

  try {
    const hb = JSON.parse(rawPayload);
    // Only update firmware_version in DB when it changes (dedup ~167 writes/sec at 5000 devices)
    if (hb.fw && state._lastFw !== hb.fw) {
      state._lastFw = hb.fw;
      const tenantInfo = resolveTenant(tenantSlug);
      db.query(
        `UPDATE devices SET firmware_version = $1, last_seen = NOW()
         WHERE tenant_id = $2 AND mqtt_device_id = $3`,
        [hb.fw, tenantInfo.id, deviceId]
      ).catch(err => logger.error({ err, deviceId }, 'Failed to update firmware version'));
    }
    logger.debug({ deviceId, fw: hb.fw, up: hb.up, heap: hb.heap, rssi: hb.rssi }, 'Heartbeat');
  } catch (err) {
    logger.warn({ err, deviceId }, 'Failed to parse heartbeat JSON');
  }
}

// ── Backfill handlers ─────────────────────────────────────

const backfillCounters = new Map(); // deviceId → { count, reset }
const BACKFILL_RATE_LIMIT = 100;    // max messages per minute per device
const MIN_EPOCH = 1700000000;       // ~2023-11-14, filter out uptime-based timestamps
const MAX_BACKFILL_AGE = 90 * 86400; // 90 days

function resolveBackfillTenant(tenantSlug, deviceId) {
  // Prefer real tenant from stateMap (device may publish via 'pending' topic)
  const state = stateMap.get(deviceId);
  if (state && state._tenantId && state._tenantId !== db.SYSTEM_TENANT_ID) {
    return { id: state._tenantId, active: true };
  }
  return resolveTenant(tenantSlug);
}

function handleBackfill(tenantSlug, deviceId, rawPayload) {
  const tenantInfo = resolveBackfillTenant(tenantSlug, deviceId);
  if (!tenantInfo) return;

  let batch;
  try { batch = JSON.parse(rawPayload); } catch { return; }
  if (batch.v !== 1 || !Array.isArray(batch.r)) return;

  // Rate limit
  const now = Date.now();
  let counter = backfillCounters.get(deviceId);
  if (!counter || now > counter.reset) {
    counter = { count: 0, reset: now + 60000 };
    backfillCounters.set(deviceId, counter);
  }
  if (++counter.count > BACKFILL_RATE_LIMIT) return;

  const nowSec = Math.floor(now / 1000);
  const rows = [];

  for (const rec of batch.r) {
    if (!rec.t || rec.t < MIN_EPOCH || rec.t > nowSec || rec.t < nowSec - MAX_BACKFILL_AGE) continue;
    const ts = new Date(rec.t * 1000);
    const channels = [
      { ch: 'air',      val: rec.a },
      { ch: 'evap',     val: rec.e },
      { ch: 'cond',     val: rec.c },
      { ch: 'setpoint', val: rec.s },
    ];
    for (const { ch, val } of channels) {
      if (val === undefined || val === null || val === -32768) continue;
      rows.push([ts, tenantInfo.id, deviceId, ch, val / 10.0]);
    }
  }

  if (rows.length === 0) return;

  const values = [];
  const placeholders = rows.map((row, i) => {
    const b = i * 5;
    values.push(...row);
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5})`;
  }).join(', ');

  db.query(
    `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
     VALUES ${placeholders}
     ON CONFLICT DO NOTHING`,
    values
  ).catch(err => logger.error({ err, deviceId }, 'Backfill insert failed'));

  logger.info({ deviceId, records: batch.r.length, inserted: rows.length }, 'Backfill ingested');
}

const BACKFILL_EVENT_NAMES = {
  1: 'compressor_on', 2: 'compressor_off',
  3: 'defrost_start', 4: 'defrost_end',
  5: 'alarm_high_temp', 6: 'alarm_low_temp', 7: 'alarm_clear',
  8: 'door_open', 9: 'door_close', 10: 'power_on',
  11: 'alarm_sensor1', 12: 'alarm_sensor2',
  13: 'alarm_continuous_run', 14: 'alarm_rapid_cycle',
  15: 'alarm_pulldown', 16: 'alarm_rate',
  17: 'alarm_lockout', 18: 'alarm_door',
};

function handleBackfillEvents(tenantSlug, deviceId, rawPayload) {
  const tenantInfo = resolveBackfillTenant(tenantSlug, deviceId);
  if (!tenantInfo) return;

  let batch;
  try { batch = JSON.parse(rawPayload); } catch { return; }
  if (batch.v !== 1 || !Array.isArray(batch.e)) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const telemetryRows = [];
  const eventRows = [];

  for (const evt of batch.e) {
    if (!evt.t || evt.t < MIN_EPOCH || evt.t > nowSec) continue;
    const ts = new Date(evt.t * 1000);

    // Reconstruct comp/defrost telemetry from event pairs
    if (evt.ty === 1)      telemetryRows.push([ts, tenantInfo.id, deviceId, 'comp', 1]);
    else if (evt.ty === 2) telemetryRows.push([ts, tenantInfo.id, deviceId, 'comp', 0]);
    else if (evt.ty === 3) telemetryRows.push([ts, tenantInfo.id, deviceId, 'defrost', 1]);
    else if (evt.ty === 4) telemetryRows.push([ts, tenantInfo.id, deviceId, 'defrost', 0]);

    const eventName = BACKFILL_EVENT_NAMES[evt.ty] || `event_${evt.ty}`;
    eventRows.push([ts, tenantInfo.id, deviceId, eventName, JSON.stringify({ backfill: true, raw_type: evt.ty })]);
  }

  // Batch insert telemetry (comp/defrost reconstruction)
  if (telemetryRows.length > 0) {
    const values = [];
    const ph = telemetryRows.map((r, i) => {
      const b = i * 5;
      values.push(...r);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
    }).join(',');
    db.query(
      `INSERT INTO telemetry (time,tenant_id,device_id,channel,value) VALUES ${ph}
       ON CONFLICT DO NOTHING`,
      values
    ).catch(err => logger.error({ err, deviceId }, 'Backfill events telemetry insert failed'));
  }

  // Batch insert events (with device timestamp, NOT NOW())
  if (eventRows.length > 0) {
    const values = [];
    const ph = eventRows.map((r, i) => {
      const b = i * 5;
      values.push(...r);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
    }).join(',');
    db.query(
      `INSERT INTO events (time,tenant_id,device_id,event_type,payload) VALUES ${ph}
       ON CONFLICT DO NOTHING`,
      values
    ).catch(err => logger.error({ err, deviceId }, 'Backfill events insert failed'));
  }

  logger.info({ deviceId, telemetry: telemetryRows.length, events: eventRows.length }, 'Backfill events ingested');
}

function handleBackfillDone(tenantSlug, deviceId) {
  logger.info({ tenantSlug, deviceId }, 'Backfill complete signal received');
  emitter.emit('backfill_complete', { tenantSlug, deviceId });
}

// ── Alarm detection ───────────────────────────────────────

// Nuisance alarm delay (ISA-18.2): suppress transient alarms
const pendingAlarms = new Map();  // "deviceId:alarmCode" -> setTimeout handle
const NUISANCE_DELAY = { door_alarm: 120000, pulldown_alarm: 300000 };  // 2min, 5min

async function detectAlarm(tenantSlug, deviceId, key, value, state) {
  const tenantInfo = resolveTenant(tenantSlug);
  const alarmCode  = key.replace('protection.', '');
  const severity   = alarmSeverity(alarmCode);
  const pendingKey = `${deviceId}:${alarmCode}`;
  const delay      = NUISANCE_DELAY[alarmCode];

  if (value === true) {
    if (delay) {
      // Delayed alarm — wait before confirming (transient filter)
      if (pendingAlarms.has(pendingKey)) return;  // Already pending
      logger.debug({ deviceId, alarmCode, delay }, 'Nuisance delay started');
      const timer = setTimeout(() => {
        pendingAlarms.delete(pendingKey);
        raiseAlarm(tenantInfo, tenantSlug, deviceId, alarmCode, severity);
      }, delay);
      pendingAlarms.set(pendingKey, timer);
    } else {
      raiseAlarm(tenantInfo, tenantSlug, deviceId, alarmCode, severity);
    }
  } else if (value === false) {
    // If pending (not yet raised) → cancel (transient, never recorded)
    if (pendingAlarms.has(pendingKey)) {
      clearTimeout(pendingAlarms.get(pendingKey));
      pendingAlarms.delete(pendingKey);
      logger.debug({ deviceId, alarmCode }, 'Nuisance alarm cancelled (transient)');
      return;
    }
    // Alarm cleared — await DB before emitting to avoid race condition
    logger.info({ tenantSlug, deviceId, alarmCode }, 'Alarm cleared');
    try {
      await db.query(
        `UPDATE alarms SET active = false, cleared_at = NOW()
         WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = $3 AND active = true`,
        [tenantInfo.id, deviceId, alarmCode]
      );
    } catch (err) {
      logger.error({ err, deviceId, alarmCode }, 'Failed to clear alarm');
    }
    emitter.emit('alarm', { tenantSlug, deviceId, alarmCode, active: false, severity });
  }
}

async function raiseAlarm(tenantInfo, tenantSlug, deviceId, alarmCode, severity) {
  logger.warn({ tenantSlug, deviceId, alarmCode }, 'Alarm raised');
  try {
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, $2, $3, $4, true, NOW())`,
      [tenantInfo.id, deviceId, alarmCode, severity]
    );
  } catch (err) {
    logger.error({ err, deviceId, alarmCode }, 'Failed to insert alarm');
  }
  emitter.emit('alarm', { tenantSlug, deviceId, alarmCode, active: true, severity });
}

function alarmSeverity(code) {
  // Critical: sensor failures, temperature violations (immediate action needed)
  if (code === 'sensor1_alarm' || code === 'sensor2_alarm') return 'critical';
  if (code === 'high_temp_alarm' || code === 'low_temp_alarm') return 'critical';
  // Info: statistical/informational (no immediate action, ISA-18.2 nuisance reduction)
  if (code === 'rate_alarm' || code === 'short_cycle_alarm' || code === 'rapid_cycle_alarm') return 'info';
  // Warning: everything else (door, pulldown, continuous_run)
  return 'warning';
}

// ── Event detection ───────────────────────────────────────

function detectEvent(tenantSlug, deviceId, key, value, state) {
  const tenantInfo = resolveTenant(tenantSlug);
  const mapping = EVENT_KEYS[key];
  const eventType = value === true ? mapping.on : mapping.off;

  logger.debug({ deviceId, eventType }, 'Event detected');
  insertEvent(tenantInfo.id, deviceId, eventType);
}

// ── Event buffer (batched INSERT every 1s) ──────────────
const eventBuffer = [];

function insertEvent(tenantId, deviceId, eventType, payload) {
  eventBuffer.push({
    tenantId,
    deviceId,
    eventType,
    payload: payload ? JSON.stringify(payload) : null,
  });
}

async function flushEvents() {
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer.splice(0);
  const values = [];
  const placeholders = [];
  let idx = 1;

  for (const evt of batch) {
    placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, NOW())`);
    values.push(evt.tenantId, evt.deviceId, evt.eventType, evt.payload);
    idx += 4;
  }

  try {
    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, payload, time)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  } catch (err) {
    logger.error({ err, count: batch.length }, 'Failed to flush event batch');
  }
}

// ── Auto-discovery ────────────────────────────────────────

/** Rate-limit new device discoveries to prevent MQTT flooding attacks */
const discoveryCount = new Map(); // tenantSlug → { count, resetAt }
const DISCOVERY_LIMIT = 20;       // new devices per tenant per minute
const DISCOVERY_WINDOW_MS = 60000;

/** Recently deleted devices — blocks re-creation from retained MQTT messages */
const deletedDevices = new Map(); // deviceId → deleteTimestamp
const DELETED_BLOCK_MS = 30_000; // 30 seconds (enough for retained messages to pass)

function ensureDevice(tenantSlug, deviceId) {
  const regEntry = deviceRegistry.get(deviceId);

  // Active or pending device — already handled, nothing to do
  if (regEntry && regEntry.status !== 'deleted') return;

  // Block re-creation right after any deletion (retained MQTT messages flood window)
  const deletedAt = deletedDevices.get(deviceId);
  if (deletedAt) {
    if (Date.now() - deletedAt < DELETED_BLOCK_MS) return;
    deletedDevices.delete(deviceId); // expired — allow re-discovery
  }

  // Unknown device publishing with a tenant slug (not pending) —
  // it was deleted from DB but still has old credentials on ESP.
  // Reset it to pending so it can be properly re-assigned.
  if (tenantSlug !== 'pending') {
    logger.warn({ tenantSlug, deviceId },
      'Unknown device publishing with tenant — resetting to pending');
    sendCommand(tenantSlug, deviceId, '_set_tenant', 'pending', { qos: 1 });
    return; // don't create DB record yet — device will reconnect as pending
  }

  // Rate-limit discoveries per tenant slug
  const now = Date.now();
  let entry = discoveryCount.get(tenantSlug);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + DISCOVERY_WINDOW_MS };
    discoveryCount.set(tenantSlug, entry);
  }
  if (entry.count >= DISCOVERY_LIMIT) {
    logger.warn({ tenantSlug, deviceId }, 'Auto-discovery rate limit exceeded — dropping');
    return;
  }
  entry.count++;

  const tenantInfo = resolveTenant(tenantSlug);

  // Add to registry SYNCHRONOUSLY to prevent duplicate logs from concurrent messages
  deviceRegistry.set(deviceId, {
    id:       null,  // will be resolved on next registry refresh
    tenantId: tenantInfo.id,
    status: 'pending',
  });

  logger.info({ tenantSlug, deviceId }, 'Auto-discovery: new device');

  db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, last_seen)
     VALUES ($1, $2, 'pending', true, NOW())
     ON CONFLICT (mqtt_device_id) DO UPDATE
       SET status = 'pending', deleted_at = NULL, tenant_id = EXCLUDED.tenant_id,
           online = true, last_seen = NOW()
       WHERE devices.status = 'deleted'`,
    [tenantInfo.id, deviceId]
  ).then((res) => {
    if (res.rowCount > 0) {
      // New device: set bootstrap credentials (setBootstrapCredentials is a no-op if hash exists)
      if (BOOTSTRAP_HASH) {
        mqttAuth.setBootstrapCredentials(deviceId, BOOTSTRAP_HASH)
          .catch(err => logger.error({ err, deviceId }, 'Failed to set bootstrap credentials'));
      }
      emitter.emit('pending_device', { deviceId, action: 'added' });
    }
  }).catch(err => {
    logger.error({ err, deviceId }, 'Failed to auto-discover device');
  });
}

// ── Stuck-device auto-detection ───────────────────────────

/** Track recent assigns to avoid false-positive resets during assign window */
function recordAssign(deviceId) {
  recentAssigns.set(deviceId, Date.now());
}

/** Guard: devices currently being auto-reset (prevents concurrent reset floods) */
const resettingDevices = new Set();

/**
 * Detect devices stuck in "pending" namespace after a failed assign.
 * If deviceRegistry says device is active in a non-SYSTEM tenant,
 * but it's still publishing as "pending", auto-reassign by sending
 * the correct credentials and tenant slug to the device.
 */
function checkStuckDevice(tenantSlug, deviceId) {
  if (tenantSlug !== 'pending') return;
  if (resettingDevices.has(deviceId)) return; // already processing

  // Skip during startup — retained messages from old topics trigger false positives
  if (Date.now() - startupTime < STARTUP_GRACE_MS) return;

  const regEntry = deviceRegistry.get(deviceId);
  if (!regEntry) return; // unknown → ensureDevice will handle

  if (regEntry.status === 'active' && regEntry.tenantId !== db.SYSTEM_TENANT_ID) {
    // Check grace period
    const assignedAt = recentAssigns.get(deviceId);
    if (assignedAt && (Date.now() - assignedAt < ASSIGN_GRACE_MS)) return;

    logger.warn(
      { deviceId, dbTenantId: regEntry.tenantId, mqttSlug: 'pending' },
      'Stuck device detected: active in DB but publishing as pending — auto-reassigning'
    );

    resettingDevices.add(deviceId);
    autoReassignDevice(deviceId, regEntry.tenantId)
      .catch(err => {
        logger.error({ err, deviceId }, 'Failed to auto-reassign stuck device');
      })
      .finally(() => {
        resettingDevices.delete(deviceId);
      });
  }
}

/** Re-send credentials and tenant slug to a stuck device so it reconnects properly */
async function autoReassignDevice(deviceId, tenantId) {
  // Look up tenant slug
  let tenantSlug = null;
  for (const [slug, info] of tenantRegistry) {
    if (info.id === tenantId) { tenantSlug = slug; break; }
  }
  if (!tenantSlug) {
    logger.error({ deviceId, tenantId }, 'Auto-reassign failed: tenant not found in registry');
    return;
  }

  // Get existing credentials from DB (or provision new ones)
  const { rows } = await db.query(
    `SELECT mqtt_username, mqtt_password_hash FROM devices WHERE mqtt_device_id = $1`,
    [deviceId]
  );
  if (!rows.length) return;

  const existing = rows[0];
  let username = existing.mqtt_username;
  let password = null;

  // If device has bootstrap credentials, provision new unique ones
  if (username === `device_${deviceId}` && BOOTSTRAP_HASH && existing.mqtt_password_hash === BOOTSTRAP_HASH) {
    const creds = await mqttAuth.provisionDevice(tenantId, deviceId);
    username = creds.username;
    password = creds.password;
    logger.info({ deviceId }, 'Auto-reassign: provisioned new credentials');
  } else {
    // Device already has unique credentials but lost its tenant.
    // Re-provision so we have the plaintext password to send.
    const creds = await mqttAuth.provisionDevice(tenantId, deviceId);
    username = creds.username;
    password = creds.password;
  }

  // Send credentials first (device saves but does NOT reconnect)
  sendJsonCommand('pending', deviceId, '_set_mqtt_creds', { user: username, pass: password });

  // Then send tenant slug (device saves + reconnects with new credentials)
  sendCommand('pending', deviceId, '_set_tenant', tenantSlug, { qos: 1 });

  recordAssign(deviceId);
  logger.info({ deviceId, tenantSlug }, 'Auto-reassigned stuck device to tenant');
}

// ── Tenant resolution ─────────────────────────────────────

function resolveTenant(slug) {
  if (slug === 'pending') {
    return { id: db.SYSTEM_TENANT_ID, active: true };
  }
  const tenant = tenantRegistry.get(slug);
  if (tenant) return tenant;

  // Unknown tenant — treat as system for now, will be corrected on registry refresh
  logger.warn({ slug }, 'Unknown tenant slug, using system tenant');
  return { id: db.SYSTEM_TENANT_ID, active: true };
}

// ── Periodic: Telemetry sampler (every 5 min) ─────────────

async function telemetrySampler() {
  const rows = [];
  for (const [deviceId, state] of stateMap) {
    if (!state._online) continue;
    for (const { key, channel, bool } of TELEMETRY_CHANNELS) {
      const val = state[key];
      if (val === undefined) continue;
      // Boolean channels (compressor, defrost) → 0/1
      const numVal = bool ? (val ? 1 : 0) : val;
      if (typeof numVal === 'number') {
        rows.push({ tenantId: state._tenantId, deviceId, channel, value: numVal });
      }
    }

    // ── Energy estimation (kWh per interval) ──
    const profile = powerProfiles.get(deviceId);
    if (profile) {
      const intervalHours = TELEMETRY_INTERVAL / 3600000;

      // Future: real sensor override — use actual reading if firmware publishes it
      if (state['equipment.energy_kwh'] !== undefined && typeof state['equipment.energy_kwh'] === 'number') {
        rows.push({ tenantId: state._tenantId, deviceId, channel: 'energy', value: state['equipment.energy_kwh'] });
      } else {
        let energy = profile.standby_kw * intervalHours;

        if (state['equipment.compressor'] === true) {
          energy += profile.compressor_kw * intervalHours;
          energy += (profile.evap_fan_kw + profile.cond_fan_kw) * intervalHours;
        }

        if (state['defrost.active'] === true) {
          energy += profile.defrost_heater_kw * intervalHours;
        }

        if (energy > 0) {
          // Round to 4 decimal places (0.0001 kWh precision)
          rows.push({ tenantId: state._tenantId, deviceId, channel: 'energy', value: Math.round(energy * 10000) / 10000 });
        }
      }
    }
  }

  if (rows.length === 0) return;

  // Batch insert
  const values = [];
  const placeholders = [];
  let idx = 1;
  for (const r of rows) {
    placeholders.push(`(date_trunc('second', NOW()), $${idx}, $${idx+1}, $${idx+2}, $${idx+3})`);
    values.push(r.tenantId, r.deviceId, r.channel, r.value);
    idx += 4;
  }

  try {
    await db.query(
      `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values
    );
    logger.info({ count: rows.length }, 'Telemetry sampled');
  } catch (err) {
    logger.error({ err }, 'Failed to sample telemetry');
  }
}

// ── Periodic: State writer (debounced, every 5s check) ────

async function stateWriter() {
  const now = Date.now();

  // Collect all dirty devices that passed debounce threshold
  const batch = [];
  for (const [deviceId, state] of stateMap) {
    if (!state._dirty) continue;
    if (now - state._lastDbWrite < STATE_DEBOUNCE) continue;

    // Build last_state JSONB (only real state keys, no _ prefixed)
    const lastState = {};
    for (const [k, v] of Object.entries(state)) {
      if (!k.startsWith('_')) lastState[k] = v;
    }

    batch.push({
      deviceId,
      tenantId: state._tenantId,
      lastState: JSON.stringify(lastState),
      online:    state._online,
      state,      // ref for marking clean after success
    });
  }

  if (batch.length === 0) return;

  // Single multi-row UPDATE via VALUES (5000 queries → 1 query)
  const CHUNK = 500;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    const values = [];
    const placeholders = [];
    let idx = 1;

    for (const item of chunk) {
      placeholders.push(`($${idx}::uuid, $${idx+1}, $${idx+2}::jsonb, $${idx+3}::boolean)`);
      values.push(item.tenantId, item.deviceId, item.lastState, item.online);
      idx += 4;
    }

    try {
      await db.query(
        `UPDATE devices AS d
         SET last_state = v.ls, online = v.ol, last_seen = NOW()
         FROM (VALUES ${placeholders.join(', ')}) AS v(tid, mid, ls, ol)
         WHERE d.tenant_id = v.tid AND d.mqtt_device_id = v.mid`,
        values
      );

      // Mark all items in this chunk as clean
      for (const item of chunk) {
        item.state._dirty      = false;
        item.state._lastDbWrite = now;
      }

      if (chunk.length >= 10) {
        logger.info({ count: chunk.length }, 'Batch state write');
      }
    } catch (err) {
      // On failure, leave all dirty — retry on next cycle
      logger.error({ err, count: chunk.length }, 'Failed batch state write');
    }
  }
}

// ── Periodic: StateMap monitoring (every 60s) ─────────────

function stateMapMonitor() {
  let totalKeys = 0;
  let onlineCount = 0;

  for (const [, state] of stateMap) {
    if (state._online) onlineCount++;
    for (const k of Object.keys(state)) {
      if (!k.startsWith('_')) totalKeys++;
    }
  }

  // Rough memory estimate: ~200 bytes per state key (key string + value + overhead)
  const approxMb = ((totalKeys * 200 + stateMap.size * 300) / 1048576).toFixed(1);

  logger.info(
    { devices: stateMap.size, online: onlineCount, totalKeys, approxMb: `${approxMb}MB`, eventBuf: eventBuffer.length },
    'StateMap stats'
  );
}

// ── Periodic: Offline detector (every 30s) ────────────────

async function offlineDetector() {
  const now = Date.now();

  for (const [deviceId, state] of stateMap) {
    if (!state._online) continue;
    if (now - state._lastSeen < OFFLINE_THRESHOLD) continue;

    // Mark offline
    state._online = false;
    state._dirty  = true;
    logger.warn({ deviceId, lastSeen: new Date(state._lastSeen).toISOString() }, 'Device went offline');

    db.query(
      `UPDATE devices SET online = false
       WHERE tenant_id = $1 AND mqtt_device_id = $2`,
      [state._tenantId, deviceId]
    ).catch(err => logger.error({ err, deviceId }, 'Failed to mark device offline'));

    insertEvent(state._tenantId, deviceId, 'device_offline');

    emitter.emit('device_status', {
      tenantSlug: state._tenantSlug, deviceId, online: false,
      lastSeen: new Date(state._lastSeen).toISOString(),
    });
  }
}

// ── Periodic: Soft-delete cleanup (every hour) ───────────
// Hard-deletes device records that have been soft-deleted for more than 7 days.
// After 7 days the device's credentials are useless — bootstrap fallback will
// handle re-discovery if the device ever reconnects again.

async function softDeleteCleanup() {
  try {
    const res = await db.query(
      `DELETE FROM devices WHERE status = 'deleted' AND deleted_at < NOW() - INTERVAL '7 days'`
    );
    if (res.rowCount > 0) {
      logger.info({ count: res.rowCount }, 'Soft-deleted device cleanup: hard-deleted expired records');
    }
  } catch (err) {
    logger.error({ err }, 'Soft-delete cleanup failed');
  }
}

// ── Periodic: Auto-recover missing devices (every 5 min) ──
// Devices that have been active but offline for >60 min are likely reflashed/reset.
// Reset their DB credentials to bootstrap so they can reconnect as pending.

async function checkMissingDevices() {
  if (!BOOTSTRAP_HASH) return;
  try {
    const { rows } = await db.query(
      `UPDATE devices
       SET mqtt_password_hash = $1,
           status = 'pending',
           tenant_id = $2
       WHERE status = 'active'
         AND online = false
         AND last_seen < NOW() - INTERVAL '60 minutes'
         AND mqtt_password_hash IS DISTINCT FROM $1
       RETURNING mqtt_device_id`,
      [BOOTSTRAP_HASH, db.SYSTEM_TENANT_ID]
    );

    if (rows.length > 0) {
      for (const row of rows) {
        deviceRegistry.set(row.mqtt_device_id, {
          id: null, tenantId: db.SYSTEM_TENANT_ID, status: 'pending',
        });
        logger.info({ deviceId: row.mqtt_device_id },
          'Missing device auto-reset to pending with bootstrap credentials');
      }
      await loadRegistries();
    }
  } catch (err) {
    logger.error({ err }, 'checkMissingDevices failed');
  }
}

// ── Periodic: Registry refresh (every 60s) ────────────────

async function refreshRegistries() {
  await loadRegistries();
  await loadPowerProfiles();

  // Clean stale recentAssigns entries
  const now = Date.now();
  for (const [id, ts] of recentAssigns) {
    if (now - ts > ASSIGN_GRACE_MS * 2) recentAssigns.delete(id);
  }
}

/**
 * Load power profiles for energy estimation.
 * Device overrides win over model defaults via COALESCE.
 */
async function loadPowerProfiles() {
  try {
    const { rows } = await db.query(
      `SELECT d.mqtt_device_id,
              COALESCE(d.compressor_kw, m.compressor_kw, 0) AS compressor_kw,
              COALESCE(d.evap_fan_kw, m.evap_fan_kw, 0)     AS evap_fan_kw,
              COALESCE(d.cond_fan_kw, m.cond_fan_kw, 0)      AS cond_fan_kw,
              COALESCE(d.defrost_heater_kw, m.defrost_heater_kw, 0) AS defrost_heater_kw,
              COALESCE(d.standby_kw, m.standby_kw, 0)        AS standby_kw
       FROM devices d
       LEFT JOIN device_models m ON d.model_id = m.id
       WHERE d.status = 'active'`
    );

    powerProfiles.clear();
    for (const row of rows) {
      // Skip devices with no power data at all
      const total = Number(row.compressor_kw) + Number(row.evap_fan_kw) +
                    Number(row.cond_fan_kw) + Number(row.defrost_heater_kw) + Number(row.standby_kw);
      if (total > 0) {
        powerProfiles.set(row.mqtt_device_id, {
          compressor_kw:     Number(row.compressor_kw),
          evap_fan_kw:       Number(row.evap_fan_kw),
          cond_fan_kw:       Number(row.cond_fan_kw),
          defrost_heater_kw: Number(row.defrost_heater_kw),
          standby_kw:        Number(row.standby_kw),
        });
      }
    }

    if (powerProfiles.size > 0) {
      logger.info({ count: powerProfiles.size }, 'Power profiles loaded');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load power profiles');
  }
}

/**
 * Bootstrap stateMap from DB last_state on startup.
 * Ensures that after backend restart, we have the last known state
 * even if the ESP32 doesn't re-publish its full state dump.
 */
async function bootstrapStateMap() {
  try {
    const { rows } = await db.query(
      `SELECT d.mqtt_device_id, d.tenant_id, d.last_state, d.online,
              t.slug AS tenant_slug
       FROM devices d
       LEFT JOIN tenants t ON t.id = d.tenant_id
       WHERE d.last_state IS NOT NULL`
    );

    for (const row of rows) {
      const state = {
        _tenantId:    row.tenant_id,
        _tenantSlug:  row.tenant_slug || 'pending',
        _lastSeen:    Date.now(),
        _online:      false,    // will be set to true by status/heartbeat
        _dirty:       false,    // data is already in DB
        _lastDbWrite: Date.now(),
      };

      // Merge all state keys from DB (skip internal _ prefixed keys — defense-in-depth)
      if (row.last_state && typeof row.last_state === 'object') {
        for (const [k, v] of Object.entries(row.last_state)) {
          if (k.startsWith('_')) continue;
          state[k] = v;
        }
      }

      stateMap.set(row.mqtt_device_id, state);

      // Count state keys (exclude internal _ prefixed)
      const stateKeyCount = Object.keys(state).filter(k => !k.startsWith('_')).length;
      logger.info({ deviceId: row.mqtt_device_id, keys: stateKeyCount }, 'StateMap bootstrapped device');
    }

    logger.info({ devices: rows.length }, 'StateMap bootstrapped from DB');
  } catch (err) {
    logger.error({ err }, 'Failed to bootstrap stateMap');
  }
}

async function loadRegistries() {
  try {
    // Load tenants
    const tenants = await db.query('SELECT id, slug, active FROM tenants');
    tenantRegistry.clear();
    for (const row of tenants.rows) {
      tenantRegistry.set(row.slug, { id: row.id, active: row.active });
    }

    // Load devices
    const devices = await db.query('SELECT id, tenant_id, mqtt_device_id, status FROM devices');
    deviceRegistry.clear();
    for (const row of devices.rows) {
      deviceRegistry.set(row.mqtt_device_id, {
        id:       row.id,
        tenantId: row.tenant_id,
        status:   row.status,
      });
    }

    logger.debug(
      { tenants: tenantRegistry.size, devices: deviceRegistry.size },
      'Registries loaded'
    );
  } catch (err) {
    logger.error({ err }, 'Failed to load registries');
  }
}

// ── Public API (for REST routes and WebSocket) ────────────

/**
 * Get accumulated state for a device (without internal _ keys).
 * @param {string} deviceId  mqtt_device_id (e.g. "F27FCD")
 * @returns {Object|null}
 */
function getDeviceState(deviceId) {
  const state = stateMap.get(deviceId);
  if (!state) return null;
  const result = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith('_')) result[k] = v;
  }
  return result;
}

/**
 * Get device metadata (online, lastSeen, tenantId).
 * @param {string} deviceId
 * @returns {Object|null}
 */
function getDeviceMeta(deviceId) {
  const state = stateMap.get(deviceId);
  if (!state) return null;
  return {
    tenantId:   state._tenantId,
    tenantSlug: state._tenantSlug,
    online:     state._online,
    lastSeen:   state._lastSeen,
  };
}

/**
 * Get the MQTT topic slug the device is **actually** publishing on.
 * Falls back to dbSlug (from DB tenant lookup) if no live data.
 * Solves the "device still on pending but DB says __system__" race.
 * @param {string} deviceId  e.g. "F27FCD"
 * @param {string} [dbSlug]  slug resolved from DB (optional fallback)
 * @returns {string}
 */
function getDeviceRoutingSlug(deviceId, dbSlug) {
  const state = stateMap.get(deviceId);
  if (state && state._tenantSlug) return state._tenantSlug;
  return dbSlug || 'pending';
}

/**
 * Send a command to a device via MQTT.
 * @param {string} tenantSlug
 * @param {string} deviceId
 * @param {string} key     e.g. "thermostat.setpoint"
 * @param {*}      value   scalar value
 */
function sendCommand(tenantSlug, deviceId, key, value, { qos = 0 } = {}) {
  if (!client || !connected) throw new Error('MQTT not connected');
  const topic = `modesp/v1/${tenantSlug}/${deviceId}/cmd/${key}`;
  client.publish(topic, String(value), { qos });
  logger.info({ tenantSlug, deviceId, key, value, qos }, 'Command sent');

  // Optimistic echo: update stateMap and broadcast via WebSocket
  // so the UI immediately reflects the sent value
  const parsed = parseScalar(String(value));
  const state = stateMap.get(deviceId);
  if (state) {
    state[key] = parsed;
    state._dirty = true;
    emitter.emit('state_delta', { tenantSlug, deviceId, changes: { [key]: parsed } });
  }
}

/**
 * Send a JSON command to a device via MQTT (QoS 1).
 * Used for special commands like _ota where payload is JSON, not scalar.
 * @param {string} tenantSlug
 * @param {string} deviceId
 * @param {string} key     e.g. "_ota"
 * @param {object} payload JSON-serialisable object
 */
function sendJsonCommand(tenantSlug, deviceId, key, payload) {
  if (!client || !connected) throw new Error('MQTT not connected');
  const topic = `modesp/v1/${tenantSlug}/${deviceId}/cmd/${key}`;
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
  logger.info({ tenantSlug, deviceId, key }, 'JSON command sent (QoS 1)');
}

/**
 * Request full state republish from device.
 * ESP32 will clear its publish cache and resend all 48 keys within ~1s.
 * @param {string} tenantSlug
 * @param {string} deviceId
 */
function requestFullState(tenantSlug, deviceId) {
  if (!client || !connected) return;
  const topic = `modesp/v1/${tenantSlug}/${deviceId}/cmd/_request_full_state`;
  client.publish(topic, '1', { qos: 0 });
  logger.info({ tenantSlug, deviceId }, 'Requested full state from device');
}

/**
 * Update stateMap metadata for a device after tenant reassignment.
 * @param {string} deviceId  mqtt_device_id (e.g. "F27FCD")
 * @param {string} newTenantId  UUID
 * @param {string} newTenantSlug
 */
function updateDeviceStateMap(deviceId, newTenantId, newTenantSlug) {
  const state = stateMap.get(deviceId);
  if (state) {
    state._tenantId = newTenantId;
    state._tenantSlug = newTenantSlug;
    state._dirty = true;
  }
}

/**
 * Remove a device from in-memory stateMap and deviceRegistry.
 * Blocks auto-discovery re-creation for 5 minutes (retained MQTT messages).
 * Clears retained MQTT messages for the device's known topic prefix.
 * Called after device is deleted from DB.
 * @param {string} deviceId  mqtt_device_id (e.g. "F27FCD")
 */
function removeDeviceState(deviceId) {
  // Clear pending nuisance-delay timers for this device
  for (const [key, timer] of pendingAlarms) {
    if (key.startsWith(deviceId + ':')) {
      clearTimeout(timer);
      pendingAlarms.delete(key);
    }
  }

  // Read tenant slug before clearing state (needed for retained message cleanup)
  const state = stateMap.get(deviceId);
  const tenantSlug = state?._tenantSlug || null;

  stateMap.delete(deviceId);
  deviceRegistry.delete(deviceId);
  deletedDevices.set(deviceId, Date.now());

  // Clear retained MQTT messages for both pending and tenant topics
  clearPendingRetained(deviceId);
  if (tenantSlug && tenantSlug !== 'pending') {
    clearRetainedForTenant(tenantSlug, deviceId);
  }
}

/**
 * Clear retained MQTT messages from old pending topics for a device.
 * Prevents stuck device detection false positives on backend restart.
 * MQTT spec: publish empty payload with retain=true to clear retained message.
 */
function clearPendingRetained(deviceId) {
  if (!client || !connected) return;
  const prefix = `modesp/v1/pending/${deviceId}`;

  // Clear status and heartbeat retained messages
  client.publish(`${prefix}/status`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/heartbeat`, '', { retain: true, qos: 0 });

  // Clear common retained state keys (protection keys are published with retain=true)
  for (const key of ALARM_KEYS) {
    client.publish(`${prefix}/state/${key}`, '', { retain: true, qos: 0 });
  }
  client.publish(`${prefix}/state/protection.alarm_active`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/state/protection.alarm_code`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/state/protection.compressor_blocked`, '', { retain: true, qos: 0 });

  logger.info({ deviceId }, 'Cleared retained pending MQTT messages');
}

/**
 * Clear retained MQTT messages for a device under a specific tenant slug.
 * Same approach as clearPendingRetained but for tenant-scoped topics.
 */
function clearRetainedForTenant(tenantSlug, deviceId) {
  if (!client || !connected) return;
  const prefix = `modesp/v1/${tenantSlug}/${deviceId}`;

  client.publish(`${prefix}/status`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/heartbeat`, '', { retain: true, qos: 0 });

  for (const key of ALARM_KEYS) {
    client.publish(`${prefix}/state/${key}`, '', { retain: true, qos: 0 });
  }
  client.publish(`${prefix}/state/protection.alarm_active`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/state/protection.alarm_code`, '', { retain: true, qos: 0 });
  client.publish(`${prefix}/state/protection.compressor_blocked`, '', { retain: true, qos: 0 });

  logger.info({ tenantSlug, deviceId }, 'Cleared retained tenant MQTT messages');
}

// ── Exports ───────────────────────────────────────────────

/** Return pre-computed bootstrap password hash (or null if not configured) */
function getBootstrapHash() { return BOOTSTRAP_HASH; }

module.exports = {
  start, shutdown, isConnected,
  parseTopic, parseScalar,
  getDeviceState, getDeviceMeta, getDeviceRoutingSlug, sendCommand, sendJsonCommand,
  requestFullState, refreshRegistries, updateDeviceStateMap, removeDeviceState,
  getBootstrapHash, recordAssign, clearPendingRetained,
  on:   emitter.on.bind(emitter),
  off:  emitter.off.bind(emitter),
  once: emitter.once.bind(emitter),
  emit: emitter.emit.bind(emitter),
};
