/**
 * REST API client for ModESP Cloud backend.
 * In dev mode, Vite proxies /api → localhost:3000.
 */

import { authUser, authEnabled, navigate } from './stores.js';

const BASE = '/api';

// ── Token management (access in memory, refresh in localStorage) ──

let accessToken = null;
let refreshToken = localStorage.getItem('modesp_refresh_token');
let refreshPromise = null;

function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  if (refresh) {
    localStorage.setItem('modesp_refresh_token', refresh);
  } else {
    localStorage.removeItem('modesp_refresh_token');
  }
}

export function getAccessToken() {
  return accessToken;
}

// ── Core request helper ─────────────────────────────────

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  // Inject Bearer token if available
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401 && refreshToken && !options._noRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry original request with new token
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers, _noRetry: true });
    } else {
      // Refresh failed — force logout
      clearAuth();
      navigate('/');
      throw Object.assign(new Error('Session expired'), { status: 401 });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const json = await res.json();
  return json.data;
}

// ── Auth API ────────────────────────────────────────────

export async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }

  const { data } = await res.json();
  setTokens(data.access_token, data.refresh_token);
  authUser.set(data.user);
  return data.user;
}

async function tryRefresh() {
  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;

      const { data } = await res.json();
      setTokens(data.access_token, data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function logout() {
  try {
    if (refreshToken) {
      await fetch(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    }
  } catch { /* best effort */ }
  clearAuth();
}

function clearAuth() {
  setTokens(null, null);
  authUser.set(null);
}

/**
 * Try to restore session from stored refresh token.
 * Returns true if successfully restored.
 */
export async function restoreSession() {
  if (!refreshToken) return false;

  const ok = await tryRefresh();
  if (!ok) {
    clearAuth();
    return false;
  }

  // Fetch user profile
  try {
    const user = await request('/users/me');
    authUser.set({ id: user.id, email: user.email, role: user.role });
    return true;
  } catch {
    clearAuth();
    return false;
  }
}

/**
 * Check if auth is enabled on the backend.
 */
export async function checkAuthEnabled() {
  try {
    const res = await fetch(`${BASE}/devices`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 401) {
      authEnabled.set(true);
      return true;
    }
    // No 401 → auth not enabled
    authEnabled.set(false);
    return false;
  } catch {
    authEnabled.set(false);
    return false;
  }
}

// ── Devices ──────────────────────────────────────────────

export function getDevices() {
  return request('/devices');
}

export function getDevice(id) {
  return request(`/devices/${id}`);
}

export function getPendingDevices() {
  return request('/devices/pending');
}

export function assignDevice(mqttId, { name, location } = {}) {
  return request(`/devices/pending/${mqttId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ name, location }),
  });
}

export function sendCommand(deviceId, key, value) {
  return request(`/devices/${deviceId}/command`, {
    method: 'POST',
    body: JSON.stringify({ key, value }),
  });
}

// ── Telemetry ────────────────────────────────────────────

export function getTelemetry(deviceId, { hours = 24, channels } = {}) {
  const params = new URLSearchParams({ hours });
  if (channels) params.set('channels', channels.join(','));
  return request(`/devices/${deviceId}/telemetry?${params}`);
}

// ── Alarms ───────────────────────────────────────────────

export function getAlarms({ active } = {}) {
  const params = new URLSearchParams();
  if (active !== undefined) params.set('active', active);
  const qs = params.toString();
  return request(`/alarms${qs ? '?' + qs : ''}`);
}

export function getDeviceAlarms(deviceId, { active } = {}) {
  const params = new URLSearchParams();
  if (active !== undefined) params.set('active', active);
  const qs = params.toString();
  return request(`/devices/${deviceId}/alarms${qs ? '?' + qs : ''}`);
}

// ── Notifications ───────────────────────────────────────

export function getSubscribers() {
  return request('/notifications/subscribers');
}

export function createSubscriber({ channel, address, label, device_filter }) {
  return request('/notifications/subscribers', {
    method: 'POST',
    body: JSON.stringify({ channel, address, label, device_filter }),
  });
}

export function deleteSubscriber(id) {
  return request(`/notifications/subscribers/${id}`, {
    method: 'DELETE',
  });
}

export function testNotification(subscriberId) {
  return request('/notifications/test', {
    method: 'POST',
    body: JSON.stringify({ subscriber_id: subscriberId }),
  });
}

export function getNotificationLog({ limit = 50 } = {}) {
  return request(`/notifications/log?limit=${limit}`);
}

// ── Users (admin) ───────────────────────────────────────

export function getUsers() {
  return request('/users');
}

export function createUser({ email, password, role }) {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, role }),
  });
}

export function updateUser(id, data) {
  return request(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteUser(id) {
  return request(`/users/${id}`, {
    method: 'DELETE',
  });
}
