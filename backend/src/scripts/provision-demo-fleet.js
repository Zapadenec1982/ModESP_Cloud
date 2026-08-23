#!/usr/bin/env node
'use strict';

/**
 * Provision the 120 demo emulator devices DIRECTLY in the database.
 *
 * WHY THIS EXISTS
 *   Neither shipped path can put 120 emulated devices on the broker:
 *
 *   POST /api/devices/register is rate limited to 30 per IP per hour, so one
 *   emulator stand needs four hours of wall clock to register the fleet.
 *
 *   POST /api/devices/batch (the CSV import) hands the generated MQTT password
 *   to the device over MQTT, on its own `cmd/` topic. That only reaches a device
 *   that is CONNECTED at that exact moment. Anything offline during the import
 *   never learns its password and can never connect again — 28 devices were
 *   stranded that way already.
 *
 *   This script writes the finished row instead: tenant, site, metadata,
 *   mqtt_username and a bcrypt hash of a freshly generated password. The
 *   plaintext passwords go into a CSV for the emulator operator; the broker
 *   never has to hand anything over. No registration, no pending flow, no
 *   handshake, no rate limit.
 *
 * WHY THE ROWS ARE IMMEDIATELY CONNECTABLE
 *   mosquitto-go-auth authenticates against devices directly
 *   (infra/mosquitto/mosquitto.conf, auth_opt_pg_userquery): a row with
 *   mqtt_username + mqtt_password_hash and status <> 'disabled' can log in.
 *   auth_opt_pg_aclquery then grants status='active' rows the topic prefix
 *   `modesp/v1/{tenant_slug}/{mqtt_device_id}`. So the fleet is provisioned
 *   status='active' inside a real tenant and publishes under the tenant prefix
 *   from the first connection — it never passes through `modesp/v1/pending/`.
 *
 * PREREQUISITE
 *   src/scripts/seed-demo.js must have been run first. This script never
 *   creates sites, it only looks them up, and it aborts before touching a
 *   single device row if any of the 24 sites is missing.
 *
 * Usage:
 *   node src/scripts/provision-demo-fleet.js --dry-run      # show the plan, write nothing
 *   node src/scripts/provision-demo-fleet.js                # provision + write the CSV
 *   node src/scripts/provision-demo-fleet.js --tenant a --tenant b   # pin chains to slugs
 *   node src/scripts/provision-demo-fleet.js --keep-passwords        # add missing devices only
 *   node src/scripts/provision-demo-fleet.js --reclaim E00042        # take one id by hand
 *
 * Without --tenant, the two chains are assigned to the first two active
 * non-system tenants ordered by creation date — the same rule seed-demo.js and
 * link-devices-to-sites.js use. --tenant must be given exactly twice (one slug
 * per chain) and may not name the SYSTEM tenant.
 *
 * WHICH IDS MAY BE TAKEN OVER
 *   E00001..E00120 is not a reserved range. A row already sitting on one of
 *   those ids is taken over WITHOUT asking only when nobody can be using it:
 *   soft-deleted, or parked and idle in the SYSTEM tenant, or already in the
 *   tenant this run writes. Anything else — a live device in another tenant, a
 *   pending device somebody is about to claim — aborts the run and is listed.
 *   Naming that id in --reclaim is the only way to move it, and every reclaimed
 *   id is echoed in the summary. Device `comment` and `serial_number` are NOT
 *   evidence of ownership: both are free-form and writable by any tenant admin
 *   through PATCH /api/devices/:id.
 *
 * RE-RUNNING ROTATES PASSWORDS
 *   A plain re-run generates a NEW password for every device. The old CSV is
 *   dead the moment this script commits — every emulator instance must be
 *   reloaded from the new file or it will fail authentication.
 *   Pass --keep-passwords to leave existing credentials alone and provision only
 *   the devices that do not have a mqtt_password_hash yet. The CSV stays
 *   COMPLETE across such a run: the plaintext of every kept device is carried
 *   forward from the previous CSV and re-verified against the stored bcrypt hash
 *   before it is written again.
 *
 *   !! THE CSV CONTAINS PLAINTEXT MQTT PASSWORDS !!
 *   It is git-ignored, written 0600 where the platform supports it, and must
 *   never be committed or sent over an untrusted channel. A previous CSV is
 *   never deleted — it is renamed to emulator-fleet.<stamp>.bak.csv, which holds
 *   live plaintext too and must be shredded by hand once the fleet is reloaded.
 *
 * Exit codes:
 *   0  the fleet is provisioned and the CSV is written
 *   1  a site is missing, an id collides with a device this script may not take
 *      over, or the DB refused a write. The transaction is ROLLED BACK and no
 *      CSV is written — the fleet is never left half provisioned.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');
const mqttAuth = require('../services/mqtt-auth');

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

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// Matches routes/devices.js: every bcrypt hash this codebase writes for MQTT is
// cost 12, and mosquitto.conf pins auth_opt_hasher_cost to 12 as well.
const BCRYPT_ROUNDS = 12;
// routes/devices.js hashes the CSV import in parallel batches of 8. Serial
// bcrypt at cost 12 would put a 120-device run at roughly half a minute of pure
// CPU; 8 at a time keeps it a few seconds on any dev box.
const HASH_BATCH = 8;

// A SYSTEM-tenant row that has published inside this window is a device somebody
// is about to claim, not an abandoned slot. Matches the 7-day retention the
// soft-delete cleanup job in services/mqtt.js uses.
const IDLE_DAYS = 7;

// ---------------------------------------------------------------------------
// Naming — MUST stay byte-identical to src/scripts/seed-demo.js.
// The sites this script looks up are the rows that script wrote; if the two
// naming rules drift apart, every lookup misses and the run aborts with 24
// "site missing" lines and no other symptom.
// ---------------------------------------------------------------------------
const CHAIN_SLOTS = ['Морозко', 'Свіжий Крам'];

function siteName(site, tenant) {
  const no = site.name.match(/№(\d+)/);
  return no ? `${tenant.name} №${no[1]}` : `${tenant.name} — ${site.city}`;
}

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------
// Five machines per trade point, in this exact order — the same kit, in the same
// order, as demo-data/devices.json and the two demo-data/import-*.csv files, so a
// device provisioned here is indistinguishable from one imported the old way.
const EQUIPMENT_KIT = [
  { equipment: 'Вітрина молочна',    location: 'Торговий зал', model: 'ModESP-VM4' },
  { equipment: 'Вітрина мʼясна',     location: 'Торговий зал', model: 'ModESP-VM4' },
  { equipment: 'Бонета морозильна',  location: 'Торговий зал', model: 'ModESP-BF2' },
  { equipment: 'Камера охолодження', location: 'Склад',        model: 'ModESP-KC6' },
  { equipment: 'Камера заморозки',   location: 'Склад',        model: 'ModESP-KF6' },
];

// Same marker string the demo-data/import-*.csv files carry in their `comment`
// column. It is written onto every row this script provisions, but it is NOT
// evidence of ownership when deciding whether an id may be taken over: `comment`
// and `serial_number` are free-form and writable by any tenant admin through
// PATCH /api/devices/:id (routes/devices.js), so a foreign device carrying them
// proves nothing. See classifyExisting().
const DEMO_COMMENT = 'Демо-парк (ModESP EMU)';
const DEMO_SERIAL_PREFIX = 'EMU-2026-';

const CSV_PATH = path.join(__dirname, 'demo-data', 'emulator-fleet.csv');
// The format ModESP_EMU already exports and consumes. Do not reorder or rename:
// the emulator matches columns by header name and the order is what its own
// export writes, so a "nicer" header is a silent import failure on the stand.
const CSV_HEADER = ['mqtt_device_id', 'name', 'tenant', 'mqtt_username', 'mqtt_password'];

// mqtt_device_id is VARCHAR(16) with a GLOBAL unique index (idx_devices_mqtt_id),
// and the register endpoint validates ids as /^[A-Fa-f0-9]{6,12}$/. "E" + five
// digits is six hex characters, so these ids stay valid on every other path too.
function deviceId(seq) {
  return `E${String(seq).padStart(5, '0')}`;
}

/**
 * Build the whole fleet deterministically: 24 sites x 5 machines = 120 devices,
 * ids E00001..E00120 handed out in site order. Nothing here touches the DB, so a
 * --dry-run prints exactly the plan a real run would execute.
 */
function buildFleet(tenants) {
  const fleet = [];
  let seq = 0;

  SITES.forEach((site, siteIndex) => {
    const slot = CHAIN_SLOTS.indexOf(site.chain);
    const tenant = tenants[slot];
    if (!tenant) throw new Error(`no tenant for chain ${site.chain}`);
    const name = siteName(site, tenant);

    for (const kit of EQUIPMENT_KIT) {
      seq++;
      fleet.push({
        seq,
        siteIndex,
        tenant,
        siteName: name,
        mqttId: deviceId(seq),
        name: `${kit.equipment} — ${name}`,
        location: kit.location,
        model: kit.model,
        serial: `${DEMO_SERIAL_PREFIX}${String(seq).padStart(4, '0')}`,
        comment: DEMO_COMMENT,
        username: `device_${deviceId(seq)}`,
        password: null,   // fresh from generateCredentials(), or carried forward
        hash: null,       // set only when this run generated the password
        inCsv: false,
      });
    }
  });

  return fleet;
}

// ---------------------------------------------------------------------------
// Arguments — same shape and same error messages as seed-demo.js.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const tenants = [];
  const reclaim = [];
  let dryRun = false;
  let keepPasswords = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--keep-passwords') keepPasswords = true;
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
    } else if (argv[i] === '--reclaim') {
      // Every takeover of a live foreign device has to be typed out by hand, one
      // id per flag. Never a range, never a wildcard: this is the flag that moves
      // somebody else's hardware into the demo tenant and rotates its password.
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--reclaim needs an mqtt_device_id');
      const id = value.trim().toUpperCase();
      if (!/^[A-F0-9]{6,12}$/.test(id)) {
        throw new Error(`--reclaim: "${value}" is not a valid mqtt_device_id (6-12 hex chars)`);
      }
      if (reclaim.includes(id)) throw new Error(`--reclaim repeated: ${id}`);
      reclaim.push(id);
      i++;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { tenants, reclaim, dryRun, keepPasswords, help };
}

const USAGE = `
Provision the 120 demo emulator devices directly in the database.

  --dry-run           print exactly what would change, write NOTHING — no DB
                      writes and no CSV (it would hold live credentials)
  --tenant <slug>     pin a chain to a tenant slug (must be given exactly twice,
                      one distinct slug per chain; the SYSTEM tenant is rejected)
  --keep-passwords    leave devices that already have a mqtt_password_hash on
                      their current password; provision only the missing ones.
                      Their plaintext is carried forward from the previous CSV,
                      so the new CSV still describes the whole fleet.
  --reclaim <id>      take over ONE id that is otherwise refused (a live device
                      in another tenant, or a pending device). Repeatable, one
                      flag per id. Moves real hardware into the demo tenant and
                      rotates its MQTT password — it will drop off the broker.
  -h, --help          this text

Without --keep-passwords a re-run ROTATES every password and the previous CSV
stops working. Reload ModESP_EMU from the new file after every such run.
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
    // explicit `--tenant __system__` would provision 60 ACTIVE devices inside the
    // pending-device holding tenant — and the ACL query would hand them the
    // `modesp/v1/__system__/...` prefix.
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
  // them in either order — which would make this script, seed-demo.js and
  // link-devices-to-sites.js disagree about which chain belongs to which tenant.
  // Keep all three ORDER BY clauses identical.
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
 * Same predicate link-devices-to-sites.js and findOrCreateImportSite() use.
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
// Pre-flight: what is already sitting on these 120 ids?
// ---------------------------------------------------------------------------
/**
 * Load every device row that already occupies one of the fleet ids.
 *
 * Runs on the transaction's own client, AFTER BEGIN, and takes FOR UPDATE on
 * every row it returns. Every takeover decision below is made from this snapshot
 * and the matching write happens later in the same transaction — without the
 * lock, POST /api/devices/register, the CSV import, MQTT auto-discovery
 * (services/mqtt.js) and the hourly softDeleteCleanup job can all change a row
 * in between, and the upsert would then apply to something none of the guards
 * ever saw.
 *
 * mqtt_device_id is globally unique (idx_devices_mqtt_id) and finding out WHICH
 * tenant owns a colliding row is the whole point, so this one lookup cannot carry
 * a tenant_id predicate. Every write below does.
 *
 * The lookup normalizes with upper(btrim(...)) because idx_devices_mqtt_id is
 * CASE-SENSITIVE while MQTT auto-discovery stores the topic segment verbatim. A
 * row stored as `e00001` would not be found by a plain `= $1` — and
 * `ON CONFLICT (mqtt_device_id)` would not fire on it either, so the upsert would
 * happily INSERT a second row for the same physical device.
 *
 * Returns Map<normalized id, row[]>: a normalized id can legitimately match more
 * than one row (`E00001` AND `e00001` are distinct keys in a case-sensitive
 * index). Keeping only one of them — as a Map<id, row> would — makes the
 * case-clash guard depend on the order the server happened to return rows in.
 */
async function scanExisting(client, fleet) {
  const ids = fleet.map(d => d.mqttId);
  const { rows } = await client.query(
    `SELECT id, mqtt_device_id, tenant_id, status, deleted_at, site_id, name,
            serial_number, comment, mqtt_username, mqtt_password_hash,
            online, last_seen
       FROM devices
      WHERE upper(btrim(mqtt_device_id)) = ANY($1)
      ORDER BY mqtt_device_id
        FOR UPDATE`,
    [ids]
  );
  const byId = new Map();
  for (const row of rows) {
    const key = row.mqtt_device_id.trim().toUpperCase();
    const list = byId.get(key);
    if (list) list.push(row);
    else byId.set(key, [row]);
  }
  return byId;
}

/**
 * Re-read the fleet ids at the very end of the transaction and refuse to commit
 * if any normalized id now resolves to a row this run did not write.
 *
 * scanExisting() takes FOR UPDATE, which stops a concurrent UPDATE or DELETE of a
 * row that already existed — but it cannot lock a row that does not exist yet.
 * Under READ COMMITTED an INSERT that commits mid-run is invisible to the scan,
 * and if it lands on a different CASE of one of our ids (`e00001` — auto-discovery
 * stores the topic segment verbatim, and it derives mqtt_username from the same
 * verbatim string) it does not fire ON CONFLICT and does not clash on
 * idx_devices_mqtt_username either. The fleet would silently fork into two rows
 * for one physical device. This last SELECT does see it, because it runs after
 * that INSERT committed — so the run rolls back instead.
 */
async function verifyNoCaseForks(client, fleet) {
  const ids = fleet.map(d => d.mqttId);
  const { rows } = await client.query(
    `SELECT mqtt_device_id FROM devices
      WHERE upper(btrim(mqtt_device_id)) = ANY($1::text[])
        AND mqtt_device_id <> ALL($1::text[])`,
    [ids]
  );
  if (rows.length) {
    throw new Error(
      `case-variant device row(s) appeared during the run: ` +
      rows.map(r => `"${r.mqtt_device_id}"`).join(', ') +
      ` — idx_devices_mqtt_id is case-sensitive, so committing would leave two ` +
      `rows for the same physical device. Nothing was written.`
    );
  }
}

/**
 * May this run take the id over?
 *
 * The E00001..E00120 range is not reserved by anything — prod already holds six
 * soft-deleted devices inside it. Reviving those is the documented job. Silently
 * hijacking a device that happens to share an id is not: it would move a real
 * fridge into the demo tenant, rotate its password so it drops off the broker,
 * and hand the demo operator credentials to someone else's hardware.
 *
 * Takeover happens WITHOUT asking only when the row is genuinely unowned:
 *   - soft-deleted (status='deleted' or deleted_at set), or
 *   - already in the tenant we are about to write, or
 *   - parked in the SYSTEM tenant AND idle — offline, and not seen for IDLE_DAYS.
 *
 * Everything else is 'foreign' and aborts the run unless the operator named that
 * exact id in --reclaim.
 *
 * Two heuristics were deliberately REMOVED from this list: `comment ===
 * DEMO_COMMENT` and `serial_number LIKE 'EMU-2026-%'`. Both columns are free-form
 * and writable by any tenant admin through PATCH /api/devices/:id, so neither
 * says anything about who created the row — they let a live customer device be
 * moved out of its tenant on the strength of a string its own owner typed.
 *
 * `status = 'pending'` was removed for the same reason: a pending row is by
 * definition a device that connected to the broker and was auto-discovered. It is
 * powered on and publishing under modesp/v1/pending/{id} right now, and somebody
 * is about to claim it. Claiming it here rotates its password and drops it off
 * the broker for good. A pending row still qualifies through the SYSTEM-tenant
 * branch, but only once it has gone quiet for IDLE_DAYS.
 */
function classifyExisting(before, targetTenantId, reclaimSet, now) {
  if (before.status === 'deleted' || before.deleted_at !== null) return 'revived';
  if (before.tenant_id === targetTenantId) return 'updated';
  if (before.tenant_id === SYSTEM_TENANT_ID && !before.online && !seenRecently(before, now)) {
    return 'claimed';
  }
  if (reclaimSet.has(before.mqtt_device_id.trim().toUpperCase())) return 'reclaimed';
  return 'foreign';
}

function seenRecently(before, now) {
  if (!before.last_seen) return false;
  return (now - new Date(before.last_seen).getTime()) < IDLE_DAYS * 24 * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
/**
 * Generate + hash a password for every device that needs one.
 *
 * generatePassword() comes from services/mqtt-auth.js rather than being
 * reinvented here: it is 96 bits of base64url, which is what every other
 * credential this platform issues looks like, and what ModESP_EMU expects to be
 * able to type in as a fallback.
 */
async function generateCredentials(fleet, skip) {
  const needing = fleet.filter(d => !skip.has(d.mqttId));
  for (const dev of needing) dev.password = mqttAuth.generatePassword();

  for (let i = 0; i < needing.length; i += HASH_BATCH) {
    const batch = needing.slice(i, i + HASH_BATCH);
    await Promise.all(batch.map(d =>
      bcrypt.hash(d.password, BCRYPT_ROUNDS).then(h => { d.hash = h; })
    ));
  }
  return needing.length;
}

/**
 * Recover the plaintext of the devices --keep-passwords leaves alone.
 *
 * Without this the CSV a --keep-passwords run writes describes ONLY the handful
 * of devices it just created, while the previous CSV — the sole copy of the
 * plaintext for the other 114, since the database stores nothing but bcrypt
 * hashes — is the file being replaced. The fleet would become unloadable and the
 * only way back would be a full rotation, which is exactly what --keep-passwords
 * exists to avoid.
 *
 * A carried password is never trusted on the strength of the file alone: it is
 * bcrypt-compared against the hash the database actually holds, so a stale CSV
 * row silently drops out instead of being handed to the operator as working
 * credentials.
 */
async function carryForwardPasswords(fleet, skip, existing) {
  const carried = new Map();
  if (skip.size === 0) return carried;

  const previous = readCredentialFile(CSV_PATH);
  if (!previous || previous.size === 0) return carried;

  const candidates = fleet.filter(d => skip.has(d.mqttId) && previous.has(d.mqttId));
  for (let i = 0; i < candidates.length; i += HASH_BATCH) {
    const batch = candidates.slice(i, i + HASH_BATCH);
    await Promise.all(batch.map(async (dev) => {
      const rows = existing.get(dev.mqttId) || [];
      const storedHash = rows[0] && rows[0].mqtt_password_hash;
      if (!storedHash) return;
      const plaintext = previous.get(dev.mqttId);
      const ok = await bcrypt.compare(plaintext, storedHash).catch(() => false);
      if (ok) carried.set(dev.mqttId, plaintext);
    }));
  }
  return carried;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
// RFC 4180: quote a field that contains the delimiter, a quote or a newline, and
// double any embedded quote. Device names carry an em dash and № but no commas
// today — escaping anyway means a renamed site can never corrupt the file the
// emulator parses.
function csvField(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const dev of rows) {
    lines.push([
      dev.mqttId,
      dev.name,
      dev.tenant.slug,      // 'tenant' is the SLUG — it is the MQTT topic segment
      dev.username,
      dev.password,
    ].map(csvField).join(','));
  }
  // No UTF-8 BOM. routes/export.js writes one for Excel, but this file is parsed
  // by ModESP_EMU, and a BOM turns the first header cell into "﻿mqtt_device_id".
  return `${lines.join('\n')}\n`;
}

// The inverse of csvField/buildCsv: the same RFC 4180 subset, so a password that
// ever needed quoting round-trips. Only used to read back this script's own file.
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { record.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      record.push(field); field = '';
      records.push(record); record = [];
      if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

/**
 * Read a previously written credential file as Map<mqtt_device_id, plaintext>.
 * Returns null when the file does not exist or does not carry the two columns
 * this script needs — never throws on a malformed file, because a broken CSV must
 * degrade to "cannot carry passwords forward", not abort a provisioning run.
 */
function readCredentialFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const records = parseCsv(text.replace(/^﻿/, ''));
  if (records.length === 0) return null;
  const header = records[0].map(h => h.trim());
  const idIdx = header.indexOf('mqtt_device_id');
  const pwIdx = header.indexOf('mqtt_password');
  if (idIdx === -1 || pwIdx === -1) return null;

  const byId = new Map();
  for (const rec of records.slice(1)) {
    if (rec.length === 1 && rec[0].trim() === '') continue;
    const id = (rec[idIdx] || '').trim().toUpperCase();
    const pw = rec[pwIdx] || '';
    if (id && pw) byId.set(id, pw);
  }
  return byId;
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Write the credential file without ever destroying its predecessor.
 *
 * The old file is the ONLY copy of the plaintext for every device whose password
 * this run did not generate — the database holds bcrypt hashes and nothing else.
 * Unlinking it (the previous behaviour) made a --keep-passwords run delete the
 * credentials of the 114 devices it was protecting and leave a file describing
 * the 6 it created. So: rename, never delete, and create the replacement with
 * 'wx' so an existing file can never be truncated even if the rename raced.
 *
 * The mode argument only applies when the file is CREATED, which is exactly what
 * 'wx' guarantees — the 0600 is therefore real and not inherited from an older,
 * looser file.
 *
 * Returns the path the previous file was moved to, or null.
 */
function writeCredentialFile(file, content) {
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file.replace(/\.csv$/i, '')}.${backupStamp()}.bak.csv`;
    fs.renameSync(file, backup);
    try { fs.chmodSync(backup, 0o600); } catch { /* best effort, see banner */ }
  }

  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    // Never leave the operator with no credential file at all.
    if (backup) { try { fs.renameSync(backup, file); } catch { /* ignore */ } }
    throw err;
  }
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort — see the platform note in the warning banner */
  }
  return backup;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const BUCKETS = [
  ['created',   'no row existed — provisioned fresh'],
  ['revived',   'was soft-deleted — brought back as active'],
  ['claimed',   'was parked and idle in the SYSTEM tenant — claimed'],
  ['reclaimed', 'named by --reclaim — taken over from another tenant'],
  ['updated',   'already in this tenant — metadata refreshed'],
];

function reportWithoutPassword(ids, dryRun) {
  if (!ids.length) return;
  const lead = dryRun
    ? `\n  ${ids.length} device(s) would NOT be in the CSV — their password is kept and its`
    : `\n  ${ids.length} provisioned device(s) are NOT in this CSV because their password`;
  console.log(
    `${lead}\n` +
    `  plaintext could not be recovered from the previous CSV (missing row, or the\n` +
    `  stored bcrypt hash no longer matches it):\n` +
    `     ${ids.join(', ')}\n` +
    `  Load them into ModESP_EMU from the CSV of the run that created them, or re-run\n` +
    `  WITHOUT --keep-passwords to rotate the whole fleet into one fresh file.`
  );
}

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
  const { tenants: requested, reclaim, dryRun, keepPasswords } = args;
  const reclaimSet = new Set(reclaim);

  let pool = null;
  let client = null;
  let txnOpen = false;
  // The CSV is written AFTER COMMIT, so a failure past this point is not a
  // rollback and must not be reported as one — link-devices-to-sites.js makes the
  // same distinction: a non-zero exit never implies the writes were undone.
  let committed = false;

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
    if (dryRun) console.log('\n-- DRY RUN, nothing will be written — no DB rows and no CSV --');
    if (keepPasswords) console.log('-- --keep-passwords: existing credentials are left alone --');
    if (reclaimSet.size) {
      console.log(`-- --reclaim: ${reclaim.join(', ')} may be taken from another tenant --`);
    }

    const fleet = buildFleet(tenants);

    const fleetIds = new Set(fleet.map(d => d.mqttId));
    const strayReclaim = reclaim.filter(id => !fleetIds.has(id));
    if (strayReclaim.length) {
      throw new Error(
        `--reclaim names id(s) outside the fleet range ${fleet[0].mqttId}..` +
        `${fleet[fleet.length - 1].mqttId}: ${strayReclaim.join(', ')}. ` +
        `This script only ever writes ids inside that range.`
      );
    }

    // ---- Sites -----------------------------------------------------------
    const sites = await resolveSites(pool, tenants);
    const absent = sites.filter(s => !s.row);
    if (absent.length) {
      console.error(`\nERROR: ${absent.length} of ${sites.length} demo site(s) do not exist:`);
      for (const s of absent) console.error(`  [${s.tenant.slug}] ${s.name}`);
      console.error(
        '\nThis script never creates sites. Seed them first:\n' +
        '  node src/scripts/seed-demo.js' +
        (requested.length ? `  --tenant ${requested.join(' --tenant ')}` : '') +
        '\nthen re-run this script.'
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\nSites: ${sites.length}/${SITES.length} resolved`);

    // ---- Pre-flight, inside the transaction ------------------------------
    // A --dry-run opens the transaction too and rolls it back: the classification
    // it prints is only meaningful if it was taken under the same locks the real
    // run takes, and it is the only way the two code paths cannot drift apart.
    //
    // The bcrypt work (carry-forward verification, then hashing) now happens with
    // the transaction open and up to 120 device rows locked FOR UPDATE — roughly
    // ten seconds on a dev box. That is deliberate: a lock held a few seconds is
    // cheaper than a classification that can be invalidated before it is used.
    // Nothing the backend does blocks on those rows except the hourly
    // softDeleteCleanup job and a concurrent claim of one of these exact 120 ids.
    client = await pool.connect();
    await client.query('BEGIN');
    txnOpen = true;

    const existing = await scanExisting(client, fleet);
    const now = Date.now();

    // A row stored in a different case occupies the id but will NOT trigger
    // ON CONFLICT (mqtt_device_id), so the upsert would insert a duplicate for the
    // same physical device. Refuse rather than fork the fleet.
    const caseClash = [];
    // A device this run is not allowed to take over.
    const foreign = [];
    const plan = new Map();

    for (const dev of fleet) {
      const rows = existing.get(dev.mqttId) || [];
      if (rows.length === 0) {
        plan.set(dev.mqttId, { bucket: 'created', before: null });
        continue;
      }
      // More than one row on a normalized id means at least one case variant, and
      // a single row may still be stored in the wrong case. Report every variant:
      // keeping only the last row the server returned made this guard depend on an
      // unspecified row order, so the same database state could pass or abort.
      const variants = rows.filter(r => r.mqtt_device_id !== dev.mqttId);
      if (variants.length) {
        caseClash.push(
          `${dev.mqttId}: stored as ${variants.map(r => `"${r.mqtt_device_id}"`).join(', ')}`
        );
        continue;
      }
      const before = rows[0];
      const bucket = classifyExisting(before, dev.tenant.id, reclaimSet, now);
      if (bucket === 'foreign') {
        foreign.push(
          `${dev.mqttId}: status=${before.status} tenant=${before.tenant_id} ` +
          `online=${before.online} last_seen=${before.last_seen ? before.last_seen.toISOString() : '(never)'} ` +
          `name=${before.name === null ? '(none)' : `"${before.name}"`}`
        );
        continue;
      }
      plan.set(dev.mqttId, { bucket, before });
    }

    if (caseClash.length || foreign.length) {
      console.error('\nERROR: the fleet id range collides with rows this script may not take over.');
      if (caseClash.length) {
        console.error(`\n  stored in a different case (${caseClash.length}) — idx_devices_mqtt_id is`);
        console.error('  case-sensitive, so an upsert would create a SECOND row for the same device:');
        for (const line of caseClash) console.error(`     ${line}`);
      }
      if (foreign.length) {
        console.error(`\n  devices this run may not claim (${foreign.length}):`);
        for (const line of foreign) console.error(`     ${line}`);
        console.error(
          '\n  Taking these over would move real hardware into the demo tenant and rotate its\n' +
          '  MQTT password, dropping it off the broker. Retire or rename them by hand, or —\n' +
          '  if you are certain — name each id explicitly:\n' +
          `     --reclaim ${foreign.map(l => l.split(':')[0]).join(' --reclaim ')}`
        );
      }
      await client.query('ROLLBACK');
      txnOpen = false;
      process.exitCode = 1;
      return;
    }

    const unusedReclaim = reclaim.filter(id => {
      const entry = plan.get(id);
      return !entry || entry.bucket !== 'reclaimed';
    });
    if (unusedReclaim.length) {
      console.log(
        `\nNote: --reclaim was not needed for ${unusedReclaim.join(', ')} — ` +
        `those ids are free or already ours.`
      );
    }

    // ---- Credentials -----------------------------------------------------
    // --keep-passwords protects exactly the rows that already hold a hash: their
    // password is not regenerated and the upsert below COALESCEs the stored hash,
    // so the emulator instances already running on them stay connected.
    const skip = new Set();
    if (keepPasswords) {
      for (const dev of fleet) {
        const rows = existing.get(dev.mqttId) || [];
        if (rows[0] && rows[0].mqtt_password_hash) skip.add(dev.mqttId);
      }
    }

    // Recover the plaintext of the kept devices from the previous CSV so the file
    // this run writes still describes the WHOLE fleet. Verified against the stored
    // bcrypt hash, so a stale row can never be handed over as working credentials.
    const carried = await carryForwardPasswords(fleet, skip, existing);
    for (const dev of fleet) {
      if (carried.has(dev.mqttId)) dev.password = carried.get(dev.mqttId);
    }
    if (skip.size) {
      console.log(`\nKept credentials: ${skip.size}, of which ${carried.size} recovered ` +
                  `from ${path.basename(CSV_PATH)} and re-verified against the stored hash`);
    }

    if (!dryRun) {
      const n = await generateCredentials(fleet, skip);
      console.log(`\nCredentials: ${n} password(s) generated (bcrypt cost ${BCRYPT_ROUNDS}), ` +
                  `${skip.size} kept`);
    } else {
      console.log(`\nCredentials: would generate ${fleet.length - skip.size} password(s), ` +
                  `keep ${skip.size}`);
    }

    // ---- Provision -------------------------------------------------------
    const counts = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
    const perTenant = new Map(tenants.map(t => [t.id, { slug: t.slug, name: t.name, n: 0 }]));
    // A device whose plaintext this run does not know: --keep-passwords kept the
    // old hash and the previous CSV could not supply (or could not confirm) the
    // matching password. It must not enter the CSV.
    const withoutPassword = [];
    let rowsWritten = 0;
    let backupPath = null;

    if (dryRun) {
      for (const dev of fleet) {
        const { bucket } = plan.get(dev.mqttId);
        counts[bucket]++;
        perTenant.get(dev.tenant.id).n++;
        if (skip.has(dev.mqttId) && !carried.has(dev.mqttId)) withoutPassword.push(dev.mqttId);
      }
      await client.query('ROLLBACK');
      txnOpen = false;
    } else {
      // mqtt_username has its own UNIQUE index (idx_devices_mqtt_username). The name
      // is derived from the globally unique mqtt_device_id, so the only way it can
      // clash is a row carrying somebody else's id in its username — which would
      // abort the whole transaction at an arbitrary row. Detect it up front instead,
      // inside the transaction so nothing can slip in behind the check.
      //
      // The predicate compares the stored username against the username that row's
      // OWN id implies, rather than excluding the fleet id range wholesale: a row
      // INSIDE the range carrying another fleet member's username (E00050 with
      // mqtt_username='device_E00001') is a real clash and used to slip through,
      // surfacing as a raw 23505 halfway through the loop.
      const { rows: userClash } = await client.query(
        `SELECT mqtt_username, mqtt_device_id FROM devices
          WHERE mqtt_username = ANY($1)
            AND mqtt_username IS DISTINCT FROM ('device_' || mqtt_device_id)`,
        [fleet.map(d => d.username)]
      );
      if (userClash.length) {
        throw new Error(
          `mqtt_username already taken by other device(s): ` +
          userClash.map(r => `${r.mqtt_username} -> ${r.mqtt_device_id}`).join(', ')
        );
      }

      // One statement per device. The site is joined in rather than passed as a bare
      // id so `s.tenant_id = $1` is checked by the DATABASE: there is deliberately no
      // composite FK devices (tenant_id, site_id) -> sites (tenant_id, id), see
      // migration 021, so this predicate is the only thing standing between a typo
      // and a device pointing at another tenant's trade point. If the site does not
      // belong to the tenant the SELECT yields no row, the INSERT writes nothing, and
      // the rowCount check below rolls the whole run back.
      //
      // ON CONFLICT (mqtt_device_id) — the GLOBAL index, not the per-tenant
      // UNIQUE (tenant_id, mqtt_device_id): a soft-deleted row sits in the SYSTEM
      // tenant, so conflicting on the composite key would miss it entirely and the
      // INSERT would fail on the global index instead.
      //
      // WHERE devices.id = $11 makes the conflict action SELF-GUARDING. $11 is the
      // primary key of the exact row the pre-flight classified, or NULL when the
      // pre-flight found nothing. So the UPDATE can only ever touch that row: if
      // something else took the id since BEGIN — a register call, the CSV import,
      // MQTT auto-discovery — the predicate is false or NULL, DO UPDATE writes
      // nothing, RETURNING is empty and the check below rolls the whole run back
      // instead of hijacking a device none of the guards above ever saw.
      //
      // deleted_at = NULL is what actually revives the row. status alone is not
      // enough: link-devices-to-sites.js and every device query treat a non-null
      // deleted_at as deleted regardless of status, so a row revived without it
      // would authenticate against the broker and still be invisible in the UI.
      //
      // latitude/longitude/last_state/last_seen are cleared because a taken-over row
      // may carry the previous owner's coordinates and last telemetry snapshot. They
      // are tenant data and must not survive the move; the map falls back to the
      // site's coordinates via COALESCE(d.latitude, s.latitude) anyway.
      //
      // model_id and the five per-device kW overrides are cleared for the same
      // reason, and it is not cosmetic: device_models is TENANT-SCOPED (migration
      // 019: tenant_id NOT NULL, UNIQUE(tenant_id, name)) and devices.model_id is a
      // plain FK with no composite (tenant_id, model_id) constraint — exactly like
      // site_id. Every consumer joins it WITHOUT a tenant predicate
      // (routes/devices.js GET /:id, routes/telemetry.js energy, services/mqtt.js
      // loadPowerProfiles), so a surviving model_id makes the demo tenant read
      // another tenant's model name and rated power. Soft delete does not clear it
      // (routes/devices.js nulls only name/comment/site_id), so every revived row on
      // prod would carry one.
      const hashExpr = keepPasswords
        ? 'COALESCE(devices.mqtt_password_hash, EXCLUDED.mqtt_password_hash)'
        : 'EXCLUDED.mqtt_password_hash';

      const upsertSql = `
        INSERT INTO devices (
          tenant_id, mqtt_device_id, status, name, location, model, serial_number,
          comment, site_id, mqtt_username, mqtt_password_hash, online,
          deleted_at, latitude, longitude, last_state, last_seen,
          model_id, compressor_kw, evap_fan_kw, cond_fan_kw,
          defrost_heater_kw, standby_kw
        )
        SELECT $1::uuid, $2::varchar, 'active', $3::varchar, $4::varchar, $5::varchar,
               $6::varchar, $7::text, s.id, $9::varchar, $10::varchar, false,
               NULL::timestamptz, NULL::double precision, NULL::double precision,
               NULL::jsonb, NULL::timestamptz,
               NULL::uuid, NULL::numeric, NULL::numeric, NULL::numeric,
               NULL::numeric, NULL::numeric
          FROM sites s
         WHERE s.id = $8::uuid AND s.tenant_id = $1::uuid
        ON CONFLICT (mqtt_device_id) DO UPDATE SET
          tenant_id          = EXCLUDED.tenant_id,
          status             = 'active',
          deleted_at         = NULL,
          name               = EXCLUDED.name,
          location           = EXCLUDED.location,
          model              = EXCLUDED.model,
          serial_number      = EXCLUDED.serial_number,
          comment            = EXCLUDED.comment,
          site_id            = EXCLUDED.site_id,
          mqtt_username      = EXCLUDED.mqtt_username,
          mqtt_password_hash = ${hashExpr},
          online             = false,
          latitude           = NULL,
          longitude          = NULL,
          last_state         = NULL,
          last_seen          = NULL,
          model_id           = NULL,
          compressor_kw      = NULL,
          evap_fan_kw        = NULL,
          cond_fan_kw        = NULL,
          defrost_heater_kw  = NULL,
          standby_kw         = NULL
        WHERE devices.id = $11::uuid
        RETURNING id, (xmax = 0) AS inserted, mqtt_password_hash AS stored_hash
      `;

      for (const dev of fleet) {
        const site = sites[dev.siteIndex];
        const { bucket, before } = plan.get(dev.mqttId);

        const { rows } = await client.query(upsertSql, [
          dev.tenant.id, dev.mqttId, dev.name, dev.location, dev.model,
          dev.serial, dev.comment, site.row.id, dev.username, dev.hash,
          before ? before.id : null,
        ]);

        if (rows.length === 0) {
          // Two causes, and the operator needs to know which: the site moved tenant
          // (or vanished), so the SELECT produced nothing; or the row on this id is
          // no longer the row the pre-flight classified, so the conflict guard
          // refused. Ask the DB rather than guess.
          const { rows: siteNow } = await client.query(
            `SELECT tenant_id FROM sites WHERE id = $1`, [site.row.id]
          );
          const { rows: devNow } = await client.query(
            `SELECT id, tenant_id, status FROM devices WHERE mqtt_device_id = $1`, [dev.mqttId]
          );
          if (!siteNow.length || siteNow[0].tenant_id !== dev.tenant.id) {
            throw new Error(
              `${dev.mqttId}: site ${site.row.id} ("${site.name}") is no longer owned by ` +
              `tenant ${dev.tenant.slug} — refusing to link across tenants`
            );
          }
          throw new Error(
            `${dev.mqttId}: the row on this id changed since the pre-flight ` +
            `(expected ${before ? before.id : 'no row'}, found ` +
            `${devNow.length ? `${devNow[0].id} status=${devNow[0].status} tenant=${devNow[0].tenant_id}` : 'no row'})` +
            ` — refusing to take over a device none of the guards inspected`
          );
        }

        // A row with status='active' and no hash can never authenticate (the broker
        // userquery requires mqtt_password_hash IS NOT NULL) but would still be
        // counted as provisioned and exit 0. It happens when --keep-passwords marked
        // a device as "keep" and its row then disappeared, so ON CONFLICT never fired
        // and the INSERT wrote a NULL hash. Refuse to commit a dead device.
        if (!rows[0].stored_hash) {
          throw new Error(
            `${dev.mqttId}: would be provisioned active with NO mqtt_password_hash — ` +
            `it could never authenticate. Re-run WITHOUT --keep-passwords.`
          );
        }
        if (rows[0].inserted && before) {
          throw new Error(
            `${dev.mqttId}: the row the pre-flight classified (${before.id}) was deleted ` +
            `mid-run and this statement inserted a new one instead — rolling back`
          );
        }

        // Per-device RBAC is granted by users of the OLD tenant. Every shipped path
        // that moves a device between tenants clears it (routes/devices.js), and a
        // surviving grant would be a straight cross-tenant read of demo data.
        if (before && before.tenant_id !== dev.tenant.id) {
          await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [rows[0].id]);
        }

        counts[bucket]++;
        perTenant.get(dev.tenant.id).n++;
        rowsWritten++;

        // Compare against what the DB actually stored, not against what we intended:
        // under --keep-passwords the COALESCE above may have kept an older hash, and
        // writing our unused plaintext into the CSV would hand the operator a
        // password that does not open anything.
        if (dev.hash && rows[0].stored_hash === dev.hash) dev.inCsv = true;
        else if (skip.has(dev.mqttId) && dev.password && before &&
                 rows[0].stored_hash === before.mqtt_password_hash) {
          // Carried forward from the previous CSV and bcrypt-verified earlier in
          // this transaction against this very hash, under the row's FOR UPDATE
          // lock — so `stored_hash === before.mqtt_password_hash` proves the
          // plaintext still opens it.
          dev.inCsv = true;
        } else {
          withoutPassword.push(dev.mqttId);
        }
      }

      await verifyNoCaseForks(client, fleet);
      await client.query('COMMIT');
      txnOpen = false;
      committed = true;
    }

    const csvRows = fleet.filter(d => d.inCsv && d.password);

    // ---- CSV -------------------------------------------------------------
    // Written only after COMMIT: a rolled-back run must never leave a credential
    // file describing a fleet that does not exist.
    if (!dryRun) {
      try {
        backupPath = writeCredentialFile(CSV_PATH, buildCsv(csvRows));
      } catch (err) {
        // The fleet IS provisioned but the plaintext of the passwords this run
        // generated only existed in this process and is now gone. Saying so is the
        // difference between one re-run and a fleet nobody can connect to.
        console.error(`\nERROR: the fleet is provisioned, but the CSV could not be written to`);
        console.error(`  ${CSV_PATH}`);
        console.error(`  ${err.message}`);
        console.error(
          '\n  The passwords this run generated were never stored in plaintext anywhere\n' +
          '  else — the database holds only bcrypt hashes. Any previous CSV is intact\n' +
          '  (this script never deletes one). Fix the path/permissions and re-run\n' +
          '  WITHOUT --keep-passwords to rotate the fleet into a fresh, writable file.'
        );
        process.exitCode = 1;
        return;
      }
    }

    // ---- Report ----------------------------------------------------------
    console.log(`\nDevices (${fleet.length}):`);
    let total = 0;
    for (const [key, note] of BUCKETS) {
      const n = counts[key];
      total += n;
      if (n === 0 && key !== 'created') continue;
      console.log(`  ${key.padEnd(12)} ${String(n).padStart(4)}   ${note}`);
    }
    console.log(`  ${'-'.repeat(12)} ${'-'.repeat(4)}`);
    console.log(`  ${'total'.padEnd(12)} ${String(total).padStart(4)}`);

    if (counts.reclaimed > 0) {
      const taken = fleet.filter(d => plan.get(d.mqttId).bucket === 'reclaimed').map(d => d.mqttId);
      console.log(
        `\n  --reclaim moved ${taken.length} device(s) out of another tenant: ${taken.join(', ')}\n` +
        `  Their MQTT password was rotated — the physical units are now off the broker.`
      );
    }

    console.log('\nPer tenant:');
    for (const t of perTenant.values()) {
      const siteCount = sites.filter(s => s.tenant.slug === t.slug).length;
      console.log(`  ${t.slug.padEnd(16)} ${String(t.n).padStart(4)} device(s) ` +
                  `across ${siteCount} site(s)  ("${t.name}")`);
    }
    console.log(`  sites covered: ${sites.length} of ${SITES.length}, ` +
                `${EQUIPMENT_KIT.length} device(s) each`);

    if (dryRun) {
      // Printed BEFORE the early return: --dry-run --keep-passwords is exactly the
      // combination an operator uses to find out which devices would be left out of
      // the CSV, and this list used to be computed and then thrown away.
      reportWithoutPassword(withoutPassword, true);
      console.log('\nDry run complete. Nothing was written — no device rows, and no CSV ' +
                  '(it would contain live credentials).');
      return;
    }

    console.log(`\nCommitted: ${rowsWritten} device row(s) written, status='active'.`);

    // ---- Credential file -------------------------------------------------
    console.log(`\nEmulator CSV: ${CSV_PATH}`);
    console.log(`  columns: ${CSV_HEADER.join(',')}`);
    console.log(`  rows:    ${csvRows.length} of ${fleet.length} device(s)`);
    reportWithoutPassword(withoutPassword, false);

    console.log(
      `\n  !! THIS FILE CONTAINS PLAINTEXT MQTT PASSWORDS !!\n` +
      `     Anyone holding it can publish telemetry as any device in the demo fleet.\n` +
      `     - Do NOT commit it. It is git-ignored, but \`git add -f\` still beats that.\n` +
      `     - Do NOT paste it into chat, a ticket, or any untrusted channel. Hand it to\n` +
      `       the emulator operator over an encrypted channel and delete it afterwards.\n` +
      `     - Written with mode 0600 (owner read/write only).` +
      (process.platform === 'win32'
        ? `\n       On Windows NTFS ignores POSIX bits — the file inherits the folder ACL,\n` +
          `       so treat the whole demo-data folder as secret on this machine.`
        : '')
    );

    if (backupPath) {
      console.log(
        `\n  The previous CSV was NOT deleted — it was renamed to\n` +
        `     ${backupPath}\n` +
        `  It holds live plaintext for whatever it described. Once ModESP_EMU is\n` +
        `  reloaded from the new file, shred it.`
      );
    }

    if (!keepPasswords) {
      console.log(
        `\n  PASSWORDS WERE ROTATED. Every previously issued emulator-fleet.csv is now dead:\n` +
        `  reload ModESP_EMU from the file above or the fleet will fail MQTT authentication.\n` +
        `  Use --keep-passwords next time to add missing devices without invalidating the fleet.`
      );
    }

    // ---- Broker details --------------------------------------------------
    // Same fallback index.js uses when it tells a device where to connect.
    const brokerHost = process.env.MQTT_PUBLIC_HOST || 'modesp.com.ua';
    console.log('\nBroker connection for ModESP_EMU:');
    console.log(`  host:      ${brokerHost}`);
    console.log('  port:      8883');
    console.log('  TLS:       yes (TLS 1.2, anonymous connections refused)');
    console.log('  username:  the mqtt_username column of the CSV');
    console.log('  password:  the mqtt_password column of the CSV');
    for (const t of perTenant.values()) {
      console.log(`  topics:    modesp/v1/${t.slug}/{mqtt_device_id}/...   (${t.n} device(s))`);
    }
    console.log('  publish:   state/+, status, heartbeat, backfill, backfill/events, backfill/done');
    console.log('  subscribe: cmd/+');
    console.log('\nDone.');
  } catch (err) {
    if (client && txnOpen && !committed) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    }
    console.error('\nProvisioning failed:', err.message);
    console.error(committed
      ? 'The device rows ARE committed; the failure came after COMMIT. Re-run to finish.'
      : 'The transaction was rolled back and no CSV was written — nothing is half done.');
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error('Provisioning failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
