#!/usr/bin/env node
'use strict';
/**
 * Remove demo organisations from a database (plan epic 1.10).
 *
 * Production must not carry synthetic data: once the emulator fleet and the
 * demo chains have moved to the demo server, this script deletes them here.
 * An organisation counts as demo when it is named with --tenant, or when it
 * owns at least one device that reports an emulator firmware (`*-emu`) or is
 * listed in demo-data/emulator-fleet.csv (written by provision-demo-fleet.js).
 *
 * Devices of a demo organisation are DROPPED together with their telemetry and
 * hourly archive — they never existed, so nothing is parked in __system__.
 * Users, sites, links, settings and the organisation row go with them; the
 * audit log keeps its rows with the tenant/user references nulled.
 *
 * Usage:
 *   node src/scripts/purge-demo.js                  # list what would go (dry run)
 *   node src/scripts/purge-demo.js --apply          # delete
 *   node src/scripts/purge-demo.js --tenant demo-a --tenant demo-b --apply
 *   node src/scripts/purge-demo.js --keep showcase --apply   # keep one showcase organisation
 *
 * Exit codes: 0 done (or nothing to do), 1 error / refused.
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const CSV_DIR = path.join(__dirname, 'demo-data');

function parseArgs(argv) {
  const tenants = [], keep = [];
  let apply = false, help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--tenant' || a === '--keep') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a tenant slug`);
      (a === '--tenant' ? tenants : keep).push(v);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return { tenants, keep, apply, help };
}

/** mqtt ids from every emulator-fleet*.csv next to the script (first column). */
function fleetIdsFromCsv(dir = CSV_DIR) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!/^emulator-fleet.*\.csv$/.test(f)) continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const id = line.split(',')[0].trim().replace(/^"|"$/g, '');
      if (/^[A-Za-z0-9_-]{1,16}$/.test(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Organisations to purge: explicit slugs, or auto-detected owners of emulator
 * devices. Never the system organisation; `keep` slugs are always excluded.
 */
async function findDemoTenants({ query, tenants = [], keep = [], csvIds = fleetIdsFromCsv() }) {
  let rows;
  if (tenants.length) {
    ({ rows } = await query(
      `SELECT t.id, t.slug, t.name,
              (SELECT count(*)::int FROM devices d WHERE d.tenant_id = t.id) AS devices,
              (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users
         FROM tenants t WHERE t.slug = ANY($1) AND t.slug <> '__system__' ORDER BY t.slug`, [tenants]));
    const missing = tenants.filter(s => !rows.some(r => r.slug === s));
    if (missing.length) throw new Error(`Tenant slug not found: ${missing.join(', ')}`);
  } else {
    ({ rows } = await query(
      `SELECT t.id, t.slug, t.name,
              (SELECT count(*)::int FROM devices d WHERE d.tenant_id = t.id) AS devices,
              (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users
         FROM tenants t
        WHERE t.slug <> '__system__'
          AND EXISTS (SELECT 1 FROM devices d WHERE d.tenant_id = t.id
                         AND (d.firmware_version ILIKE '%-emu%' OR d.mqtt_device_id = ANY($1)))
        ORDER BY t.slug`, [[...csvIds]]));
  }
  return rows.filter(r => !keep.includes(r.slug));
}

async function purge({ query, transaction, tenants = [], keep = [], apply = false, csvIds, log = () => {} }) {
  const targets = await findDemoTenants({ query, tenants, keep, csvIds });
  const result = { targets, deleted: [] };
  if (targets.length === 0) { log('No demo organisations found.'); return result; }
  for (const t of targets) log(`${apply ? 'DELETE' : 'would delete'} ${t.slug} ("${t.name}"): ${t.devices} device(s), ${t.users} user(s)`);
  if (!apply) { log('Dry run — pass --apply to delete.'); return result; }
  const { deleteTenant } = require('../services/tenant-delete');
  for (const t of targets) {
    const r = await transaction((client) => deleteTenant(client, t.id, { dropDevices: true }));
    if (r) { result.deleted.push(r); log(`  ${t.slug}: ${r.droppedDevices} device(s), ${r.deletedTelemetry} telemetry row(s) removed`); }
  }
  return result;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exitCode = 1; return; }
  if (args.help) {
    console.log('Usage: purge-demo.js [--tenant <slug>]... [--keep <slug>]... [--apply]');
    return;
  }
  const db = require('../services/db');
  try {
    const r = await purge({
      query: (sql, params) => db.query(sql, params),
      transaction: (fn) => db.transaction(fn),
      tenants: args.tenants, keep: args.keep, apply: args.apply, log: console.log,
    });
    if (args.apply && r.deleted.length) {
      console.log('Restart modesp-backend so the MQTT registries forget the removed devices.');
    }
  } catch (err) {
    console.error('Purge failed:', err.message);
    process.exitCode = 1;
  } finally {
    const end = db.shutdown || db.close || db.end;
    if (typeof end === 'function') await end();
  }
}

module.exports = { parseArgs, fleetIdsFromCsv, findDemoTenants, purge };

if (require.main === module) main();
