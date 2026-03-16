/**
 * REST API client for ModESP Cloud backend.
 * In dev mode, Vite proxies /api → localhost:3000.
 */

import { authUser, authEnabled, currentTenant, availableTenants, navigate } from './stores.js';
import { toast } from './toast.js';

const BASE = '/api';

// ── Token management (access in memory, refresh in localStorage) ──

let accessToken = null;
let refreshToken = localStorage.getItem('modesp_refresh_token');
let refreshPromise = null;
let refreshTimer = null;

/**
 * Decode JWT payload without external dependencies.
 */
function parseJwtPayload(token) {
  try {
    const base64 = token.split('.')[1];
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseJwtExp(token) {
  const payload = parseJwtPayload(token);
  return payload ? { exp: payload.exp, iat: payload.iat } : null;
}

/**
 * Proactive token refresh — schedules refresh at ~80% of token lifetime.
 * This prevents tokens from silently expiring during active use.
 * Creates a self-maintaining chain: refresh → setTokens → schedule → refresh …
 */
function scheduleTokenRefresh() {
  clearTimeout(refreshTimer);
  if (!accessToken) return;

  const jwt = parseJwtExp(accessToken);
  if (!jwt?.exp) return;

  const now = Math.floor(Date.now() / 1000);
  const lifetime = jwt.exp - (jwt.iat || now);
  const remaining = jwt.exp - now;

  if (remaining <= 30) {
    // Token expiring/expired — refresh immediately
    console.log('[Auth] Token expiring in', remaining, 's — refreshing now');
    tryRefresh().then(ok => {
      if (!ok) {
        // Retry in 30s
        refreshTimer = setTimeout(() => scheduleTokenRefresh(), 30000);
      }
      // Success: setTokens() → scheduleTokenRefresh() chain continues
    });
    return;
  }

  // Refresh at 80% of lifetime or 60s before expiry, whichever is sooner
  const refreshAt = Math.min(lifetime * 0.8, remaining - 60);
  const refreshInMs = Math.max(refreshAt * 1000, 10000); // minimum 10s

  console.log(`[Auth] Proactive refresh in ${Math.round(refreshInMs / 1000)}s (token expires in ${remaining}s)`);

  refreshTimer = setTimeout(async () => {
    const ok = await tryRefresh();
    if (!ok) {
      console.warn('[Auth] Proactive refresh failed, retrying in 30s');
      refreshTimer = setTimeout(() => scheduleTokenRefresh(), 30000);
    }
    // Success path: tryRefresh → setTokens → scheduleTokenRefresh (auto-chain)
  }, refreshInMs);
}

function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  if (refresh) {
    localStorage.setItem('modesp_refresh_token', refresh);
  } else {
    localStorage.removeItem('modesp_refresh_token');
  }
  // Start/restart the proactive refresh chain
  scheduleTokenRefresh();
}

export function getAccessToken() {
  return accessToken;
}

// ── Core request helper ─────────────────────────────────

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  // Pre-refresh: if access token is gone but refresh token exists, restore first
  if (!accessToken && refreshToken && !options._noRetry) {
    await tryRefresh();
  }

  // Inject Bearer token if available
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401 (safety net — proactive refresh should prevent this)
  if (res.status === 401 && refreshToken && !options._noRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry original request with new token
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers, _noRetry: true });
    } else {
      // Refresh failed — force logout with notification
      clearAuth();
      toast.warning('Session expired — please log in again');
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

/**
 * Like request() but returns full JSON response (data + meta).
 * Used for paginated endpoints that return { data, meta }.
 */
async function requestFull(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  if (!accessToken && refreshToken && !options._noRetry) {
    await tryRefresh();
  }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401 && refreshToken && !options._noRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers, _noRetry: true });
    } else {
      clearAuth();
      toast.warning('Session expired — please log in again');
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

  return res.json();
}

/**
 * Raw POST without auth header (for unauthenticated endpoints like select-tenant).
 */
async function requestRaw(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  const res = await fetch(url, { ...options, headers });
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

  // Multiple tenants → return selection data (don't set tokens yet)
  if (data.require_tenant_select) {
    return {
      requireTenantSelect: true,
      pendingToken: data.pending_token,
      user: data.user,
      tenants: data.tenants,
    };
  }

  // Single tenant → direct login
  setTokens(data.access_token, data.refresh_token);
  authUser.set(data.user);
  if (data.tenant) {
    currentTenant.set(data.tenant);
    localStorage.setItem('modesp_last_tenant', data.tenant.id);
  }
  if (data.tenants) availableTenants.set(data.tenants);
  return { user: data.user };
}

/**
 * Complete login after tenant selection (multi-tenant flow).
 */
export async function selectTenant(pendingToken, tenantId) {
  const data = await requestRaw('/auth/select-tenant', {
    method: 'POST',
    body: JSON.stringify({ pending_token: pendingToken, tenant_id: tenantId }),
  });

  setTokens(data.access_token, data.refresh_token);
  authUser.set(data.user);
  if (data.tenant) {
    currentTenant.set(data.tenant);
    localStorage.setItem('modesp_last_tenant', data.tenant.id);
  }
  if (data.tenants) availableTenants.set(data.tenants);
  return data;
}

/**
 * Switch active tenant (requires valid session).
 */
export async function switchTenant(tenantId) {
  const data = await request('/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  });

  setTokens(data.access_token, data.refresh_token);
  if (data.tenant) {
    currentTenant.set(data.tenant);
    localStorage.setItem('modesp_last_tenant', data.tenant.id);
  }
  if (data.tenants) availableTenants.set(data.tenants);
  return data;
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
      if (data.tenants) availableTenants.set(data.tenants);
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
  clearTimeout(refreshTimer);
  setTokens(null, null);
  authUser.set(null);
  currentTenant.set(null);
  availableTenants.set([]);
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

    // Decode tenantId from JWT to set currentTenant
    if (accessToken) {
      const jwt = parseJwtPayload(accessToken);
      if (jwt?.tenantId) {
        let tenants;
        availableTenants.subscribe(v => { tenants = v; })();
        const active = tenants?.find(t => t.id === jwt.tenantId);
        if (active) currentTenant.set(active);
      }
    }
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

export function getDevices(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('/devices' + (qs ? `?${qs}` : ''));
}

export function getDevice(id) {
  return request(`/devices/${id}`);
}

export function getPendingDevices() {
  return request('/devices/pending');
}

export function assignDevice(mqttId, { name, location, model, serial_number, comment, manufactured_at, tenant_id } = {}) {
  return request(`/devices/pending/${mqttId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ name, location, model, serial_number, comment, manufactured_at, tenant_id }),
  });
}

export function deletePendingDevice(mqttId) {
  return request(`/devices/pending/${mqttId}`, { method: 'DELETE' });
}

export async function batchRegisterDevices(file, tenantId) {
  const formData = new FormData()
  formData.append('file', file)
  if (tenantId) formData.append('tenant_id', tenantId)

  const headers = {}
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const res = await fetch(`${BASE}/devices/pending/batch`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (body.errors) {
      const msgs = body.errors.slice(0, 5).map(e => `Row ${e.row}: ${e.message}`).join('; ')
      throw new Error(msgs + (body.errors.length > 5 ? ` (+${body.errors.length - 5} more)` : ''))
    }
    throw new Error(body.message || `HTTP ${res.status}`)
  }
  return (await res.json()).data
}

export function deleteDevice(id) {
  return request(`/devices/${id}`, { method: 'DELETE' });
}

export function resetDeviceToPending(id) {
  return request(`/devices/${id}/reset-pending`, { method: 'POST' });
}

export function updateDevice(id, data) {
  return request(`/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function sendCommand(deviceId, key, value) {
  return request(`/devices/${deviceId}/command`, {
    method: 'POST',
    body: JSON.stringify({ key, value }),
  });
}

/**
 * Request full state dump from device via MQTT.
 * The device clears its delta cache and re-publishes all 48 state keys.
 */
export function requestDeviceState(deviceId) {
  return request(`/devices/${deviceId}/request-state`, {
    method: 'POST',
  });
}

// ── MQTT Credentials ────────────────────────────────────

export function generateMqttCredentials(deviceId) {
  return request(`/devices/${deviceId}/mqtt-credentials`, {
    method: 'POST',
  });
}

export function revokeMqttCredentials(deviceId) {
  return request(`/devices/${deviceId}/mqtt-credentials`, {
    method: 'DELETE',
  });
}

// ── Service Records ─────────────────────────────────────

export function getServiceRecords(deviceId) {
  return request(`/devices/${deviceId}/service-records`);
}

export function createServiceRecord(deviceId, data) {
  return request(`/devices/${deviceId}/service-records`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteServiceRecord(deviceId, recordId) {
  return request(`/devices/${deviceId}/service-records/${recordId}`, {
    method: 'DELETE',
  });
}

// ── Telemetry ────────────────────────────────────────────

export function getTelemetry(deviceId, { hours, from, to, channels } = {}) {
  const params = new URLSearchParams();
  if (from && to) {
    params.set('from', from);
    params.set('to', to);
  } else {
    params.set('hours', hours || 24);
  }
  if (channels) params.set('channels', channels.join(','));
  return request(`/devices/${deviceId}/telemetry?${params}`);
}

export function getTelemetryStats(deviceId, { hours, from, to, channels, bucket = '1h' } = {}) {
  const params = new URLSearchParams({ bucket });
  if (from && to) {
    params.set('from', from);
    params.set('to', to);
  } else {
    params.set('hours', hours || 24);
  }
  if (channels) params.set('channels', channels.join(','));
  return request(`/devices/${deviceId}/telemetry/stats?${params}`);
}

// ── Alarms ───────────────────────────────────────────────

export function getAlarms({ active, from, to, limit, offset, severity } = {}) {
  const params = new URLSearchParams();
  if (active !== undefined) params.set('active', active);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (severity) params.set('severity', severity);
  const qs = params.toString();
  return request(`/alarms${qs ? '?' + qs : ''}`);
}

export function getDeviceAlarms(deviceId, { active, from, to, limit } = {}) {
  const params = new URLSearchParams();
  if (active !== undefined) params.set('active', active);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/devices/${deviceId}/alarms${qs ? '?' + qs : ''}`);
}

// ── Events ──────────────────────────────────────────────

export function getDeviceEvents(deviceId, { event_type, from, to, limit } = {}) {
  const params = new URLSearchParams();
  if (event_type) params.set('event_type', event_type);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/devices/${deviceId}/events${qs ? '?' + qs : ''}`);
}

export function getAlarmStats({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return request(`/alarms/stats${qs ? '?' + qs : ''}`);
}

// ── Fleet ───────────────────────────────────────────────

export function getFleetSummary() {
  return request('/fleet/summary');
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

export function createUser({ email, password, role, tenant_id }) {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, role, tenant_id }),
  });
}

export function updateUser(id, data) {
  return request(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function changePassword(oldPassword, newPassword) {
  return request('/users/me', {
    method: 'PUT',
    body: JSON.stringify({ old_password: oldPassword, password: newPassword }),
  });
}

export function deleteUser(id) {
  return request(`/users/${id}`, {
    method: 'DELETE',
  });
}

export function getUserDevices(userId) {
  return request(`/users/${userId}/devices`);
}

export function setUserDevices(userId, deviceIds) {
  return request(`/users/${userId}/devices`, {
    method: 'PUT',
    body: JSON.stringify({ device_ids: deviceIds }),
  });
}

// ── User Tenant Memberships (superadmin) ─────────────────

export function getUserTenants(userId) {
  return request(`/users/${userId}/tenants`);
}

export function addUserTenant(userId, tenantId) {
  return request(`/users/${userId}/tenants`, {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  });
}

export function removeUserTenant(userId, tenantId) {
  return request(`/users/${userId}/tenants/${tenantId}`, {
    method: 'DELETE',
  });
}

// ── Telegram linking ─────────────────────────────────────

export function generateTelegramLink(userId) {
  return request(`/users/${userId}/telegram-link`, { method: 'POST' });
}

export function generateMyTelegramLink() {
  return request('/users/me/telegram-link', { method: 'POST' });
}

export function unlinkMyTelegram() {
  return request('/users/me/telegram-link', { method: 'DELETE' });
}

// ── Tenants (superadmin) ─────────────────────────────────

export function getTenants() {
  return request('/tenants');
}

export function createTenant({ name, slug, plan }) {
  return request('/tenants', {
    method: 'POST',
    body: JSON.stringify({ name, slug, plan }),
  });
}

export function updateTenant(id, data) {
  return request(`/tenants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteTenant(id) {
  return request(`/tenants/${id}`, { method: 'DELETE' });
}

export function reassignDevice(deviceId, tenantId) {
  return request(`/devices/${deviceId}/reassign`, {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  });
}

// ── Firmware (Phase 6) ─────────────────────────────────

export function getFirmwares() {
  return request('/firmware');
}

export async function uploadFirmware(file, version, notes, boardType) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('version', version);
  if (notes) formData.append('notes', notes);
  if (boardType) formData.append('board_type', boardType);

  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}/firmware/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data;
}

export function deleteFirmware(id) {
  return request(`/firmware/${id}`, { method: 'DELETE' });
}

// ── OTA (Phase 6) ──────────────────────────────────────

export function deployOta(firmwareId, deviceId) {
  return request('/ota/deploy', {
    method: 'POST',
    body: JSON.stringify({ firmware_id: firmwareId, device_id: deviceId }),
  });
}

export function createRollout({ firmwareId, deviceIds, batchSize, batchIntervalS, failThresholdPct }) {
  return request('/ota/rollout', {
    method: 'POST',
    body: JSON.stringify({
      firmware_id: firmwareId,
      device_ids: deviceIds,
      batch_size: batchSize,
      batch_interval_s: batchIntervalS,
      fail_threshold_pct: failThresholdPct,
    }),
  });
}

export function getOtaJobs({ status, rolloutId } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (rolloutId) params.set('rollout_id', rolloutId);
  const qs = params.toString();
  return request(`/ota/jobs${qs ? '?' + qs : ''}`);
}

export function getRollouts() {
  return request('/ota/rollouts');
}

export function getRollout(id) {
  return request(`/ota/rollouts/${id}`);
}

export function pauseRollout(id) {
  return request(`/ota/rollouts/${id}/pause`, { method: 'POST' });
}

export function resumeRollout(id) {
  return request(`/ota/rollouts/${id}/resume`, { method: 'POST' });
}

export function cancelRollout(id) {
  return request(`/ota/rollouts/${id}/cancel`, { method: 'POST' });
}

// ── Audit Log ────────────────────────────────────────────

export async function getAuditLog(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  }
  const query = qs.toString();
  // Need full response (data + meta) — use requestFull
  return requestFull(`/audit-log${query ? '?' + query : ''}`);
}

// ── Data Export (CSV / PDF) ──────────────────────────────

async function downloadFile(path, filename) {
  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Export failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportTelemetryCsv(deviceId, from, to) {
  const qs = new URLSearchParams({ from, to }).toString();
  const fname = `telemetry_${deviceId}_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`;
  return downloadFile(`/devices/${deviceId}/telemetry/export.csv?${qs}`, fname);
}

export function exportTelemetryPdf(deviceId, from, to, bucket = '1h') {
  const qs = new URLSearchParams({ from, to, bucket }).toString();
  const fname = `haccp_${deviceId}_${from.slice(0, 10)}_${to.slice(0, 10)}.pdf`;
  return downloadFile(`/devices/${deviceId}/telemetry/export.pdf?${qs}`, fname);
}

export function exportAlarmsCsv(from, to, severity) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (severity) params.set('severity', severity);
  const qs = params.toString();
  const fname = `alarms_${(from || '').slice(0, 10)}_${(to || '').slice(0, 10)}.csv`;
  return downloadFile(`/alarms/export.csv${qs ? '?' + qs : ''}`, fname);
}

export function exportDevicesCsv() {
  const fname = `devices_${new Date().toISOString().slice(0, 10)}.csv`;
  return downloadFile('/devices/export.csv', fname);
}
