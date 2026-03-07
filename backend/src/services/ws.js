'use strict';

const { WebSocketServer } = require('ws');
const mqttSvc = require('./mqtt');

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

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', onConnection);

  // Listen to MQTT events
  mqttSvc.on('state_delta',   onStateDelta);
  mqttSvc.on('alarm',         onAlarm);
  mqttSvc.on('device_status', onDeviceStatus);

  logger.info('WebSocket server attached on /ws');
}

// ── Connection handling ──────────────────────────────────

function onConnection(ws) {
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

function subscribe(ws, deviceId) {
  // Add to subscription map
  if (!subscriptions.has(deviceId)) {
    subscriptions.set(deviceId, new Set());
  }
  subscriptions.get(deviceId).add(ws);
  ws._subscriptions.add(deviceId);

  // Send current state snapshot
  const state = mqttSvc.getDeviceState(deviceId);
  const meta  = mqttSvc.getDeviceMeta(deviceId);

  sendJSON(ws, {
    type: 'state_full',
    device_id: deviceId,
    state: state || {},
    meta: meta || { online: false },
  });

  logger.debug({ deviceId, clients: subscriptions.get(deviceId).size }, 'WS subscribe');
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

function broadcast(deviceId, payload) {
  const clients = subscriptions.get(deviceId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(data);
    }
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
