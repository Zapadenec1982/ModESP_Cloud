/**
 * i18n check — `node scripts/check-i18n-parity.mjs`
 *
 * `lib/i18n.js` returns the raw key when a translation is missing, so a gap
 * renders the literal string `geostats.avg_air_temp` on screen. Two ways that
 * happens, and this checks both:
 *
 *   1. PARITY — the key exists in some languages and not others. The four
 *      default exports are flattened and their key sets diffed.
 *
 *   2. UNDEFINED — the key exists in no language at all, because the component
 *      asked for one that was never written. Parity alone is blind to this: a
 *      key missing everywhere is perfectly consistent. The organisation card
 *      called $t('users.role') for its column heading while the dictionary had
 *      `col_role`, and every language showed the literal text «users.role» to a
 *      superadmin. So every literal $t('…') in the components is resolved
 *      against the Ukrainian dictionary, which is the complete one by parity.
 *
 * A computed key — $t('users.role_' + u.role) — cannot be resolved statically
 * and is skipped; its prefix is checked instead, so a whole missing group is
 * still caught.
 *
 * Exit code 1 on any difference, so it can be wired into CI.
 */
import { pathToFileURL } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// ── every key a component asks for exists ──────────────────────────────
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(svelte|js)$/.test(name) && !full.includes(`${'lib'}/locales`)) out.push(full)
  }
  return out
}

const uk = keys.uk
// A group prefix is anything a key sits under: `users` for `users.col_role`.
const groups = new Set([...uk].flatMap(k => {
  const parts = k.split('.')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'))
}))

const undefinedKeys = []
for (const file of sources(SRC)) {
  const text = readFileSync(file, 'utf8')
  // $t('a.b') and $t('a.b_' + x) — the second gives us the prefix only
  for (const m of text.matchAll(/\$?\bt\(\s*'([^']+)'\s*(\+)?/g)) {
    const [, key, computed] = m
    const line = text.slice(0, m.index).split('\n').length
    const where = `${file.slice(SRC.length + 1)}:${line}`
    if (computed) {
      // 'users.role_' + role → the group `users` must exist
      const prefix = key.replace(/[^.]*$/, '').replace(/\.$/, '')
      if (prefix && !groups.has(prefix)) undefinedKeys.push(`${where} — no such group: ${prefix} (from '${key}' + …)`)
      continue
    }
    if (!uk.has(key) && !groups.has(key)) undefinedKeys.push(`${where} — no such key: ${key}`)
  }
}

console.log(`components: ${undefinedKeys.length} key(s) that no language defines`)
if (undefinedKeys.length) { failed = true; console.log('  ' + undefinedKeys.join('\n  ')) }

process.exit(failed ? 1 : 0)
