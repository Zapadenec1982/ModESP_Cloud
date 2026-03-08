/**
 * Shared formatting utilities.
 * Extracted from duplicated code across pages.
 */

/**
 * Human-readable relative time ("2 хв тому", "щойно").
 * @param {string|Date} date
 * @returns {string}
 */
export function timeAgo(date) {
  if (!date) return '—'
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = Math.floor((now - then) / 1000)

  if (diff < 10) return 'щойно'
  if (diff < 60) return `${diff} сек тому`
  if (diff < 3600) return `${Math.floor(diff / 60)} хв тому`
  if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`
  if (diff < 604800) return `${Math.floor(diff / 86400)} дн тому`
  return new Date(date).toLocaleDateString('uk-UA')
}

/**
 * Format temperature with unit and color class.
 * @param {number} value
 * @param {number} [decimals=1]
 * @returns {{ text: string, colorClass: string }}
 */
export function formatTemp(value, decimals = 1) {
  if (value == null || isNaN(value)) return { text: '—', colorClass: '' }
  const text = `${value.toFixed(decimals)}\u00B0C`
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
  if (seconds < 60) return `${seconds}с`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}хв ${seconds % 60}с`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}год ${m}хв`
}

/**
 * Human-readable alarm label (alarm_code → display name).
 */
const ALARM_LABELS = {
  high_temp_alarm:       'Висока температура',
  low_temp_alarm:        'Низька температура',
  sensor1_alarm:         'Датчик 1',
  sensor2_alarm:         'Датчик 2',
  door_alarm:            'Двері відкриті',
  short_cycle_alarm:     'Короткий цикл',
  rapid_cycle_alarm:     'Часті цикли',
  continuous_run_alarm:  'Безперервна робота',
  pulldown_alarm:        'Збій зниження',
  rate_alarm:            'Швидкість зміни',
}

/**
 * Get human-readable alarm label.
 * @param {string} code
 * @returns {string}
 */
export function alarmLabel(code) {
  return ALARM_LABELS[code] || code.replace(/_/g, ' ')
}

/**
 * Alarm severity from alarm code.
 * @param {string} code
 * @returns {'critical'|'warning'|'info'}
 */
export function alarmSeverity(code) {
  if (['high_temp_alarm', 'low_temp_alarm', 'sensor1_alarm', 'sensor2_alarm'].includes(code)) return 'critical'
  if (['door_alarm', 'continuous_run_alarm', 'pulldown_alarm'].includes(code)) return 'warning'
  return 'info'
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
  return new Date(date).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}
