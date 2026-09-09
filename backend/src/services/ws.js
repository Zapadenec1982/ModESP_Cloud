'use strict';

const crypto  = require('crypto');
const { WebSocketServer } = require('ws');
const mqttSvc = require('./mqtt');
const db      = require('./db');
const { verifyAccessToken } = require('./auth');
const { grantedDeviceId, grantedMqttIds } = require('../middleware/device-access');

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
 * How long a client's grant set is trusted before it is rebuilt. Grants change
 * rarely (an admin edits them), so a minute of staleness costs a technician at
 * most a minute before a newly granted device starts reporting live. The refresh
 * runs off the broadcast path; the current set keeps being used until it lands.
 */
const DEVICE_SCOPE_TTL_MS = 60_000;

/** Admins and superadmins see the whole organisation and need no per-device set. */
function scopedByGrants(user) {
  return AUTH_ENABLED && user && user.role !== 'admin' && user.role !== 'superadmin';
}

async function loadDeviceScope(ws) {
  ws._deviceScopeAt = Date.now();
  ws._deviceScope = await grantedMqttIds(ws._user.id, ws._user.tenantId);
}

/** Rebuild in the background when stale; never blocks a broadcast. */
function refreshDeviceScopeIfStale(ws) {
  if (ws._deviceScopeLoading) return;
  if (Date.now() - (ws._deviceScopeAt || 0) < DEVICE_SCOPE_TTL_MS) return;
  ws._deviceScopeLoading = true;
  loadDeviceScope(ws)
    .catch(err => logger.warn({ err, user: ws._user?.email }, 'WS device scope refresh failed'))
    .finally(() => { ws._deviceScopeLoading = false; });
}

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
      subscribeGlobal(ws);
      break;
    case 'unsubscribe_global':
      globalListeners.delete(ws);
      break;
    default:
      sendJSON(ws, { type: 'error', message: `Unknown action: ${action}` });
  }
}

/**
 * The tenant-wide feed the Alarms page and the map listen on. A client whose
 * access is limited to certain devices gets its grant set loaded BEFORE the
 * subscription is confirmed, so there is never a window in which events go out
 * unfiltered — broadcastGlobal fails closed on a socket with no set.
 */
async function subscribeGlobal(ws) {
  if (scopedByGrants(ws._user)) {
    try {
      await loadDeviceScope(ws);
    } catch (err) {
      logger.warn({ err, user: ws._user?.email }, 'WS subscribe_global: failed to load device scope');
      return sendJSON(ws, { type: 'error', message: 'Failed to load access scope' });
    }
  }
  globalListeners.add(ws);
  sendJSON(ws, { type: 'subscribed_global' });
  logger.debug({ user: ws._user?.email, scope: ws._deviceScope ? ws._deviceScope.size : 'all' }, 'WS subscribe_global');
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

    // Per-device access check for non-admin/non-superadmin users. The same
    // user_devices ∪ user_sites union REST uses: this used to read user_devices
    // alone, so a technician who reaches a device through a site grant could open
    // its page over REST and was refused live data on that very device.
    if (scopedByGrants(ws._user)) {
      const granted = await grantedDeviceId(ws._user.id, ws._user.tenantId, deviceId);
      if (!granted) {
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
function onHint({ tenantId, tenantSlug, deviceId, hintId, ruleKey, alarmCode, severity, value, threshold, active }) {
  const payload = {
    type: 'hint',
    hint_id: hintId,
    device_id: deviceId,
    rule_key: ruleKey,
    alarm_code: alarmCode || null,
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
 * May this client see one tenant-wide event?
 *
 * Tenant isolation alone was not enough. The global channel carries every alarm,
 * hint and work order of the organisation, and every signed-in user subscribes to
 * it, so a viewer holding no grant at all was fed the device id, alarm code and
 * severity of every cabinet in the company — while GET /alarms, filtered by the
 * same grants, showed them nothing. The feed now answers the same question the
 * REST list does.
 *
 * Fail closed: an event carrying no device_id reaches a grant-limited client only
 * when it is addressed to them personally (their own work order). Anything new
 * without device context stays inside the organisation's admins.
 */
function mayReceiveGlobal(ws, payload) {
  const user = ws._user;
  if (!AUTH_ENABLED || !user) return true;
  if (user.role === 'superadmin') return true;

  // Tenant isolation: default deny — an event without tenant context
  // (pending_device, anything new) never leaves the platform scope.
  if (!payload.tenant_id || payload.tenant_id !== user.tenantId) return false;
  if (!scopedByGrants(user)) return true;          // admin: the whole organisation

  refreshDeviceScopeIfStale(ws);
  if (!ws._deviceScope) return false;              // no set loaded → nothing goes out
  if (payload.device_id) return ws._deviceScope.has(payload.device_id);
  return payload.type === 'work_order' && payload.assigned_to === user.id;
}

/**
 * Broadcast to all global listeners, filtered per recipient by mayReceiveGlobal().
 */
function broadcastGlobal(payload) {
  // debug, not info: the hourly maintenance sweep emits one of these per hint
  // (a hundred lines per cycle on a demo fleet), and alarms already log themselves.
  logger.debug({ type: payload.type, globalCount: globalListeners.size }, 'broadcastGlobal');
  if (globalListeners.size === 0) return;

  const data = JSON.stringify(payload);
  let sent = 0;
  for (const ws of globalListeners) {
    if (ws.readyState !== 1 || ws.bufferedAmount >= WS_BACKPRESSURE_BYTES) continue;
    if (!mayReceiveGlobal(ws, payload)) continue;

    ws.send(data);
    sent++;
  }
  logger.debug({ type: payload.type, sent }, 'broadcastGlobal sent');
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
  __test: { broadcastGlobal, mayReceiveGlobal, loadDeviceScope, globalListeners, DEVICE_SCOPE_TTL_MS, setLogger(l) { logger = l; } },
};
