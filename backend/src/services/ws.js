'use strict';

const { WebSocketServer } = require('ws');
const mqttSvc = require('./mqtt');
const db      = require('./db');
const { verifyAccessToken } = require('./auth');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

let wss    = null;
let logger = null;

/**
 * Subscription map: deviceId → Set<WebSocket>
 * @type {Map<string, Set<import('ws').WebSocket>>}
 */
const subscriptions = new Map();

/**
 * Attach WebSocket server to an existing http.Server.
 * @param {import('http').Server} server
 * @param {import('pino').Logger}  log
 */
function attach(server, log) {
  logger = log;

  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: AUTH_ENABLED ? verifyWsClient : undefined,
  });

  wss.on('connection', onConnection);

  // Listen to MQTT events
  mqttSvc.on('state_delta',   onStateDelta);
  mqttSvc.on('alarm',         onAlarm);
  mqttSvc.on('device_status', onDeviceStatus);

  logger.info('WebSocket server attached on /ws');
}

// ── JWT verification for WS handshake ────────────────────

function verifyWsClient(info, cb) {
  try {
    const reqUrl = new URL(info.req.url, 'http://localhost');
    const token  = reqUrl.searchParams.get('token');
    if (!token) {
      cb(false, 401, 'Missing token');
      return;
    }
    const payload = verifyAccessToken(token);
    // Attach user info to the request for onConnection
    info.req._user = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      tenantId: payload.tenantId,
    };
    cb(true);
  } catch (err) {
    logger.warn({ err: err.message }, 'WS auth failed');
    cb(false, 401, 'Invalid token');
  }
}

// ── Connection handling ──────────────────────────────────

function onConnection(ws, req) {
  // Attach user info from JWT verification
  if (AUTH_ENABLED && req._user) {
    ws._user = req._user;
  }

  ws._subscriptions = new Set();   // track which devices this client follows

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(ws, msg);
    } catch (err) {
      sendJSON(ws, { type: 'error', message: 'Invalid JSON' });
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));

  sendJSON(ws, { type: 'welcome', message: 'ModESP Cloud WebSocket' });
}

/**
 * Handle incoming client messages.
 * Actions: subscribe, unsubscribe
 */
function handleClientMessage(ws, msg) {
  const { action, device_id } = msg;

  if (!action || !device_id) {
    return sendJSON(ws, { type: 'error', message: 'action and device_id required' });
  }

  switch (action) {
    case 'subscribe':
      subscribe(ws, device_id);
      break;
    case 'unsubscribe':
      unsubscribe(ws, device_id);
      break;
    default:
      sendJSON(ws, { type: 'error', message: `Unknown action: ${action}` });
  }
}

async function subscribe(ws, deviceId) {
  // ── Tenant isolation + per-device RBAC ──
  let dbState = {};
  try {
    const params = [deviceId];
    let sql = 'SELECT d.id, d.last_state, d.tenant_id FROM devices d WHERE d.mqtt_device_id = $1';
    if (AUTH_ENABLED && ws._user) {
      sql += ' AND d.tenant_id = $2';
      params.push(ws._user.tenantId);
    }
    sql += ' LIMIT 1';
    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
      return sendJSON(ws, { type: 'error', message: 'Device not found or access denied' });
    }
    if (rows[0].last_state) {
      dbState = rows[0].last_state;
    }

    // Per-device access check for non-admin users
    if (AUTH_ENABLED && ws._user && ws._user.role !== 'admin') {
      const access = await db.query(
        'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2',
        [ws._user.id, rows[0].id]
      );
      if (access.rows.length === 0) {
        return sendJSON(ws, { type: 'error', message: 'Device access denied' });
      }
    }
  } catch (err) {
    logger.warn({ err, deviceId }, 'Failed to load device state for WS subscribe');
    return sendJSON(ws, { type: 'error', message: 'Failed to load device' });
  }

  // Add to subscription map
  if (!subscriptions.has(deviceId)) {
    subscriptions.set(deviceId, new Set());
  }
  subscriptions.get(deviceId).add(ws);
  ws._subscriptions.add(deviceId);

  // Send current state snapshot: merge DB last_state with live stateMap
  const liveState = mqttSvc.getDeviceState(deviceId);
  const meta      = mqttSvc.getDeviceMeta(deviceId);

  // DB state as base, live stateMap overrides (fresher data wins)
  const mergedState = { ...dbState, ...(liveState || {}) };

  sendJSON(ws, {
    type: 'state_full',
    device_id: deviceId,
    state: mergedState,
    meta: meta || { online: false },
  });

  // If device is online but live stateMap has few keys (missed initial dump),
  // request full state republish from device
  const liveKeyCount = liveState
    ? Object.keys(liveState).filter(k => !k.startsWith('_')).length
    : 0;
  if (meta && meta.online && liveKeyCount < 10) {
    const tenantSlug = liveState?._tenantSlug || 'pending';
    mqttSvc.requestFullState(tenantSlug, deviceId);
  }

  logger.debug({ deviceId, clients: subscriptions.get(deviceId).size, liveKeyCount }, 'WS subscribe');
}

function unsubscribe(ws, deviceId) {
  const clients = subscriptions.get(deviceId);
  if (clients) {
    clients.delete(ws);
    if (clients.size === 0) subscriptions.delete(deviceId);
  }
  ws._subscriptions.delete(deviceId);
  logger.debug({ deviceId }, 'WS unsubscribe');
}

function cleanup(ws) {
  for (const deviceId of ws._subscriptions) {
    const clients = subscriptions.get(deviceId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) subscriptions.delete(deviceId);
    }
  }
  ws._subscriptions.clear();
}

// ── MQTT event handlers → broadcast ──────────────────────

function onStateDelta({ deviceId, changes }) {
  broadcast(deviceId, {
    type: 'state_update',
    device_id: deviceId,
    changes,
    time: new Date().toISOString(),
  });
}

function onAlarm({ deviceId, alarmCode, active, severity }) {
  broadcast(deviceId, {
    type: 'alarm',
    device_id: deviceId,
    alarm_code: alarmCode,
    active,
    severity,
    time: new Date().toISOString(),
  });
}

function onDeviceStatus({ deviceId, online, lastSeen }) {
  broadcast(deviceId, {
    type: online ? 'device_online' : 'device_offline',
    device_id: deviceId,
    online,
    last_seen: lastSeen,
  });
}

// ── Utilities ────────────────────────────────────────────

const WS_BACKPRESSURE_BYTES = 65536; // 64 KB

function broadcast(deviceId, payload) {
  const clients = subscriptions.get(deviceId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1 && ws.bufferedAmount < WS_BACKPRESSURE_BYTES) {
      ws.send(data);
    }
    // Skip slow clients to prevent memory buildup
  }
}

function sendJSON(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Gracefully close all connections.
 */
function shutdown() {
  if (wss) {
    for (const ws of wss.clients) {
      ws.close(1001, 'Server shutting down');
    }
    wss.close();
    logger.info('WebSocket server closed');
  }
}

module.exports = { attach, shutdown };
