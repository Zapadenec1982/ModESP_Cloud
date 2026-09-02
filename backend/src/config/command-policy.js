'use strict';

/**
 * Command policy for POST /devices/:id/command (plan epic 1.7).
 *
 * Every writable key is validated against state_meta.json (type, min, max,
 * step). The keys below additionally change how the refrigeration equipment
 * runs or silence its protection, so the caller must send `confirm: true`
 * — the WebUI shows a confirmation dialog for them.
 */

const DANGEROUS_KEYS = new Set([
  'thermostat.setpoint',
  'thermostat.differential',
  'protection.high_limit',
  'protection.low_limit',
  'protection.manual_reset',
  'protection.reset_alarms',
  'defrost.manual_start',
  'defrost.manual_stop',
]);

const EPSILON = 1e-6;

/**
 * Validate and normalise a command value against its metadata entry.
 * @param {{key:string,type:string,min?:number,max?:number,step?:number}} meta
 * @param {*} value
 * @returns {{ ok: true, value: number|boolean } | { ok: false, message: string }}
 */
function validateCommandValue(meta, value) {
  const { key, type } = meta;

  if (type === 'bool') {
    if (value === true || value === false) return { ok: true, value };
    if (value === 1 || value === 0) return { ok: true, value: value === 1 };
    if (value === 'true' || value === '1')  return { ok: true, value: true };
    if (value === 'false' || value === '0') return { ok: true, value: false };
    return { ok: false, message: `"${key}" expects a boolean` };
  }

  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n)) return { ok: false, message: `"${key}" expects a number` };
  if (type === 'int' && !Number.isInteger(n)) return { ok: false, message: `"${key}" expects an integer` };

  if (typeof meta.min === 'number' && n < meta.min - EPSILON) {
    return { ok: false, message: `"${key}" must be at least ${meta.min}` };
  }
  if (typeof meta.max === 'number' && n > meta.max + EPSILON) {
    return { ok: false, message: `"${key}" must be at most ${meta.max}` };
  }
  if (typeof meta.step === 'number' && meta.step > 0) {
    const base = typeof meta.min === 'number' ? meta.min : 0;
    const steps = (n - base) / meta.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { ok: false, message: `"${key}" must be a multiple of ${meta.step}${base ? ` from ${base}` : ''}` };
    }
  }
  return { ok: true, value: n };
}

module.exports = { DANGEROUS_KEYS, validateCommandValue };
