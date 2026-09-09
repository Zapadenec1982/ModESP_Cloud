/**
 * Firmware upload contract — `node scripts/check-firmware-upload.mjs`
 *
 * The upload form has always built the platform-firmware options — the «global»
 * switch, the visibility choice, the list of organisations — and passed them to
 * uploadFirmware() as a fifth argument. The function took four. The extra one
 * was dropped on the floor, nothing reached FormData, and the backend, seeing no
 * `global` field, filed the release as the superadmin's own organisation
 * firmware: invisible to everyone it was meant for, with no error anywhere.
 *
 * A build cannot catch that, and neither can a backend test — the server side is
 * correct and covered (backend/test/firmware-library.test.js posts exactly the
 * shape asserted below). What was missing is a check on the half in between, so
 * this drives the real client function with fetch stubbed and reads back the
 * FormData it built.
 *
 * Exit code 1 on any mismatch, so it can be wired into CI.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

// api.js is browser code: it reads localStorage at import time and i18n reads
// the document. Stub only what loading needs — the function under test uses
// neither.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = {
  location: { pathname: '/', search: '', hash: '' },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
}
globalThis.document = { documentElement: { setAttribute: () => {}, lang: '' }, addEventListener: () => {} }

const sent = []
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: init.body })
  return { ok: true, json: async () => ({ data: {} }) }
}

const API = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'api.js')
const api = await import(pathToFileURL(API).href)

const file = new File([new Uint8Array([0, 1, 2])], 'fw.bin', { type: 'application/octet-stream' })
const TENANT = '11111111-1111-1111-1111-111111111111'
const failures = []
const check = (label, actual, expected) => {
  const ok = actual === expected
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}`)
  if (!ok) failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('platform firmware, visible to selected organisations:')
sent.length = 0
await api.uploadFirmware(file, '9.9.9', 'notes', 'esp32',
  { global: true, visibility: 'selected', tenantIds: [TENANT] })
let fd = sent[0].body
check('url', sent[0].url, '/api/firmware/upload')
check('global', fd.get('global'), 'true')
check('visibility', fd.get('visibility'), 'selected')
check('tenant_ids', fd.get('tenant_ids'), JSON.stringify([TENANT]))
check('version', fd.get('version'), '9.9.9')
check('board_type', fd.get('board_type'), 'esp32')

console.log('platform firmware, visible to everyone:')
sent.length = 0
await api.uploadFirmware(file, '9.9.8', '', null, { global: true, visibility: 'all', tenantIds: [] })
fd = sent[0].body
check('global', fd.get('global'), 'true')
check('visibility', fd.get('visibility'), 'all')
// The backend ignores tenant_ids unless visibility is 'selected'; sending an
// empty list would only invite a future reader to wonder what it meant.
check('tenant_ids omitted', fd.get('tenant_ids'), null)

console.log('an ordinary organisation upload carries none of it:')
sent.length = 0
await api.uploadFirmware(file, '9.9.7', '', null)
fd = sent[0].body
check('global', fd.get('global'), null)
check('visibility', fd.get('visibility'), null)
check('tenant_ids', fd.get('tenant_ids'), null)

if (failures.length) {
  console.log(`\n${failures.length} mismatch(es):`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
console.log('\nthe upload sends what POST /api/firmware/upload reads')
