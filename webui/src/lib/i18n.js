/**
 * Lightweight i18n for ModESP Cloud.
 * No external dependencies — just Svelte stores.
 *
 * Usage in components:
 *   import { t } from '../lib/i18n.js'
 *   <span>{$t('nav.dashboard')}</span>
 *   <span>{$t('time.minutes_ago', n)}</span>
 */

import { writable, derived } from 'svelte/store';
import uk from './locales/uk.js';
import en from './locales/en.js';
import pl from './locales/pl.js';
import de from './locales/de.js';

const STORAGE_KEY = 'modesp-locale';
const SUPPORTED = ['uk', 'en', 'pl', 'de'];
const dictionaries = { uk, en, pl, de };

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch { /* private mode */ }

  // Browser language detection
  const lang = (navigator.language || '').toLowerCase();
  if (lang.startsWith('uk') || lang.startsWith('ru')) return 'uk';
  if (lang.startsWith('pl')) return 'pl';
  if (lang.startsWith('de')) return 'de';
  return 'en';
}

/** Current locale ('uk' | 'en' | 'pl' | 'de') */
export const locale = writable(detectLocale());

// Persist on change
locale.subscribe(val => {
  try { localStorage.setItem(STORAGE_KEY, val); } catch {}
});

/**
 * Derived translation function.
 * Supports dot-path keys and positional interpolation:
 *   $t('nav.dashboard')           → "Панель"
 *   $t('time.minutes_ago', 5)     → "5 хв тому"
 */
export const t = derived(locale, $locale => {
  const dict = dictionaries[$locale] || dictionaries.en;

  return function translate(key, ...args) {
    // Dot-path lookup
    const parts = key.split('.');
    let val = dict;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') { val = undefined; break; }
      val = val[p];
    }

    if (typeof val !== 'string') return key; // Fallback: return key itself

    // Positional interpolation: {0}, {1}, ...
    if (args.length > 0) {
      return val.replace(/\{(\d+)\}/g, (_, i) => {
        const idx = parseInt(i, 10);
        return idx < args.length ? String(args[idx]) : `{${i}}`;
      });
    }

    return val;
  };
});

/** Set locale programmatically */
export function setLocale(loc) {
  if (SUPPORTED.includes(loc)) locale.set(loc);
}

/** Get locale list for UI */
export const supportedLocales = [
  { code: 'uk', label: 'UA' },
  { code: 'en', label: 'EN' },
  { code: 'pl', label: 'PL' },
  { code: 'de', label: 'DE' },
];
