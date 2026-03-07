/**
 * WebSocket client for ModESP Cloud.
 * Auto-reconnect with exponential backoff.
 * In dev mode, Vite proxies /ws → ws://localhost:3000/ws.
 */

/** @type {WebSocket | null} */
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;

/** @type {Set<string>} */
const activeSubscriptions = new Set();

/** @type {Map<string, Set<function>>} */
const listeners = new Map();

/**
 * Connect to the WebSocket server.
 */
export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;

  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log('[WS] Connected');
    reconnectDelay = 1000;
    // Re-subscribe to all active subscriptions
    for (const deviceId of activeSubscriptions) {
      socket.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      dispatch(msg.type, msg);
    } catch (e) {
      console.warn('[WS] Bad message:', event.data);
    }
  };

  socket.onclose = () => {
    console.log('[WS] Disconnected, reconnecting in', reconnectDelay, 'ms');
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

/**
 * Subscribe to a device's real-time updates.
 * @param {string} deviceId
 */
export function subscribe(deviceId) {
  activeSubscriptions.add(deviceId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
  }
}

/**
 * Unsubscribe from a device.
 * @param {string} deviceId
 */
export function unsubscribe(deviceId) {
  activeSubscriptions.delete(deviceId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: 'unsubscribe', device_id: deviceId }));
  }
}

/**
 * Register a listener for a message type.
 * @param {string} type   e.g. 'state_full', 'state_update', 'alarm', 'device_online', 'device_offline'
 * @param {function} fn
 * @returns {function} unsubscribe function
 */
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

/**
 * Disconnect WebSocket.
 */
export function disconnect() {
  clearTimeout(reconnectTimer);
  activeSubscriptions.clear();
  if (socket) {
    socket.onclose = null; // prevent reconnect
    socket.close();
    socket = null;
  }
}

// ── Internal ─────────────────────────────────────────────

function dispatch(type, msg) {
  const fns = listeners.get(type);
  if (fns) {
    for (const fn of fns) {
      try { fn(msg); } catch (e) { console.error('[WS] Listener error:', e); }
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    connect();
  }, reconnectDelay);
}
