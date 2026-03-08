'use strict';

const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const db   = require('./db');

const emitter = new EventEmitter();

// ── Config ────────────────────────────────────────────────
const TELEMETRY_INTERVAL = parseInt(process.env.TELEMETRY_INTERVAL_MS, 10) || 300000;
const OFFLINE_THRESHOLD  = parseInt(process.env.OFFLINE_THRESHOLD_MS, 10)  || 90000;
const STATE_DEBOUNCE     = parseInt(process.env.STATE_DEBOUNCE_MS, 10)     || 30000;
const REGISTRY_REFRESH   = parseInt(process.env.REGISTRY_REFRESH_MS, 10)   || 60000;
const STATE_CHECK_MS     = 5000;    // check dirty devices every 5 s
const OFFLINE_CHECK_MS   = 30000;   // scan for offline devices every 30 s

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

let client = null;
let logger = null;
let timers = [];
let connected = false;

// ── Public API ────────────────────────────────────────────

/**
 * Start the MQTT service.
 * @param {import('pino').Logger} log
 */
async function start(log) {
  logger = log;

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
  timers.push(setInterval(telemetrySampler, TELEMETRY_INTERVAL));
  timers.push(setInterval(stateWriter,      STATE_CHECK_MS));
  timers.push(setInterval(offlineDetector,   OFFLINE_CHECK_MS));
  timers.push(setInterval(refreshRegistries, REGISTRY_REFRESH));
}

function isConnected() { return connected; }

async function shutdown() {
  for (const t of timers) clearInterval(t);
  timers = [];
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

  // Legacy
  client.subscribe('modesp/+/state/+');
  client.subscribe('modesp/+/status');

  logger.info('Subscribed to MQTT topics');
}

function onMessage(topic, payload) {
  try {
    const msg = payload.toString().trim();
    const parsed = parseTopic(topic);
    if (!parsed) return;

    const { tenantSlug, deviceId, subtopic, stateKey } = parsed;

    switch (subtopic) {
      case 'state':
        if (stateKey) handleStateKey(tenantSlug, deviceId, stateKey, msg);
        break;
      case 'status':
        handleStatus(tenantSlug, deviceId, msg);
        break;
      case 'heartbeat':
        handleHeartbeat(tenantSlug, deviceId, msg);
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

function handleStateKey(tenantSlug, deviceId, key, rawPayload) {
  const value = parseScalar(rawPayload);
  const now   = Date.now();

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

  // Detect alarm transitions BEFORE updating state
  if (ALARM_KEYS.has(key)) {
    const prev = state[key];
    if (prev !== undefined && prev !== value) {
      detectAlarm(tenantSlug, deviceId, key, value, state);
    }
  }

  // Detect event transitions (compressor, defrost)
  if (key in EVENT_KEYS) {
    const prev = state[key];
    if (prev !== undefined && prev !== value) {
      detectEvent(tenantSlug, deviceId, key, value, state);
    }
  }

  // Update state
  state[key]       = value;
  state._lastSeen  = now;
  state._online    = true;
  state._dirty     = true;

  // Emit delta for WebSocket broadcast
  emitter.emit('state_delta', { tenantSlug, deviceId, changes: { [key]: value } });

  // Ensure device exists in registry (auto-discovery for unknown devices)
  ensureDevice(tenantSlug, deviceId);
}

function handleStatus(tenantSlug, deviceId, payload) {
  const online = (payload === 'online');
  const now    = Date.now();

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

  // Auto-discovery
  ensureDevice(tenantSlug, deviceId);

  // Emit for WebSocket broadcast
  emitter.emit('device_status', {
    tenantSlug, deviceId, online,
    lastSeen: new Date().toISOString(),
  });

  logger.info({ tenantSlug, deviceId, online }, 'Device status');
}

function handleHeartbeat(tenantSlug, deviceId, rawPayload) {
  const now = Date.now();

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

  try {
    const hb = JSON.parse(rawPayload);
    // Update firmware_version in DB if present
    if (hb.fw) {
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

// ── Alarm detection ───────────────────────────────────────

function detectAlarm(tenantSlug, deviceId, key, value, state) {
  const tenantInfo = resolveTenant(tenantSlug);
  const alarmCode  = key.replace('protection.', '');

  const severity = alarmSeverity(alarmCode);

  if (value === true) {
    // Alarm raised
    logger.warn({ tenantSlug, deviceId, alarmCode }, 'Alarm raised');
    db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, $2, $3, $4, true, NOW())`,
      [tenantInfo.id, deviceId, alarmCode, severity]
    ).catch(err => logger.error({ err, deviceId, alarmCode }, 'Failed to insert alarm'));
    emitter.emit('alarm', { tenantSlug, deviceId, alarmCode, active: true, severity });
  } else if (value === false) {
    // Alarm cleared
    logger.info({ tenantSlug, deviceId, alarmCode }, 'Alarm cleared');
    db.query(
      `UPDATE alarms SET active = false, cleared_at = NOW()
       WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = $3 AND active = true`,
      [tenantInfo.id, deviceId, alarmCode]
    ).catch(err => logger.error({ err, deviceId, alarmCode }, 'Failed to clear alarm'));
    emitter.emit('alarm', { tenantSlug, deviceId, alarmCode, active: false, severity });
  }
}

function alarmSeverity(code) {
  // Critical alarms: sensor failures, lockout-related
  if (code === 'sensor1_alarm' || code === 'sensor2_alarm') return 'critical';
  if (code === 'high_temp_alarm' || code === 'low_temp_alarm') return 'critical';
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

function insertEvent(tenantId, deviceId, eventType, payload) {
  db.query(
    `INSERT INTO events (tenant_id, device_id, event_type, payload, time)
     VALUES ($1, $2, $3, $4, NOW())`,
    [tenantId, deviceId, eventType, payload ? JSON.stringify(payload) : null]
  ).catch(err => logger.error({ err, deviceId, eventType }, 'Failed to insert event'));
}

// ── Auto-discovery ────────────────────────────────────────

function ensureDevice(tenantSlug, deviceId) {
  if (deviceRegistry.has(deviceId)) return;

  const tenantInfo = resolveTenant(tenantSlug);
  const status = tenantSlug === 'pending' ? 'pending' : 'active';

  // Add to registry SYNCHRONOUSLY to prevent duplicate logs from concurrent messages
  deviceRegistry.set(deviceId, {
    id:       null,  // will be resolved on next registry refresh
    tenantId: tenantInfo.id,
    status,
  });

  logger.info({ tenantSlug, deviceId }, 'Auto-discovery: new device');

  db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, last_seen)
     VALUES ($1, $2, $3, true, NOW())
     ON CONFLICT (mqtt_device_id) DO NOTHING`,
    [tenantInfo.id, deviceId, status]
  ).then(() => {
    // DB confirmed — id will be resolved on next registry refresh
  }).catch(err => {
    logger.error({ err, deviceId }, 'Failed to auto-discover device');
  });
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
  }

  if (rows.length === 0) return;

  // Batch insert
  const values = [];
  const placeholders = [];
  let idx = 1;
  for (const r of rows) {
    placeholders.push(`(NOW(), $${idx}, $${idx+1}, $${idx+2}, $${idx+3})`);
    values.push(r.tenantId, r.deviceId, r.channel, r.value);
    idx += 4;
  }

  try {
    await db.query(
      `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
       VALUES ${placeholders.join(', ')}`,
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

  for (const [deviceId, state] of stateMap) {
    if (!state._dirty) continue;
    if (now - state._lastDbWrite < STATE_DEBOUNCE) continue;

    // Build last_state JSONB (only real state keys, no _ prefixed)
    const lastState = {};
    for (const [k, v] of Object.entries(state)) {
      if (!k.startsWith('_')) lastState[k] = v;
    }

    try {
      await db.query(
        `UPDATE devices SET last_state = $1, last_seen = NOW(), online = $2
         WHERE tenant_id = $3 AND mqtt_device_id = $4`,
        [JSON.stringify(lastState), state._online, state._tenantId, deviceId]
      );
      state._dirty      = false;
      state._lastDbWrite = now;
    } catch (err) {
      logger.error({ err, deviceId }, 'Failed to write device state');
    }
  }
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

// ── Periodic: Registry refresh (every 60s) ────────────────

async function refreshRegistries() {
  await loadRegistries();
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

      // Merge all state keys from DB
      if (row.last_state && typeof row.last_state === 'object') {
        for (const [k, v] of Object.entries(row.last_state)) {
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
function sendCommand(tenantSlug, deviceId, key, value) {
  if (!client || !connected) throw new Error('MQTT not connected');
  const topic = `modesp/v1/${tenantSlug}/${deviceId}/cmd/${key}`;
  client.publish(topic, String(value), { qos: 0 });
  logger.info({ tenantSlug, deviceId, key, value }, 'Command sent');
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

// ── Exports ───────────────────────────────────────────────

module.exports = {
  start, shutdown, isConnected,
  parseTopic, parseScalar,
  getDeviceState, getDeviceMeta, getDeviceRoutingSlug, sendCommand, sendJsonCommand,
  requestFullState,
  on:   emitter.on.bind(emitter),
  off:  emitter.off.bind(emitter),
  once: emitter.once.bind(emitter),
};
