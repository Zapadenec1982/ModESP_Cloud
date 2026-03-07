/**
 * REST API client for ModESP Cloud backend.
 * In dev mode, Vite proxies /api → localhost:3000.
 */

const BASE = '/api';

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

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
