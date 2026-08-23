#!/usr/bin/env node
'use strict';

/**
 * Link the 120 demo emulator devices to the 24 demo trade points (sites).
 *
 * WHY THIS IS A SEPARATE SCRIPT
 *   The CSV batch import (POST /api/devices/batch) can also set devices.site_id,
 *   but only on its `assign` path: it activates a device that is ALREADY connected
 *   and sitting as `pending` in the SYSTEM tenant, and it hands out MQTT credentials
 *   over MQTT to the live device. That couples pure metadata (which store is this
 *   fridge in?) to a fragile online handshake — and it has already stranded devices
 *   mid-import. Site linkage must not depend on it.
 *
 *   So this script does one thing: it sets devices.site_id, and nothing else. It is
 *   idempotent and safe to run any number of times, before or after the batch import.
 *   Devices that are still pending in the SYSTEM tenant are reported as `waiting`
 *   and simply pick up their site on the next run.
 *
 * PREREQUISITE
 *   src/scripts/seed-demo.js must have been run first — this script never creates
 *   sites, it only looks them up. If a site is missing it aborts before touching
 *   any device row.
 *
 * Usage:
 *   node src/scripts/link-devices-to-sites.js --dry-run    # show the plan, write nothing
 *   node src/scripts/link-devices-to-sites.js              # link
 *   node src/scripts/link-devices-to-sites.js --tenant a --tenant b   # pin chains to slugs
 *   node src/scripts/link-devices-to-sites.js --site-coords           # also clear per-device lat/lon
 *   node src/scripts/link-devices-to-sites.js --no-relink             # never move an existing site_id
 *
 * Without --tenant, the two chains are assigned to the first two active non-system
 * tenants ordered by creation date — the same rule seed-demo.js uses. --tenant must
 * be given exactly twice (one slug per chain) and may not name the SYSTEM tenant.
 *
 * OVERWRITING AN EXISTING site_id
 *   A device whose site_id already points somewhere else is MOVED to the demo site
 *   (bucket `relinked`) — that is this script's job. The move is never silent: every
 *   relinked device prints `old_site_id -> new_site_id`, so it can always be undone.
 *   Pass --no-relink to leave such devices alone (bucket `kept`) instead.
 *
 * Exit codes:
 *   0  success, INCLUDING when devices are still `waiting` (that is a normal state)
 *   1  a site is missing, a device sits in the wrong tenant, or the DB refused a write.
 *      NOTE: the transaction is still COMMITTED in that case — devices that did link
 *      are linked. The summary states exactly how many rows were written.
 */

require('dotenv').config();

const { Pool } = require('pg');

// Loaded through a helper so a missing/edited data file reports the path and the
// remedy instead of dying with a raw MODULE_NOT_FOUND stack from the CJS loader.
function loadData(file) {
  try {
    return require(`./demo-data/${file}`);
  } catch (err) {
    console.error(`Cannot read src/scripts/demo-data/${file}: ${err.message}`);
    console.error('The demo data files ship with the repo — restore them from git.');
    process.exit(1);
  }
}

const SITES = loadData('sites.json');
const DEVICES = loadData('devices.json');

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Naming — MUST stay byte-identical to src/scripts/seed-demo.js.
// The sites this script looks up are the rows that script wrote; if the two
// naming rules drift apart, every lookup misses and every device reports as
// "site missing" with no other symptom.
// ---------------------------------------------------------------------------
const CHAIN_SLOTS = ['Морозко', 'Свіжий Крам'];

function siteName(site, tenant) {
  const no = site.name.match(/№(\d+)/);
  return no ? `${tenant.name} №${no[1]}` : `${tenant.name} — ${site.city}`;
}

function parseArgs(argv) {
  const tenants = [];
  let dryRun = false;
  let siteCoords = false;
  let relink = true;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--site-coords') siteCoords = true;
    else if (argv[i] === '--no-relink') relink = false;
    else if (argv[i] === '--help' || argv[i] === '-h') help = true;
    else if (argv[i] === '--tenant') {
      // A flag-shaped value means the operator forgot the slug: consuming it would
      // silently drop the flag AND report a bogus "tenant slug not found: --dry-run".
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--tenant needs a slug');
      // The two slugs map to the two chains by position. A repeat would collapse
      // both chains into one tenant and still report a clean run.
      if (tenants.includes(value)) throw new Error(`--tenant repeated: ${value}`);
      tenants.push(value);
      i++;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { tenants, dryRun, siteCoords, relink, help };
}

const USAGE = `
Link demo emulator devices to demo sites (idempotent, re-runnable).

  --dry-run           print exactly what would change, write nothing
  --tenant <slug>     pin a chain to a tenant slug (must be given exactly twice,
                      one distinct slug per chain; the SYSTEM tenant is rejected)
  --site-coords       also NULL devices.latitude/longitude on linked devices so
                      the map falls back to the site coordinates via COALESCE
  --no-relink         leave a device whose site_id already points elsewhere alone
                      (default: move it to the demo site and print the old id)
  -h, --help          this text
`;

// ---------------------------------------------------------------------------
// Tenant resolution — same rule as seed-demo.js.
// ---------------------------------------------------------------------------
async function resolveTenants(pool, requested) {
  if (requested.length > 0) {
    // One slug per chain, no more and no fewer: a surplus slug is silently ignored
    // (only slots 0 and 1 are ever read) and a single slug leaves chain 2 unmapped.
    if (requested.length !== CHAIN_SLOTS.length) {
      throw new Error(
        `--tenant must be given exactly ${CHAIN_SLOTS.length} times ` +
        `(one slug per chain: ${CHAIN_SLOTS.join(', ')}), got ${requested.length}.`
      );
    }
    // Same two exclusions the default branch uses. The system tenant is active=true
    // (schema.sql seeds it without overriding the default), so without these an
    // explicit `--tenant __system__` resolves and the run proceeds against the
    // pending-device holding tenant.
    const { rows } = await pool.query(
      `SELECT id, slug, name FROM tenants
        WHERE slug = ANY($1) AND active = true AND id <> $2 AND slug <> '__system__'`,
      [requested, SYSTEM_TENANT_ID]
    );
    const missing = requested.filter(s => !rows.some(r => r.slug === s));
    if (missing.length) throw new Error(`tenant slug(s) not found: ${missing.join(', ')}`);
    // Preserve the order the caller asked for.
    return requested.map(s => rows.find(r => r.slug === s));
  }

  // `id` breaks the tie: created_at defaults to NOW() = transaction start, so two
  // tenants created in one transaction share a timestamp and PostgreSQL may return
  // them in either order — which would make this script and seed-demo.js disagree
  // about which chain belongs to which tenant. Keep this ORDER BY in sync with
  // seed-demo.js.
  const { rows } = await pool.query(
    `SELECT id, slug, name FROM tenants
     WHERE active = true AND id <> $1 AND slug <> '__system__'
     ORDER BY created_at, id
     LIMIT 2`,
    [SYSTEM_TENANT_ID]
  );
  if (rows.length < 2) {
    throw new Error(
      `need 2 active non-system tenants, found ${rows.length}. ` +
      `Create them first, or pass --tenant <slug> --tenant <slug>.`
    );
  }
  return rows;
}

/**
 * Resolve every entry of sites.json to a live sites row, keyed the way the
 * unique index is keyed.
 *
 * The index is an EXPRESSION index — uq_sites_tenant_name ON sites (tenant_id,
 * lower(btrim(name))) — so the lookup normalizes in SQL, not in JS. Doing it in
 * JS would mean trusting JS toLowerCase() to agree with PostgreSQL lower() on
 * Cyrillic, which is exactly the kind of silent miss migration 021 warns about.
 * This is the same predicate findOrCreateImportSite() uses in routes/devices.js.
 */
async function resolveSites(pool, tenants) {
  const resolved = [];
  for (const site of SITES) {
    const slot = CHAIN_SLOTS.indexOf(site.chain);
    const tenant = tenants[slot];
    if (!tenant) throw new Error(`no tenant for chain ${site.chain}`);

    const name = siteName(site, tenant);
    const { rows } = await pool.query(
      `SELECT id, tenant_id, name FROM sites
        WHERE tenant_id = $1 AND lower(btrim(name)) = lower(btrim($2::text))`,
      [tenant.id, name]
    );
    resolved.push({ tenant, name, row: rows[0] || null });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const BUCKETS = [
  ['linked',          'site_id was empty, now set'],
  ['already',         'site_id already correct — nothing to do'],
  ['relinked',        'site_id pointed elsewhere, moved to the demo site'],
  ['kept',            'site_id pointed elsewhere, left alone (--no-relink)'],
  ['waiting',         'still in the SYSTEM tenant — cannot be linked yet'],
  ['tenant_mismatch', 'device tenant != site tenant — NOT linked'],
  ['missing',         'mqtt_device_id is not in the database at all'],
  ['blocked',         'UPDATE guard refused the write — DB changed underneath'],
];

function classify(dev, site) {
  if (!dev) return 'missing';
  // Soft delete (018) parks the row in the SYSTEM tenant with status='deleted'
  // and site_id=NULL. It is not an error and it is not linkable.
  if (dev.deleted_at !== null || dev.status === 'deleted') return 'waiting';
  if (dev.tenant_id === SYSTEM_TENANT_ID) return 'waiting';
  // There is deliberately NO composite FK devices(tenant_id, site_id) ->
  // sites(tenant_id, id) — see migration 021. The database will happily link a
  // device to another tenant's site, so refusing it here is the only guard.
  if (dev.tenant_id !== site.row.tenant_id) return 'tenant_mismatch';
  if (dev.site_id === site.row.id) return 'already';
  if (dev.site_id === null) return 'linked';
  return 'relinked';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const { tenants: requested, dryRun, siteCoords, relink } = args;

  let pool = null;
  let client = null;

  try {
    // Inside the try: a bad DB_PORT / DSN throws from the constructor, and outside
    // it that surfaced as an unhandled rejection with an exit code this script
    // never chose — bypassing the documented exit-code contract above.
    pool = new Pool({
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME || 'modesp_cloud',
      user:     process.env.DB_USER || 'modesp_cloud',
      password: process.env.DB_PASS || '',
    });

    const tenants = await resolveTenants(pool, requested);
    console.log(
      `Tenants: ${tenants.map((t, i) => `${CHAIN_SLOTS[i]} -> ${t.slug} ("${t.name}")`).join(', ')}`
    );
    if (dryRun) console.log('\n-- DRY RUN, nothing will be written --');
    if (siteCoords) console.log('-- --site-coords: per-device latitude/longitude will be cleared --');

    // ---- Sites -----------------------------------------------------------
    const sites = await resolveSites(pool, tenants);
    const absent = sites.filter(s => !s.row);
    if (absent.length) {
      console.error(`\nERROR: ${absent.length} of ${sites.length} demo site(s) do not exist:`);
      for (const s of absent) console.error(`  [${s.tenant.slug}] ${s.name}`);
      console.error('\nRun the site seed first:  node src/scripts/seed-demo.js');
      process.exitCode = 1;
      return;
    }
    console.log(`\nSites: ${sites.length}/${SITES.length} resolved`);

    // ---- Devices ---------------------------------------------------------
    const counts = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
    const waitingDetail = { pending: 0, deleted: 0 };
    const loud = { tenant_mismatch: [], missing: [], blocked: [] };
    // An overwrite must never be recoverable only from a --dry-run: this list is
    // printed on real runs too, so the previous site_id survives the sweep.
    const relinkedDetail = [];
    let coordsCleared = 0;
    let rowsWritten = 0;

    if (!dryRun) {
      client = await pool.connect();
      await client.query('BEGIN');
    }
    const q = (sql, params) => (client ? client.query(sql, params) : pool.query(sql, params));

    // --site-coords is opt-in: per-device coordinates are real data on non-demo
    // fleets, and the map already resolves COALESCE(d.latitude, s.latitude).
    const setClause = siteCoords
      ? 'site_id = s.id, latitude = NULL, longitude = NULL'
      : 'site_id = s.id';

    for (const device of DEVICES) {
      // Same normalization the CSV batch import applies before it touches the DB.
      const mqttId = String(device.mqtt_device_id).trim().toUpperCase();
      const site = sites[device.site_index];
      if (!site) throw new Error(`${mqttId}: site_index ${device.site_index} is out of range`);

      // mqtt_device_id is globally unique (idx_devices_mqtt_id), and finding out
      // WHICH tenant owns the row is the whole point — so this one lookup cannot
      // carry a tenant_id predicate. Every write below does.
      //
      // upper(btrim(...)) rather than a plain `= $1`: the HTTP paths normalize the
      // id before insert, but MQTT auto-discovery (services/mqtt.js) stores the
      // topic segment verbatim, and idx_devices_mqtt_id is case-sensitive. A device
      // that published as `ae0000000001` would otherwise be reported `missing` and
      // silently dropped from the fleet with a green exit.
      const { rows } = await q(
        `SELECT id, tenant_id, site_id, status, deleted_at, latitude, longitude
           FROM devices WHERE upper(btrim(mqtt_device_id)) = $1`,
        [mqttId]
      );
      const dev = rows[0] || null;
      let bucket = classify(dev, site);

      // --no-relink: an existing, non-matching site_id is left exactly as it is.
      if (bucket === 'relinked' && !relink) bucket = 'kept';

      if (bucket === 'waiting') {
        if (dev.deleted_at !== null || dev.status === 'deleted') waitingDetail.deleted++;
        else waitingDetail.pending++;
      }
      if (bucket === 'missing') loud.missing.push(mqttId);
      if (bucket === 'tenant_mismatch') {
        loud.tenant_mismatch.push(`${mqttId}: device tenant ${dev.tenant_id} != site tenant ${site.row.tenant_id} (${site.name})`);
      }

      // `kept` writes nothing at all — not even the --site-coords clear, which would
      // point the map at the demo site's coordinates for a device that stayed on a
      // different site.
      if (bucket === 'missing' || bucket === 'waiting' ||
          bucket === 'tenant_mismatch' || bucket === 'kept') {
        counts[bucket]++;
        continue;
      }

      const needsCoordClear = siteCoords && (dev.latitude !== null || dev.longitude !== null);
      const needsWrite = bucket !== 'already' || needsCoordClear;
      const moved = `${mqttId}: site_id ${dev.site_id} -> ${site.row.id} ([${site.tenant.slug}] ${site.name})`;

      if (dryRun) {
        if (needsWrite) {
          const what = bucket === 'already' ? 'clear coords' : bucket;
          console.log(`  ${mqttId}  ${what.padEnd(12)} -> [${site.tenant.slug}] ${site.name}`);
        }
        if (bucket === 'relinked') relinkedDetail.push(`would move ${moved}`);
        counts[bucket]++;
        if (needsCoordClear) coordsCleared++;
        continue;
      }

      if (!needsWrite) {
        counts[bucket]++;
        continue;
      }

      // The tenant guard lives in THIS statement, not in the SELECT above and
      // not in the schema: `d.tenant_id = s.tenant_id` is what makes a
      // cross-tenant link impossible even if the row moved between the two
      // queries. s.tenant_id = $3 keeps the house rule (every query names a
      // tenant) and pins the site to the tenant we resolved it in.
      //
      // `linked` means site_id read as NULL. Re-asserting that here keeps the fill
      // path from racing into an overwrite if something set site_id between the two
      // statements: `relinked` is the ONLY path allowed to move a non-NULL site_id,
      // and it records the previous value. Same rule migration 021's backfill
      // states as `d.site_id IS NULL -- fill only, NEVER overwrite`.
      const fillGuard = bucket === 'linked' ? 'AND d.site_id IS NULL' : '';
      const upd = await q(
        `UPDATE devices d
            SET ${setClause}
           FROM sites s
          WHERE upper(btrim(d.mqtt_device_id)) = $1
            AND s.id = $2
            AND s.tenant_id = $3
            AND d.tenant_id = s.tenant_id
            ${fillGuard}
        RETURNING d.id`,
        [mqttId, site.row.id, site.row.tenant_id]
      );

      if (upd.rows.length === 0) {
        counts.blocked++;
        loud.blocked.push(`${mqttId}: guard refused the update (tenant or site_id changed mid-run?)`);
        continue;
      }
      counts[bucket]++;
      rowsWritten++;
      if (bucket === 'relinked') relinkedDetail.push(`moved ${moved}`);
      if (needsCoordClear) coordsCleared++;
    }

    if (client) {
      await client.query('COMMIT');
    }

    // ---- Report ----------------------------------------------------------
    console.log(`\nDevices (${DEVICES.length}):`);
    let total = 0;
    for (const [key, note] of BUCKETS) {
      const n = counts[key];
      total += n;
      if (n === 0 && (key === 'blocked' || key === 'tenant_mismatch' ||
                      key === 'missing' || key === 'kept')) continue;
      console.log(`  ${key.padEnd(16)} ${String(n).padStart(4)}   ${note}`);
    }
    console.log(`  ${'-'.repeat(16)} ${'-'.repeat(4)}`);
    console.log(`  ${'total'.padEnd(16)} ${String(total).padStart(4)}`);

    // Past tense only when a write actually happened — this block used to claim
    // "cleared on N device(s)" during --dry-run, which is the one output the flag
    // exists to keep honest.
    if (siteCoords) {
      console.log(dryRun
        ? `\n  would clear latitude/longitude on ${coordsCleared} device(s) — the map would then`
        : `\n  latitude/longitude cleared on ${coordsCleared} device(s) — the map now`);
      console.log('  read the site coordinates via COALESCE(d.latitude, s.latitude).');
    }

    if (counts.kept > 0) {
      console.log(
        `\n  ${counts.kept} device(s) kept their existing site_id (--no-relink). ` +
        `Re-run without --no-relink to move them onto the demo sites.`
      );
    }

    if (counts.waiting > 0) {
      console.log(
        `\n  ${counts.waiting} device(s) are waiting: they still sit in the SYSTEM tenant ` +
        `(${waitingDetail.pending} pending, ${waitingDetail.deleted} soft-deleted) and will ` +
        `link automatically on the next run of this script, once the batch import (POST ` +
        `/api/devices/batch) has assigned them to a tenant. This is expected, not a failure.`
      );
    }

    // Printed on real runs, not only under --dry-run: an overwritten site_id is
    // unrecoverable if the previous value was never written down.
    if (relinkedDetail.length) {
      console.log(`\n  relinked — previous site_id recorded here (${relinkedDetail.length}):`);
      for (const line of relinkedDetail) console.log(`     ${line}`);
    }

    for (const [key, lines] of Object.entries(loud)) {
      if (!lines.length) continue;
      console.log(`\n  !! ${key} (${lines.length}):`);
      for (const line of lines) console.log(`     ${line}`);
    }

    // Say plainly whether anything was written. A `blocked` device exits 1 while the
    // transaction still COMMITs, so "non-zero exit" must not be read as "rolled back".
    if (dryRun) {
      console.log('\nDry run complete. Nothing was written.');
    } else {
      console.log(`\nCommitted: ${rowsWritten} device row(s) written.`);
      if (counts.blocked > 0) {
        console.log(
          `  ${counts.blocked} blocked device(s) wrote nothing; every other row above IS ` +
          `committed. Re-running is safe and will retry only the blocked rows.`
        );
      }
      console.log('Done.');
    }

    // `waiting` is normal and never fails the run. A missing device is data drift
    // worth seeing but not worth failing on. A cross-tenant link attempt or a
    // refused write is a real inconsistency — fail loudly so CI/operators notice.
    if (counts.tenant_mismatch > 0 || counts.blocked > 0) process.exitCode = 1;
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    }
    console.error('Link failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error('Link failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
