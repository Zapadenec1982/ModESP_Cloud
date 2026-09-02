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

export async function resetPassword(email, resetCode, newPassword) {
  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, reset_code: resetCode, new_password: newPassword }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'Password reset failed');
  return json.data;
}

/** POST /auth/forgot-password — always resolves; the server never reveals whether the email exists. */
export async function forgotPassword(email, lang) {
  return requestRaw('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email, lang }),
  });
}

// ── Invitation acceptance (public, #/invite/<token>) ─────

/** GET /auth/invite/:token → { email, role, tenant: {name, slug}, existing_user, expires_at } */
export function getInvite(token) {
  return requestRaw(`/auth/invite/${encodeURIComponent(token)}`);
}

/**
 * POST /auth/invite/:token/accept — sets the password (new account) or proves
 * the existing one, then signs the user in exactly like login().
 */
export async function acceptInvite(token, password, acceptTerms) {
  const data = await requestRaw(`/auth/invite/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: JSON.stringify({ password, accept_terms: acceptTerms === true }),
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
    const user = await request('/profile');
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

// ── WebSocket ────────────────────────────────────────────

// Short-lived one-time ticket for the WS handshake (P1-4). Issued over an
// authenticated REST call so the JWT never travels in the WS URL.
export function getWsTicket() {
  return request('/ws-ticket'); // → { ticket }
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

export function deleteDevicesBulk(ids) {
  return request('/devices/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) });
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
  return request('/profile/password', {
    method: 'PUT',
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
}

// ── Invitations (admin) ─────────────────────────────────

/** POST /users/invite → { id, email, role, tenant_id, existing_user, invite_url, email_sent, expires_at } */
export function inviteUser({ email, role, tenant_id, lang }) {
  return request('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email, role, tenant_id: tenant_id || undefined, lang }),
  });
}

export function getInvitations() {
  return request('/users/invitations');
}

export function revokeInvitation(id) {
  return request(`/users/invitations/${id}`, { method: 'DELETE' });
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
  return request('/profile/telegram-link', { method: 'POST' });
}

export function unlinkMyTelegram() {
  return request('/profile/telegram-link', { method: 'DELETE' });
}

// ── Password reset (admin) ──────────────────────────────

export function generatePasswordReset(userId) {
  return request(`/users/${userId}/password-reset`, { method: 'POST' });
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

export function deleteTenantsBulk(ids) {
  return request('/tenants/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) });
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

// ── Device Models ────────────────────────────────────────

export function getDeviceModels() {
  return request('/device-models');
}

export function createDeviceModel(data) {
  return request('/device-models', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateDeviceModel(id, data) {
  return request(`/device-models/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteDeviceModel(id) {
  return request(`/device-models/${id}`, {
    method: 'DELETE',
  });
}

// ── Energy ───────────────────────────────────────────────

export function getEnergySummary(deviceId, from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return request(`/devices/${deviceId}/energy/summary${qs ? '?' + qs : ''}`);
}

// ── Geo: query-string helper ─────────────────────────────

/**
 * `{ a: 1, b: '', c: null }` → `?a=1`.
 * `new URLSearchParams(obj)` would serialise `undefined`/`null` as the literal
 * strings "undefined"/"null", and the geo endpoints validate their parameters
 * strictly — `?region=undefined` is a filter that matches nothing, `?from=null`
 * is a 400.
 */
function geoQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const str = Array.isArray(value) ? value.join(',') : String(value);
    if (str.trim() === '') continue;
    qs.set(key, str);
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

// ── Sites (торгові точки) ────────────────────────────────

/**
 * GET /api/sites — every site the caller can see, with per-site device counters
 * already narrowed to the caller's RBAC.
 * @param {{search?, country_code?, region?, city?, tenant_id?}} params
 */
export function getSites(params = {}) {
  return request(`/sites${geoQuery(params)}`);
}

/** GET /api/sites/:id — one site plus its device list. */
export function getSite(id) {
  return request(`/sites/${id}`);
}

/**
 * POST /api/sites (admin). With an address but no pin the backend geocodes
 * inline, best effort — a geocoder outage never blocks the creation.
 */
export function createSite(data) {
  return request('/sites', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** PATCH /api/sites/:id (admin) — any subset of the editable fields. */
export function updateSite(id, data) {
  return request(`/sites/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

/**
 * DELETE /api/sites/:id (admin). Without `force` a site that still holds devices
 * answers 409 `site_has_devices` (with `device_count` in the error body) so the
 * UI can warn before re-sending; `force` detaches them instead.
 */
export function deleteSite(id, { force = false } = {}) {
  return request(`/sites/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}

/**
 * POST /api/sites/:id/geocode (admin) — force a re-geocode.
 * requestFull: `meta.geocoder` is 'ok' | 'disabled' | 'failed', which is the only
 * way the UI can say WHY nothing moved instead of silently no-oping.
 */
export function geocodeSite(id) {
  return requestFull(`/sites/${id}/geocode`, { method: 'POST' });
}

/**
 * GET /api/sites/geocode-status (admin) — { pending, geocoded, failed }.
 * requestFull: `meta.geocoder_enabled` / `meta.bulk_enabled` /
 * `meta.sweep_in_progress` drive the progress panel and the sweep button.
 */
export function getGeocodeStatus() {
  return requestFull('/sites/geocode-status');
}

/**
 * POST /api/sites/geocode-pending (admin) — background sweep over sites that
 * still have no position. Answers `{ queued, reason? }`; `reason` is
 * 'bulk_disabled' or 'sweep_in_progress' when nothing was queued.
 */
export function geocodePendingSites({ retryFailed = false } = {}) {
  return request(`/sites/geocode-pending${retryFailed ? '?retry_failed=true' : ''}`, {
    method: 'POST',
  });
}

// ── Site weather (Open-Meteo, ENV-gated) ─────────────────

/**
 * GET /api/sites/:id/weather — current conditions + hourly forecast.
 * requestFull: `data` is null whenever the feature is off or the answer is
 * unusable, and only `meta.weather` ('disabled' | 'no_coordinates' |
 * 'unavailable') tells those three apart.
 */
export function getSiteWeather(id, { hours } = {}) {
  return requestFull(`/sites/${id}/weather${geoQuery({ hours })}`);
}

/**
 * GET /api/sites/:id/weather/history — recorded outdoor conditions.
 * requestFull: `meta.truncated` says the row cap was hit, so the chart can label
 * a partial period instead of drawing it as complete.
 */
export function getSiteWeatherHistory(id, { from, to } = {}) {
  return requestFull(`/sites/${id}/weather/history${geoQuery({ from, to })}`);
}

// ── Nearest technicians (Part 2 §7.4) ────────────────────

/**
 * GET /api/sites/:id/nearest-technicians — staff with a home base, closest first.
 * requestFull: `meta.routing` is 'osrm' or null, which is what decides whether
 * the drive-time column means anything.
 */
export function getNearestTechnicians(id, { limit } = {}) {
  return requestFull(`/sites/${id}/nearest-technicians${geoQuery({ limit })}`);
}

// ── Public status links (Part 2 §7.7) ────────────────────

/** GET /api/sites/:id/public-links (admin) — metadata only, never the token. */
export function getSitePublicLinks(id) {
  return request(`/sites/${id}/public-links`);
}

/**
 * POST /api/sites/:id/public-links (admin).
 * The raw token comes back in `data.token` exactly ONCE — only its sha256 is
 * stored, so a link the admin does not copy here can never be recovered.
 */
export function createSitePublicLink(id, { label, expires_in_days } = {}) {
  return request(`/sites/${id}/public-links`, {
    method: 'POST',
    body: JSON.stringify({ label, expires_in_days }),
  });
}

/** DELETE /api/sites/:id/public-links/:linkId (admin) — revoke, not erase. */
export function revokeSitePublicLink(id, linkId) {
  return request(`/sites/${id}/public-links/${linkId}`, { method: 'DELETE' });
}

/**
 * GET /api/public/site — the unauthenticated status page.
 *
 * Deliberately a bare fetch and NOT request(): that helper attaches the Bearer
 * token, runs the refresh chain and calls navigate() on 401 — all of which are
 * wrong for a page a logged-out visitor opens. The token travels in the
 * X-Site-Token header rather than the path, so it appears in no server log and
 * in no Referer; the shareable URL keeps it in the hash fragment, which browsers
 * never send.
 *
 * Unknown, revoked and expired tokens all answer an identical 404 by design.
 */
export async function getPublicSite(token) {
  const res = await fetch(`${BASE}/public/site`, {
    headers: { 'Content-Type': 'application/json', 'X-Site-Token': token },
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

// ── Geocoding proxy (Nominatim, server-side only) ────────
//
// The browser never calls Nominatim directly — one identifying User-Agent, one
// rate limiter and one cache live on the backend, as its usage policy requires.
// `webui/src/lib/geo.js` carries its own copies of these two calls so the lazily
// loaded map components stay self-contained; these are the wrappers for pages
// that already import from this module.

/**
 * GET /api/geo/search — free-text address autocomplete.
 * requestFull: `meta.enabled` is false when GEOCODER_PROVIDER is unset, which is
 * what lets the UI hide the autocomplete instead of showing a box that never
 * answers — an empty `data` alone cannot distinguish that from "no matches".
 */
export function geoSearch(q, { limit } = {}) {
  return requestFull(`/geo/search${geoQuery({ q, limit })}`);
}

/**
 * GET /api/geo/reverse — coordinates to a structured address.
 * requestFull: `meta.enabled`, same reason as geoSearch().
 */
export function geoReverse(lat, lon) {
  return requestFull(`/geo/reverse${geoQuery({ lat, lon })}`);
}

// ── Fleet map ────────────────────────────────────────────

/**
 * GET /api/map/devices — one GeoJSON Feature per site, kept deliberately thin.
 * requestFull: `meta.ungeocoded_devices` is the "без координат" counter and
 * `meta.truncated` flags a clipped result — neither is inside `data`.
 */
export function getMapDevices(params = {}) {
  return requestFull(`/map/devices${geoQuery(params)}`);
}

/**
 * GET /api/map/filters — the option lists for the filter bar.
 * `tenants` is present only for a superadmin and `users` only for admin+, so
 * every consumer must tolerate a missing key.
 */
export function getMapFilters(params = {}) {
  return request(`/map/filters${geoQuery(params)}`);
}

/**
 * GET /api/map/alarm-heatmap — `[[lat, lon, weight], …]`, aggregated in SQL.
 * requestFull: `meta.max_weight` is load-bearing — L.heatLayer normalises against
 * its `max` option and without the real one every dataset renders as one blob.
 */
export function getAlarmHeatmap(params = {}) {
  return requestFull(`/map/alarm-heatmap${geoQuery(params)}`);
}

/**
 * GET /api/map/isochrones — coverage polygons around a point.
 * requestFull: `meta.approximate` is the visible "approximate" badge. Without an
 * ORS key the backend returns straight-line rings, and a planning decision must
 * never rest on a circle the user believes is a drive-time polygon.
 * @param {{lat:number, lon:number, minutes?:number[]|string}} params
 */
export function getIsochrones({ lat, lon, minutes } = {}) {
  return requestFull(`/map/isochrones${geoQuery({ lat, lon, minutes })}`);
}

/**
 * POST /api/map/route — service-round planning, max 25 stops.
 * requestFull: with OSRM unset or unreachable the backend still answers 200 with
 * a nearest-neighbour order, `legs: null` and `meta.optimized: false` — that flag
 * is what makes the UI label the result "orientation only, not drive-time
 * optimised" instead of presenting a guess as a plan.
 */
export function planRoute({ site_ids, start = null, roundtrip = false } = {}) {
  const body = { site_ids: site_ids || [] };
  if (start) body.start = start;
  if (roundtrip) body.roundtrip = true;
  return requestFull('/map/route', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Geo statistics ───────────────────────────────────────

/**
 * GET /api/stats/geo — the fleet's numbers cut by country / region / city / site.
 * requestFull: `meta.totals` is the footer row and `meta.group_by` / `meta.from`
 * / `meta.to` are what the page echoes back; `request()` would drop all of them.
 * A metric the backend could not compute cheaply comes back as null — render an
 * em dash, never a zero.
 */
export function getGeoStats(params = {}) {
  return requestFull(`/stats/geo${geoQuery(params)}`);
}

/**
 * GET /api/stats/geo/export.csv — the same query, rendered server-side, so the
 * file can never disagree with the screen.
 */
export function exportGeoStatsCsv(params = {}) {
  const groupBy = params.group_by || 'country';
  const fname = `geo_stats_${groupBy}_${new Date().toISOString().slice(0, 10)}.csv`;
  return downloadFile(`/stats/geo/export.csv${geoQuery(params)}`, fname);
}

// ── Site-level access grants (user_sites) ────────────────

/** GET /api/users/:id/sites (admin) — sites granted to one user. */
export function getUserSites(userId) {
  return request(`/users/${userId}/sites`);
}

/**
 * POST /api/users/:id/sites (admin) — grant one site. The site is validated
 * against the TARGET user's tenant, so a grant can never cross a tenant boundary.
 */
export function grantUserSite(userId, siteId) {
  return request(`/users/${userId}/sites`, {
    method: 'POST',
    body: JSON.stringify({ site_id: siteId }),
  });
}

/** DELETE /api/users/:id/sites/:siteId (admin) — revoke one site. */
export function revokeUserSite(userId, siteId) {
  return request(`/users/${userId}/sites/${siteId}`, { method: 'DELETE' });
}

// ── Own profile (home base, any role) ────────────────────
//
// /api/users is mounted behind authorize('admin'), so a technician cannot reach
// PUT /api/users/me at all — /api/profile is the self-service half of §7.4.

/** GET /api/profile — { id, email, role, base_latitude, base_longitude, base_address }. */
export function getProfile() {
  return request('/profile');
}

/**
 * PATCH /api/profile — home base only. `base_latitude` and `base_longitude` must
 * be sent (or cleared) together: a half-set base would place the technician on
 * the prime meridian.
 */
export function updateProfile(data) {
  return request('/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
