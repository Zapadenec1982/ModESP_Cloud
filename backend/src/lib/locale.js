'use strict';

/**
 * Locale and time-zone resolution for everything the platform sends out
 * (plan epic 2.11). One rule everywhere: the user's own choice, then the
 * organisation's, then the platform default.
 *
 *   user.locale   → tenant_settings.locale   → 'uk'
 *   user.timezone → tenant_settings.timezone → 'Europe/Kyiv'
 *
 * The WebUI keeps its own copy of the supported list in lib/i18n.js;
 * scripts/check-locales.js keeps the two in step.
 */

const SUPPORTED_LOCALES = ['uk', 'en', 'pl', 'de'];
const DEFAULT_LOCALE    = 'uk';
const DEFAULT_TIMEZONE  = 'Europe/Kyiv';

/** BCP 47 tag Intl expects for each UI locale. */
const INTL_TAG = { uk: 'uk-UA', en: 'en-GB', pl: 'pl-PL', de: 'de-DE' };

function isSupportedLocale(v) {
  return typeof v === 'string' && SUPPORTED_LOCALES.includes(v);
}

function isValidTimezone(v) {
  if (typeof v !== 'string' || !v) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: v }); return true; }
  catch { return false; }
}

/** First supported locale among the candidates, else the platform default. */
function pickLocale(...candidates) {
  for (const c of candidates) if (isSupportedLocale(c)) return c;
  return DEFAULT_LOCALE;
}

/** First valid IANA zone among the candidates, else the platform default. */
function pickTimezone(...candidates) {
  for (const c of candidates) if (isValidTimezone(c)) return c;
  return DEFAULT_TIMEZONE;
}

/** "05.09.2026, 14:30" in the locale's own order, in the given zone. */
function formatDateTime(iso, { locale = DEFAULT_LOCALE, timezone = DEFAULT_TIMEZONE } = {}) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(INTL_TAG[pickLocale(locale)], {
      timeZone: pickTimezone(timezone),
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return String(iso);
  }
}

const DURATION_UNITS = {
  uk: { less: '<1 хв',   min: 'хв',  hour: 'год' },
  en: { less: '<1 min',  min: 'min', hour: 'h' },
  pl: { less: '<1 min',  min: 'min', hour: 'godz.' },
  de: { less: '<1 Min.', min: 'Min.', hour: 'Std.' },
};

/** "2 год 15 хв" / "2 h 15 min" from milliseconds. */
function formatDuration(ms, locale = DEFAULT_LOCALE) {
  const u = DURATION_UNITS[pickLocale(locale)];
  const mins = Math.round(ms / 60000);
  if (mins < 1) return u.less;
  if (mins < 60) return `${mins} ${u.min}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} ${u.hour} ${m} ${u.min}` : `${h} ${u.hour}`;
}

module.exports = {
  SUPPORTED_LOCALES, DEFAULT_LOCALE, DEFAULT_TIMEZONE, INTL_TAG,
  isSupportedLocale, isValidTimezone, pickLocale, pickTimezone, formatDateTime, formatDuration,
};
