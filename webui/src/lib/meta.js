/**
 * Parameter metadata utilities.
 * Loads state_meta.json and provides helpers for the parameter editor.
 */
import { get } from 'svelte/store'
import { t } from './i18n.js'

let metaCache = null

/**
 * Fetch and cache parameter metadata from the backend.
 */
export async function loadMeta() {
  if (metaCache) return metaCache
  try {
    const res = await fetch('/api/meta')
    if (!res.ok) throw new Error('Failed to load metadata')
    const data = await res.json()
    metaCache = data.meta || data.data?.meta || data
    return metaCache
  } catch {
    // Fallback: try loading from static path
    try {
      const res = await fetch('/state_meta.json')
      const data = await res.json()
      metaCache = data.meta || data
      return metaCache
    } catch {
      return []
    }
  }
}

/**
 * Group parameters by category (first part of the key).
 * @param {Array} meta
 * @returns {Map<string, Array>}
 */
export function groupByCategory(meta) {
  const groups = new Map()
  for (const param of meta) {
    if (!param.writable) continue
    const cat = param.key.split('.')[0]
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(param)
  }
  return groups
}

/**
 * Human-readable label for a parameter key.
 * "thermostat.setpoint" → "Setpoint"
 * "protection.high_alarm_delay" → "High Alarm Delay"
 */
export function paramLabel(key) {
  const parts = key.split('.')
  const name = parts[parts.length - 1]
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Human-readable category name with i18n.
 * "thermostat" → "Термостат" (uk) / "Thermostat" (en)
 */
export function categoryLabel(cat) {
  const tr = get(t)
  const key = `device.param_category.${cat}`
  const result = tr(key)
  if (result !== key) return result
  return cat.charAt(0).toUpperCase() + cat.slice(1)
}

/**
 * Determine input type from metadata.
 */
export function inputType(param) {
  if (param.type === 'bool') return 'toggle'
  if (param.type === 'int' && param.max - param.min <= 5) return 'select'
  return 'number'
}

/**
 * Get unit hint for a parameter.
 */
export function paramUnit(key) {
  if (key.includes('temp') || key.includes('setpoint') || key.includes('limit')
    || key.includes('differential') || key.includes('fad_temp') || key.includes('demand_temp')
    || key.includes('fan_stop_temp') || key.includes('ds18b20_offset')
    || key.includes('night_setback') || key.includes('end_temp')
    || key.includes('pulldown_min_drop') || key.includes('max_rise_rate')) return '°C'
  if (key.includes('duration') || key.includes('delay') || key.includes('drip_time')
    || key.includes('fan_delay') || key.includes('stabilize') || key.includes('equalize')
    || key.includes('valve_delay') || key.includes('rate_duration')) return 'min'
  if (key.includes('min_off_time') || key.includes('min_on_time')
    || key.includes('startup_delay') || key.includes('min_compressor_run')) return 'min'
  if (key.includes('interval') && key.includes('sample')) return 's'
  if (key.includes('interval')) return 'h'
  if (key.includes('hours')) return 'h'
  if (key.includes('retention')) return 'h'
  if (key.includes('max_continuous_run') || key.includes('pulldown_timeout')) return 'min'
  if (key.includes('max_starts_hour')) return '/h'
  return ''
}
