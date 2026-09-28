/**
 * HACCP critical limits on the client: the same reading of haccp_min /
 * haccp_max / haccp_tolerance the PDF journal uses (backend
 * services/haccp-report.js limitsFor + detectExcursions), applied to the live
 * air temperature so a card can say «поза межею» before the platform records an
 * alarm — and can say it in the organisation's terms, not the controller's.
 */

/** Alarm codes that mean "the product is out of its temperature range". */
export const TEMP_ALARM_CODES = ['high_temp_alarm', 'low_temp_alarm']

export function isTempAlarm(code) {
  return TEMP_ALARM_CODES.includes(code)
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

/** The organisation's limits of a device, or null when it carries none. */
export function haccpLimits(device) {
  const min = num(device?.haccp_min)
  const max = num(device?.haccp_max)
  if (min === null && max === null) return null
  const tol = num(device?.haccp_tolerance)
  return { min, max, tolerance: tol === null || tol < 0 ? 0 : tol }
}

/**
 * 'in_range' | 'out_of_range' | 'no_limits' | 'no_reading'
 *
 * no_limits: the organisation set no critical limits for this device (the
 * journal then uses the controller's own), so there is nothing to compare with.
 * no_reading: limits exist but the device has no live air temperature — an
 * offline cabinet is not "in range", it is unknown.
 *
 * Tolerance widens the band the same way the excursion detector does:
 * out of range means above max + tolerance or below min − tolerance.
 */
export function tempState(device) {
  const limits = haccpLimits(device)
  if (!limits) return 'no_limits'
  const t = num(device?.air_temp)
  if (t === null) return 'no_reading'
  if (limits.max !== null && t > limits.max + limits.tolerance) return 'out_of_range'
  if (limits.min !== null && t < limits.min - limits.tolerance) return 'out_of_range'
  return 'in_range'
}

/**
 * "−18…−15 °C (±3)" / "≤ −18 °C (±3)" / "≥ 2 °C" — the range as the
 * organisation wrote it, tolerance in brackets when non-zero. Empty string when
 * the device carries no limits. Also formats a preset from GET /devices/haccp-presets.
 */
export function haccpRangeLabel(source) {
  const limits = haccpLimits(source)
  if (!limits) return ''
  const n = (v) => String(v).replace('-', '−')
  const range = limits.min === null ? `≤ ${n(limits.max)}`
    : limits.max === null ? `≥ ${n(limits.min)}`
    : `${n(limits.min)}…${n(limits.max)}`
  return `${range} °C${limits.tolerance ? ` (±${limits.tolerance})` : ''}`
}
