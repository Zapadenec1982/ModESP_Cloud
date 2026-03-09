import { writable, derived } from 'svelte/store';

/**
 * List of all devices (from REST API /devices).
 * @type {import('svelte/store').Writable<Array>}
 */
export const devices = writable([]);

/**
 * Currently selected device's full state (live updates via WS).
 * @type {import('svelte/store').Writable<Object|null>}
 */
export const selectedDevice = writable(null);

/**
 * Live state map for the selected device (merged from state_full + deltas).
 * @type {import('svelte/store').Writable<Object>}
 */
export const liveState = writable({});

/**
 * WebSocket connection status.
 */
export const wsConnected = writable(false);

// ── Auth stores ──────────────────────────────────────────

/**
 * Whether auth is enabled on the backend.
 */
export const authEnabled = writable(false);

/**
 * Current authenticated user ({id, email, role} or null).
 */
export const authUser = writable(null);

/**
 * Derived: is the user authenticated?
 */
export const isAuthenticated = derived(authUser, $u => $u !== null);

/**
 * Derived: is the user an admin? (true when auth disabled or role === 'admin' or 'superadmin')
 */
export const isAdmin = derived(
  [authEnabled, authUser],
  ([$enabled, $user]) => !$enabled || $user?.role === 'admin' || $user?.role === 'superadmin'
);

/**
 * Derived: is the user a superadmin? (cross-tenant access)
 */
export const isSuperAdmin = derived(
  [authEnabled, authUser],
  ([$enabled, $user]) => $enabled && $user?.role === 'superadmin'
);

/**
 * Derived: can the user write (edit devices, send commands, add service records)?
 * True for admin and technician, false for viewer.
 */
export const canWrite = derived(
  [authEnabled, authUser],
  ([$enabled, $user]) => !$enabled || $user?.role === 'admin' || $user?.role === 'superadmin' || $user?.role === 'technician'
);

// ── Tenant stores ───────────────────────────────────────

/**
 * Currently active tenant ({id, name, slug} or null).
 */
export const currentTenant = writable(null);

/**
 * All tenants the user has access to.
 */
export const availableTenants = writable([]);

/**
 * Derived: does the user belong to more than one tenant?
 */
export const hasMultipleTenants = derived(
  availableTenants, $t => $t.length > 1
);

// ── UI stores ────────────────────────────────────────────

/**
 * Sidebar collapsed state (desktop).
 */
export const sidebarCollapsed = writable(false);

/**
 * Sidebar open state (mobile overlay).
 */
export const sidebarOpen = writable(false);

// ── Legacy route compatibility ───────────────────────────
// Kept for any code that still imports `route` / `navigate`.
// svelte-spa-router handles routing, but these are safe no-ops.

export const route = writable('/');

export function navigate(path) {
  // svelte-spa-router uses hash-based routes
  window.location.hash = '#' + path;
}
