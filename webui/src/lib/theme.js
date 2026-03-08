/**
 * Theme store — dark / light / system.
 * Syncs to <html data-theme="...">, persists in localStorage.
 */

import { writable, get } from 'svelte/store';

const STORAGE_KEY = 'modesp-theme';
const VALID = ['dark', 'light', 'system'];

function getInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && VALID.includes(saved)) return saved;
  } catch { /* SSR or private mode */ }
  return 'dark';
}

/** @type {import('svelte/store').Writable<'dark'|'light'|'system'>} */
export const themeMode = writable(getInitial());

/** Resolved effective theme (always 'dark' or 'light') */
export const effectiveTheme = writable('dark');

// ── Media query for system preference ──
const mql = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

function resolve(mode) {
  if (mode === 'system') {
    return mql?.matches ? 'light' : 'dark';
  }
  return mode;
}

function apply(effective) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', effective);
  effectiveTheme.set(effective);
}

// React to store changes
themeMode.subscribe(mode => {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  apply(resolve(mode));
});

// React to OS preference changes (only matters in 'system' mode)
if (mql) {
  mql.addEventListener('change', () => {
    if (get(themeMode) === 'system') {
      apply(resolve('system'));
    }
  });
}

/** Toggle between dark ↔ light (skips system) */
export function toggleTheme() {
  themeMode.update(m => {
    const eff = resolve(m);
    return eff === 'dark' ? 'light' : 'dark';
  });
}

// Apply on module load
apply(resolve(getInitial()));
