/**
 * i18n parity check — `node scripts/check-i18n-parity.mjs`
 *
 * `lib/i18n.js` returns the raw key when a translation is missing, so a gap in
 * one locale renders the literal string `geostats.avg_air_temp` in the UI. This
 * flattens the four default exports and diffs their key sets.
 *
 * Exit code 1 on any difference, so it can be wired into CI.
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES = ['uk', 'en', 'pl', 'de']
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'locales')

const flatten = (obj, prefix = '', out = new Set()) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.add(key)
  }
  return out
}

const keys = {}
for (const loc of LOCALES) {
  const mod = await import(pathToFileURL(resolve(DIR, `${loc}.js`)).href)
  keys[loc] = flatten(mod.default)
}

const all = new Set(LOCALES.flatMap(loc => [...keys[loc]]))
let failed = false
for (const loc of LOCALES) {
  const missing = [...all].filter(k => !keys[loc].has(k)).sort()
  console.log(`${loc}: ${keys[loc].size} keys, ${missing.length} missing`)
  if (missing.length) { failed = true; console.log('  ' + missing.join('\n  ')) }
}
process.exit(failed ? 1 : 0)
