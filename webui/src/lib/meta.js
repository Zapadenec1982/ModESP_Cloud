/**
 * Parameter metadata utilities.
 * Loads state_meta.json and provides helpers for the parameter editor.
 *
 * What a parameter is called, what it means, in which unit and — for the
 * mode parameters — what each numeric choice stands for, all come from the
 * controller's own module manifests (ModESP firmware,
 * modules/<module>/manifest.json and i18n/*.json), copied into the four
 * locales under device.param_labels / param_desc / param_options / units.
 * The cloud's state_meta.json carries only the types and the ranges.
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

/** Preferred display order for parameter categories */
const CATEGORY_ORDER = ['thermostat', 'defrost', 'protection']

/**
 * Group parameters by category (first part of the key).
 * Returns groups in CATEGORY_ORDER; unlisted categories are appended at the end.
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
  // Re-order according to CATEGORY_ORDER
  const ordered = new Map()
  for (const cat of CATEGORY_ORDER) {
    if (groups.has(cat)) {
      ordered.set(cat, groups.get(cat))
      groups.delete(cat)
    }
  }
  // Append remaining categories
  for (const [cat, params] of groups) {
    ordered.set(cat, params)
  }
  return ordered
}

/** "thermostat.setpoint" → "thermostat_setpoint": the i18n key of a parameter */
const slug = (key) => key.replace(/\./g, '_')

/** A translation, or null when the dictionary has no such key */
function lookup(i18nKey) {
  const result = get(t)(i18nKey)
  return result === i18nKey ? null : result
}

/**
 * Human-readable label for a parameter key with i18n support.
 * Looks up device.param_labels.<full_key> first, falls back to title-cased suffix.
 */
export function paramLabel(key) {
  const result = lookup(`device.param_labels.${slug(key)}`)
  if (result) return result
  // Fallback: title-case the suffix
  const parts = key.split('.')
  const name = parts[parts.length - 1]
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** One line on what the parameter does (device.param_desc.*), or '' */
export function paramDescription(key) {
  return lookup(`device.param_desc.${slug(key)}`) || ''
}

/**
 * Human-readable category name with i18n.
 * "thermostat" → "Термостат" (uk) / "Cooling" (en)
 */
export function categoryLabel(cat) {
  const result = lookup(`device.param_category.${cat}`)
  if (result) return result
  return cat.charAt(0).toUpperCase() + cat.slice(1)
}

/**
 * The unit of every writable parameter, as the controller's manifests state
 * it. Not guessed from the key name: cond_fan_delay and valve_delay are
 * seconds, min_compressor_run too, max_rise_rate is degrees per minute and
 * max_starts_hour is a count — the name-based guess had them all as minutes
 * or degrees. The code is the same in every language; device.units.<code>
 * holds the text.
 */
const PARAM_UNITS = {
  'protection.high_limit': 'c', 'protection.low_limit': 'c', 'protection.pulldown_min_drop': 'c',
  'protection.high_alarm_delay': 'min', 'protection.low_alarm_delay': 'min', 'protection.door_delay': 'min',
  'protection.post_defrost_delay': 'min', 'protection.max_continuous_run': 'min', 'protection.pulldown_timeout': 'min',
  'protection.rate_duration': 'min',
  'protection.min_compressor_run': 's',
  'protection.max_starts_hour': 'per_h',
  'protection.max_rise_rate': 'c_per_min',
  'protection.compressor_hours': 'h',
  'thermostat.setpoint': 'c', 'thermostat.differential': 'c', 'thermostat.fan_stop_temp': 'c',
  'thermostat.fan_stop_hyst': 'c', 'thermostat.night_setback': 'c',
  'thermostat.min_off_time': 'min', 'thermostat.min_on_time': 'min', 'thermostat.startup_delay': 'min',
  'thermostat.safety_run_on': 'min', 'thermostat.safety_run_off': 'min',
  'thermostat.cond_fan_delay': 's',
  'thermostat.night_start': 'h', 'thermostat.night_end': 'h',
  'defrost.end_temp': 'c', 'defrost.demand_temp': 'c', 'defrost.fad_temp': 'c',
  'defrost.interval': 'h',
  'defrost.max_duration': 'min', 'defrost.drip_time': 'min', 'defrost.fan_delay': 'min',
  'defrost.stabilize_time': 'min', 'defrost.equalize_time': 'min',
  'defrost.valve_delay': 's',
}

/** The unit code of a parameter ('c' | 'min' | 's' | 'h' | 'per_h' | 'c_per_min' | '') */
export function paramUnitCode(key) {
  return PARAM_UNITS[key] || ''
}

/**
 * Get unit hint for a parameter, in the current language.
 */
export function paramUnit(key) {
  const code = PARAM_UNITS[key]
  if (!code) return ''
  return lookup(`device.units.${code}`) || code
}

/** The name of one choice of a mode parameter, or null when it is a plain number */
export function optionLabel(key, value) {
  if (value === undefined || value === null || value === '') return null
  return lookup(`device.param_options.${slug(key)}.${value}`)
}

/**
 * The named choices of a mode parameter — evaporator fan mode, defrost type
 * and the like — as [{ value, label }], limited to the range the cloud
 * accepts (state_meta min…max). Empty for a plain number.
 */
export function paramOptions(param) {
  const lo = typeof param.min === 'number' ? param.min : 0
  const hi = typeof param.max === 'number' ? Math.min(param.max, lo + 15) : lo + 15
  const out = []
  for (let v = lo; v <= hi; v++) {
    const label = optionLabel(param.key, v)
    if (label) out.push({ value: v, label })
  }
  return out
}

/**
 * Determine input type from metadata.
 */
export function inputType(param) {
  if (param.type === 'bool') return 'toggle'
  if (param.type === 'int' && paramOptions(param).length > 0) return 'select'
  return 'number'
}

/**
 * What a live value reads as: on/off for a switch, the choice's name for a
 * mode, the number with the parameter's own precision otherwise. Null when
 * the controller has not reported the value.
 */
export function formatParamValue(param, value) {
  if (value === undefined || value === null || value === '') return null
  const tr = get(t)
  if (param.type === 'bool') {
    const on = value === true || value === 1 || value === 'true' || value === '1'
    return on ? tr('device.on') : tr('device.off')
  }
  const named = optionLabel(param.key, value)
  if (named) return named
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  const step = typeof param.step === 'number' && param.step > 0 ? param.step : 1
  const decimals = Number.isInteger(step) ? 0 : Math.min(2, (String(step).split('.')[1] || '').length)
  return n.toFixed(decimals)
}
