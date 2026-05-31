/**
 * WebSocket client for ModESP Cloud.
 * Auto-reconnect with exponential backoff.
 * In dev mode, Vite proxies /ws → ws://localhost:3000/ws.
 */

import { getAccessToken, restoreSession, getWsTicket } from './api.js';
import { wsConnected, authEnabled } from './stores.js';
import { get } from 'svelte/store';

/** @type {WebSocket | null} */
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 30000;
let consecutiveAbnormal = 0;   // count of back-to-back 1006 closes

/** @type {Set<string>} */
const activeSubscriptions = new Set();

/** @type {Map<string, Set<function>>} */
const listeners = new Map();

/**
 * Connect to the WebSocket server.
 */
export async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/ws`;

  // Auth: fetch a short-lived one-time ticket over authenticated REST and pass
  // THAT in the URL — never the JWT (which would leak into logs/Referer).
  if (get(authEnabled)) {
    try {
      const { ticket } = await getWsTicket();
      url += `?ticket=${encodeURIComponent(ticket)}`;
    } catch (e) {
      console.warn('[WS] Failed to obtain ticket; will retry', e);
      scheduleReconnect();
      return;
    }
  }

  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log('[WS] Connected');
    wsConnected.set(true);
    reconnectDelay = 1000;
    consecutiveAbnormal = 0;
    // Re-subscribe to all active subscriptions
    for (const deviceId of activeSubscriptions) {
      socket.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
    }
    // Re-subscribe to global events if previously subscribed
    if (globalSubscribed) {
      socket.send(JSON.stringify({ action: 'subscribe_global' }));
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

  socket.onclose = (event) => {
    wsConnected.set(false);

    // Explicit auth-rejection codes always escalate to a token refresh.
    const isAuthCode = event.code === 4401 || event.code === 1008;
    // 1006 (abnormal) fires for ordinary network blips, server restarts and laptop
    // sleep — not just auth rejection. Don't burn a token refresh + /users/me on the
    // first one; only escalate after several back-to-back 1006s (likely a stale token).
    if (event.code === 1006) consecutiveAbnormal++; else consecutiveAbnormal = 0;
    const staleTokenLikely = consecutiveAbnormal >= 3 && get(authEnabled) && getAccessToken();

    if (isAuthCode || staleTokenLikely) {
      console.log('[WS] Auth failed (code:', event.code, ', streak:', consecutiveAbnormal, '), refreshing token');
      consecutiveAbnormal = 0;
      handleAuthReconnect();
      return;
    }

    // Otherwise just reconnect — proactive refresh in api.js keeps the token fresh.
    console.log('[WS] Disconnected (code:', event.code, '), reconnecting in', reconnectDelay, 'ms');
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

/**
 * Reconnect WebSocket (e.g. after token refresh).
 */
export function reconnect() {
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  clearTimeout(reconnectTimer);
  reconnectDelay = 1000;
  connect();
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
 * Subscribe to global (tenant-wide) events: alarms, pending devices.
 * Call once after connect — re-subscribes automatically on reconnect.
 */
let globalSubscribed = false;

export function subscribeGlobal() {
  globalSubscribed = true;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: 'subscribe_global' }));
  }
}

/**
 * Disconnect WebSocket.
 */
export function disconnect() {
  clearTimeout(reconnectTimer);
  activeSubscriptions.clear();
  globalSubscribed = false;
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

/**
 * Handle WS disconnection due to auth failure:
 * try to refresh the token, then reconnect.
 */
async function handleAuthReconnect() {
  if (!get(authEnabled)) {
    // Auth not enabled — just reconnect normally
    scheduleReconnect();
    return;
  }

  try {
    const restored = await restoreSession();
    if (restored) {
      console.log('[WS] Token refreshed, reconnecting');
      reconnectDelay = 1000;
      connect();
    } else {
      console.log('[WS] Token refresh failed — session expired');
      // Don't reconnect; user needs to log in again
    }
  } catch {
    console.log('[WS] Token refresh error, retrying later');
    scheduleReconnect();
  }
}
