'use strict';

const crypto  = require('crypto');
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
 * Global listeners — clients that receive tenant-wide events (alarms, pending devices).
 * Each client is added on 'subscribe_global' action.
 * @type {Set<import('ws').WebSocket>}
 */
const globalListeners = new Set();

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

  // Sweep expired one-time tickets periodically
  ticketSweep = setInterval(() => {
    const now = Date.now();
    for (const [t, e] of wsTickets) if (now > e.expires) wsTickets.delete(t);
  }, WS_TICKET_TTL_MS);
  if (ticketSweep.unref) ticketSweep.unref();

  // Listen to MQTT events
  mqttSvc.on('state_delta',       onStateDelta);
  mqttSvc.on('alarm',             onAlarm);
  mqttSvc.on('alarm_ack',         onAlarmAck);
  mqttSvc.on('device_status',     onDeviceStatus);
  mqttSvc.on('pending_device',    onPendingDevice);
  mqttSvc.on('backfill_complete', onBackfillComplete);
  mqttSvc.on('hint',              onHint);
  mqttSvc.on('work_order',        onWorkOrder);

  logger.info('WebSocket server attached on /ws');
}

// ── One-time WS tickets (P1-4) ───────────────────────────
// Short-lived single-use tickets, issued via authenticated REST (GET /api/ws-ticket),
// so the long-lived JWT never travels in the WS URL query string (where it would leak
// into nginx access logs / browser history / Referer).
const WS_TICKET_TTL_MS = 30000;
const wsTickets = new Map(); // ticket → { user, expires }
let ticketSweep = null;

function issueWsTicket(user) {
  const ticket = crypto.randomBytes(32).toString('hex');
  wsTickets.set(ticket, { user, expires: Date.now() + WS_TICKET_TTL_MS });
  return ticket;
}

function consumeWsTicket(ticket) {
  const entry = wsTickets.get(ticket);
  if (!entry) return null;
  wsTickets.delete(ticket);            // single-use
  if (Date.now() > entry.expires) return null;
  return entry.user;
}

// ── Auth verification for WS handshake ───────────────────

function verifyWsClient(info, cb) {
  try {
    const reqUrl = new URL(info.req.url, 'http://localhost');

    // Preferred: one-time ticket (not the JWT) in the URL
    const ticket = reqUrl.searchParams.get('ticket');
    if (ticket) {
      const user = consumeWsTicket(ticket);
      if (!user) { cb(false, 401, 'Invalid or expired ticket'); return; }
      info.req._user = user;
      cb(true);
      return;
    }

    // Legacy fallback: JWT in URL (deprecated — leaks into logs/Referer).
    // Kept so an already-loaded old client keeps working during a rolling deploy.
    const token = reqUrl.searchParams.get('token');
    if (!token) {
      cb(false, 401, 'Missing ticket');
      return;
    }
    logger.warn('WS auth via legacy URL token — client should switch to /api/ws-ticket');
    const payload = verifyAccessToken(token);
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

  if (!action) {
    return sendJSON(ws, { type: 'error', message: 'action required' });
  }

  switch (action) {
    case 'subscribe':
      if (!device_id) return sendJSON(ws, { type: 'error', message: 'device_id required' });
      subscribe(ws, device_id);
      break;
    case 'unsubscribe':
      if (!device_id) return sendJSON(ws, { type: 'error', message: 'device_id required' });
      unsubscribe(ws, device_id);
      break;
    case 'subscribe_global':
      globalListeners.add(ws);
      sendJSON(ws, { type: 'subscribed_global' });
      logger.debug({ user: ws._user?.email }, 'WS subscribe_global');
      break;
    case 'unsubscribe_global':
      globalListeners.delete(ws);
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
    // Superadmin sees all tenants — no tenant filter
    if (AUTH_ENABLED && ws._user && ws._user.role !== 'superadmin') {
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

    // Per-device access check for non-admin/non-superadmin users
    if (AUTH_ENABLED && ws._user && ws._user.role !== 'admin' && ws._user.role !== 'superadmin') {
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
  globalListeners.delete(ws);
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

function onAlarm({ tenantSlug, tenantId, deviceId, alarmCode, active, severity }) {
  const payload = {
    type: 'alarm',
    device_id: deviceId,
    alarm_code: alarmCode,
    active,
    severity,
    time: new Date().toISOString(),
  };
  // Send to device-specific subscribers
  broadcast(deviceId, payload);
  // Send to global listeners (Alarms page) with tenant context for filtering
  broadcastGlobal({ ...payload, tenant_slug: tenantSlug, tenant_id: tenantId || null });
}

function onAlarmAck({ tenantId, deviceId, alarmId, alarmCode, acknowledgedBy }) {
  const payload = {
    type: 'alarm_ack',
    alarm_id: alarmId,
    device_id: deviceId,
    alarm_code: alarmCode,
    acknowledged_by: acknowledgedBy,
    time: new Date().toISOString(),
  };
  broadcast(deviceId, payload);
  broadcastGlobal({ ...payload, tenant_id: tenantId || null });
}

function onDeviceStatus({ deviceId, online, lastSeen }) {
  broadcast(deviceId, {
    type: online ? 'device_online' : 'device_offline',
    device_id: deviceId,
    online,
    last_seen: lastSeen,
  });
}

// Maintenance hint opened/closed (plan epic 2.4) — services/maintenance.js
function onHint({ tenantId, tenantSlug, deviceId, hintId, ruleKey, severity, value, threshold, active }) {
  const payload = {
    type: 'hint',
    hint_id: hintId,
    device_id: deviceId,
    rule_key: ruleKey,
    severity,
    value,
    threshold,
    active,
    time: new Date().toISOString(),
  };
  broadcast(deviceId, payload);
  broadcastGlobal({ ...payload, tenant_slug: tenantSlug, tenant_id: tenantId || null });
}

// Work order created / assigned / started / closed / cancelled (plan epic 2.3)
function onWorkOrder({ tenantId, tenantSlug, orderId, deviceId, status, assignedTo, action: act }) {
  const payload = { type: 'work_order', order_id: orderId, device_id: deviceId || null, status, assigned_to: assignedTo || null, action: act, time: new Date().toISOString() };
  if (deviceId) broadcast(deviceId, payload);
  broadcastGlobal({ ...payload, tenant_slug: tenantSlug, tenant_id: tenantId || null });
}

function onPendingDevice({ deviceId, action: act }) {
  broadcastGlobal({
    type: 'pending_device',
    device_id: deviceId,
    action: act, // 'added', 'assigned', 'removed'
    time: new Date().toISOString(),
  });
}

function onBackfillComplete({ deviceId }) {
  broadcast(deviceId, {
    type: 'backfill_complete',
    device_id: deviceId,
    time: new Date().toISOString(),
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

/**
 * Broadcast to all global listeners with tenant isolation.
 * Superadmins receive all events; others only receive events matching their tenantId.
 */
function broadcastGlobal(payload) {
  logger.info({ type: payload.type, globalCount: globalListeners.size }, 'broadcastGlobal');
  if (globalListeners.size === 0) return;

  const data = JSON.stringify(payload);
  let sent = 0;
  for (const ws of globalListeners) {
    if (ws.readyState !== 1 || ws.bufferedAmount >= WS_BACKPRESSURE_BYTES) continue;

    // Tenant isolation: superadmin sees all; everyone else only events that
    // carry their own tenant_id. Default deny — an event type without tenant
    // context (pending_device, anything new) never leaves the platform scope.
    if (AUTH_ENABLED && ws._user && ws._user.role !== 'superadmin') {
      if (!payload.tenant_id || payload.tenant_id !== ws._user.tenantId) continue;
    }

    ws.send(data);
    sent++;
  }
  logger.info({ type: payload.type, sent }, 'broadcastGlobal sent');
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
  if (ticketSweep) { clearInterval(ticketSweep); ticketSweep = null; }
  if (wss) {
    for (const ws of wss.clients) {
      ws.close(1001, 'Server shutting down');
    }
    wss.close();
    logger.info('WebSocket server closed');
  }
}

module.exports = {
  attach, shutdown, issueWsTicket,
  // test/ws-isolation.test.js drives broadcastGlobal with fake sockets
  __test: { broadcastGlobal, globalListeners, setLogger(l) { logger = l; } },
};
