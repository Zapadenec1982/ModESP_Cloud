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
 * Connection status.
 */
export const wsConnected = writable(false);

/**
 * Current hash route.
 */
export const route = writable(parseHash());

function parseHash() {
  const hash = window.location.hash.slice(1) || '/';
  return hash;
}

// Listen for hash changes
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.set(parseHash());
  });
}

/**
 * Navigate by setting hash.
 * @param {string} path
 */
export function navigate(path) {
  window.location.hash = path;
}
