/**
 * Shared formatting utilities — locale-aware.
 * Uses i18n store for translations, reads locale synchronously via `get()`.
 */

import { get } from 'svelte/store';
import { locale, t } from './i18n.js';

/**
 * Human-readable relative time ("2 хв тому", "just now").
 * @param {string|Date} date
 * @returns {string}
 */
export function timeAgo(date) {
  if (!date) return '—'
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = Math.floor((now - then) / 1000)

  const tr = get(t)

  if (diff < 10) return tr('time.just_now')
  if (diff < 60) return tr('time.seconds_ago', diff)
  if (diff < 3600) return tr('time.minutes_ago', Math.floor(diff / 60))
  if (diff < 86400) return tr('time.hours_ago', Math.floor(diff / 3600))
  if (diff < 604800) return tr('time.days_ago', Math.floor(diff / 86400))
  return new Date(date).toLocaleDateString(tr('time.locale_code'))
}

/**
 * Format temperature with unit and color class.
 * @param {number} value
 * @param {number} [decimals=1]
 * @returns {{ text: string, colorClass: string }}
 */
export function formatTemp(value, decimals = 1) {
  if (value == null || isNaN(value)) return { text: '—', colorClass: '' }
  const text = `${Number(value).toFixed(decimals)}\u00B0C`
  let colorClass = ''
  if (value <= -10) colorClass = 'temp-cold'
  else if (value <= 10) colorClass = 'temp-normal'
  else if (value <= 20) colorClass = 'temp-warm'
  else colorClass = 'temp-hot'
  return { text, colorClass }
}

/**
 * Format duration in seconds to human readable.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—'
  const tr = get(t)
  const suf_s = tr('time.s')
  const suf_m = tr('time.min')
  const suf_h = tr('time.h')

  if (seconds < 60) return `${seconds}${suf_s}`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${suf_m} ${seconds % 60}${suf_s}`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}${suf_h} ${m}${suf_m}`
}

/**
 * How long ago something started, in whole units, coarsest two: "12 хв",
 * "3 год 20 хв", "2 дн 4 год". For the dashboard's «поза межею N хв» and the
 * durations in «Потребують уваги» — timeAgo() says "2 год тому", which reads as a
 * moment, while this reads as a span that is still running. Under a minute: "<1 хв".
 * @param {string|Date} since
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function durationSince(since, now = Date.now()) {
  if (!since) return '—'
  const then = new Date(since).getTime()
  if (Number.isNaN(then)) return '—'
  const tr = get(t)
  const minutes = Math.max(0, Math.floor((now - then) / 60000))
  if (minutes < 1) return `<1 ${tr('time.min')}`
  if (minutes < 60) return `${minutes} ${tr('time.min')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const m = minutes % 60
    return m ? `${hours} ${tr('time.h')} ${m} ${tr('time.min')}` : `${hours} ${tr('time.h')}`
  }
  const days = Math.floor(hours / 24)
  const h = hours % 24
  return h ? `${days} ${tr('time.d')} ${h} ${tr('time.h')}` : `${days} ${tr('time.d')}`
}

/**
 * Human-readable alarm label (alarm_code → display name).
 * Uses i18n dictionary key `alarm.{code}` with fallback to humanized code.
 * @param {string} code
 * @returns {string}
 */
export function alarmLabel(code) {
  const tr = get(t)
  const key = `alarm.${code}`
  const result = tr(key)
  // If t() returns the key itself, it means no translation found — fallback
  if (result === key) return code.replace(/_/g, ' ')
  return result
}

/**
 * Alarm severity from alarm code.
 * @param {string} code
 * @returns {'critical'|'warning'|'info'}
 */
export function alarmSeverity(code) {
  // Synced with backend mqtt.js alarmSeverity()
  if (['high_temp_alarm', 'low_temp_alarm', 'sensor1_alarm', 'sensor2_alarm'].includes(code)) return 'critical'
  if (['rate_alarm', 'short_cycle_alarm', 'rapid_cycle_alarm'].includes(code)) return 'info'
  return 'warning'  // door, pulldown, continuous_run
}

/**
 * Format file size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Format ISO date to local short format.
 * @param {string} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return '—'
  const tr = get(t)
  return new Date(date).toLocaleString(tr('time.locale_code'), {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}
