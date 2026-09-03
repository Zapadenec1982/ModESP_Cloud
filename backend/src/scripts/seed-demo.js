#!/usr/bin/env node
'use strict';

/**
 * Seed demo trade points (sites) and service technicians.
 *
 * Populates the map with a realistic Ukrainian retail chain footprint so the
 * geo features (clustering, filters, geo stats, alarm heatmap, service round
 * planning, nearest technician) have something to show.
 *
 * The addresses are FICTIONAL businesses at REAL, geocodable addresses — every
 * one was verified against Nominatim at house-number precision, so the embedded
 * coordinates are correct and the seed works even with geocoding disabled.
 *
 * Usage:
 *   node src/scripts/seed-demo.js --dry-run     # show the plan, change nothing
 *   node src/scripts/seed-demo.js               # seed sites + technicians
 *   node src/scripts/seed-demo.js --tenant a --tenant b   # pin chains to slugs
 *
 * Without --tenant, the two chains are assigned to the first two active
 * non-system tenants, ordered by creation date. --tenant must be given exactly
 * twice (one distinct slug per chain) and may not name the SYSTEM tenant.
 *
 * Idempotent: re-running updates existing rows instead of duplicating them.
 * Devices are NOT created here — they arrive over MQTT from ModESP_EMU and are
 * attached to sites by a separate step once their ids are known.
 *
 * The technician accounts are REAL logins. There is no built-in password: set
 * DEMO_PASSWORD, or let the script generate one and print it once at the end
 * (every run rotates it). With NODE_ENV=production the script refuses to write
 * unless --allow-production is passed.
 */

require('dotenv').config();

const crypto = require('crypto');
const { Pool } = require('pg');
const crypto   = require('crypto');
const { hashPassword } = require('../services/auth');

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

// Technicians get a home base so "nearest technician" and the service round
// planner have something to measure from. Coordinates are the verified city
// coordinates of a site in the same city.
const TECHNICIANS = [
  { email: 'tech.kyiv@demo.modesp',    name: 'Київ',            city: 'Київ',    lat: 50.4498465, lon: 30.5230925 },
  { email: 'tech.kyiv2@demo.modesp',   name: 'Київ (правий берег)', city: 'Київ', lat: 50.4582,    lon: 30.4096 },
  { email: 'tech.lviv@demo.modesp',    name: 'Львів',           city: 'Львів',   lat: 49.8440297, lon: 24.0262455 },
  { email: 'tech.odesa@demo.modesp',   name: 'Одеса',           city: 'Одеса',   lat: 46.484285,  lon: 30.7406466 },
  { email: 'tech.kharkiv@demo.modesp', name: 'Харків',          city: 'Харків',  lat: 49.9991389, lon: 36.2321813 },
  { email: 'tech.dnipro@demo.modesp',  name: 'Дніпро',          city: 'Дніпро',  lat: 48.4645008, lon: 35.0474353 },
];

// The 24 sites in demo-data/sites.json are split into two blocks of 12 by their
// `chain` field. Each block lands in one tenant, and the site name is rebranded
// to that tenant's own name (prod has CocaCoca and PepsyCo), so the demo reads
// as one retail chain per tenant rather than invented brand names.
const CHAIN_SLOTS = ['Морозко', 'Свіжий Крам'];

function siteName(site, tenant) {
  const no = site.name.match(/№(\d+)/);
  return no ? `${tenant.name} №${no[1]}` : `${tenant.name} — ${site.city}`;
}

// The technician accounts this script creates are REAL, loginable accounts, and
// their emails are fully deterministic (`<tenant-slug>.tech.kyiv@demo.modesp`, …).
// A default baked into the repository would therefore be half of a published
// credential for every deployment that ever ran the seed. So: DEMO_PASSWORD when
// the operator supplies one, otherwise a fresh random secret per run, printed
// exactly once — never a constant, and never echoed when the operator already
// knows it (their shell history and CI log would then carry it too).
const DEMO_PASSWORD_FROM_ENV = typeof process.env.DEMO_PASSWORD === 'string'
  && process.env.DEMO_PASSWORD !== '';
const DEMO_PASSWORD = DEMO_PASSWORD_FROM_ENV
  ? process.env.DEMO_PASSWORD
  : crypto.randomBytes(18).toString('base64url');

// Kept deliberately in step with src/scripts/link-devices-to-sites.js: the link
// script reproduces this chain -> tenant mapping, so a difference here silently
// brands the sites in one tenant and looks them up in the other.
function parseArgs(argv) {
  const tenants = [];
  let dryRun = false;
  let allowProduction = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--allow-production') allowProduction = true;
    else if (argv[i] === '--tenant') {
      // A flag-shaped value means the slug is missing; a repeat would collapse both
      // chains into one tenant and still report a clean run.
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--tenant needs a slug');
      if (tenants.includes(value)) throw new Error(`--tenant repeated: ${value}`);
      tenants.push(value);
      i++;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { tenants, dryRun, allowProduction };
}

async function resolveTenants(pool, requested) {
  if (requested.length > 0) {
    // One slug per chain, no more and no fewer: only slots 0 and 1 are ever read.
    if (requested.length !== CHAIN_SLOTS.length) {
      throw new Error(
        `--tenant must be given exactly ${CHAIN_SLOTS.length} times ` +
        `(one slug per chain: ${CHAIN_SLOTS.join(', ')}), got ${requested.length}.`
      );
    }
    // Same two exclusions the default branch uses. The system tenant is active=true
    // (schema.sql seeds it without overriding the default), so without these an
    // explicit `--tenant __system__` would CREATE 12 demo sites inside the
    // pending-device holding tenant — rows nothing ever deletes.
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
  // them in either order — which would make this script and link-devices-to-sites.js
  // disagree about which chain belongs to which tenant. Keep both ORDER BY clauses
  // identical.
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

async function seedSites(pool, tenants, dryRun) {
  let created = 0, updated = 0;
  // Per-chain tallies + the pre-existing site count, to detect the tenant-rename
  // signature below. Site identity is (tenant_id, lower(btrim(name))) and the name
  // is built from the MUTABLE tenants.name, so renaming a tenant makes this seed
  // insert a fresh set of sites and orphan the old ones (with their user_sites
  // grants and weather history) instead of updating them.
  const perChain = new Map();
  if (!dryRun) {
    for (const tenant of tenants) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1`, [tenant.id]
      );
      perChain.set(tenant.id, { created: 0, total: 0, existedBefore: rows[0].n });
    }
  }

  for (const site of SITES) {
    const slot = CHAIN_SLOTS.indexOf(site.chain);
    const tenant = tenants[slot];
    if (!tenant) throw new Error(`no tenant for chain ${site.chain}`);

    const name = siteName(site, tenant);
    if (dryRun) {
      console.log(`  [${tenant.slug}] ${name} — ${site.city}, ${site.address_line}`);
      continue;
    }

    const { rows } = await pool.query(
      `INSERT INTO sites (tenant_id, name, country_code, country, region, city,
                          address_line, postal_code, latitude, longitude,
                          geo_source, geo_precision, geocoded_at, osm_type, osm_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'geocoded',$11,NOW(),$12,$13)
       ON CONFLICT (tenant_id, lower(btrim(name))) DO UPDATE SET
         country_code = EXCLUDED.country_code, country = EXCLUDED.country,
         region = EXCLUDED.region, city = EXCLUDED.city,
         address_line = EXCLUDED.address_line, postal_code = EXCLUDED.postal_code,
         latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         geo_source = EXCLUDED.geo_source, geo_precision = EXCLUDED.geo_precision,
         geocoded_at = EXCLUDED.geocoded_at,
         -- osm_type/osm_id are refreshed too: they are exactly the fields an
         -- operator corrects in sites.json, and leaving them stale while updating
         -- the coordinates is the one outcome a re-run must not produce.
         osm_type = EXCLUDED.osm_type, osm_id = EXCLUDED.osm_id,
         -- The row is now 'geocoded' from verified data; a leftover geo_error would
         -- still be rendered by the Sites page next to a successful geocode.
         geo_error = NULL, geo_attempts = 0,
         updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [tenant.id, name, site.country_code, site.country, site.region, site.city,
       site.address_line, site.postal_code, site.latitude, site.longitude,
       site.geo_precision, site.osm_type, site.osm_id]
    );
    rows[0].inserted ? created++ : updated++;

    const chain = perChain.get(tenant.id);
    if (chain) {
      chain.total++;
      if (rows[0].inserted) chain.created++;
    }
  }

  // All of a chain's sites created new in a tenant that already had sites = the
  // tenant was renamed and the previous set is now orphaned.
  const renamed = [];
  for (const tenant of tenants) {
    const chain = perChain.get(tenant.id);
    if (chain && chain.total > 0 && chain.created === chain.total && chain.existedBefore > 0) {
      renamed.push(`${tenant.slug} ("${tenant.name}"): all ${chain.total} sites created new, ` +
                   `but the tenant already held ${chain.existedBefore} site(s)`);
    }
  }
  return { created, updated, renamed };
}

async function seedTechnicians(pool, tenants, dryRun) {
  let created = 0, updated = 0;
  const hash = dryRun ? null : await hashPassword(DEMO_PASSWORD);

  for (const tenant of tenants) {
    for (const tech of TECHNICIANS) {
      // Namespace the address per tenant so the two chains get their own crews.
      const email = `${tenant.slug}.${tech.email}`;
      if (dryRun) {
        console.log(`  [${tenant.slug}] ${email} — база: ${tech.city}`);
        continue;
      }

      const { rows } = await pool.query(
        `INSERT INTO users (tenant_id, email, password_hash, role,
                            base_latitude, base_longitude, base_address)
         VALUES ($1,$2,$3,'technician',$4,$5,$6)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           -- The password is rotated on every run, so the value printed at the
           -- end is always the one that actually works. Without this an operator
           -- who lost a generated password could never recover the accounts.
           password_hash = EXCLUDED.password_hash,
           base_latitude = EXCLUDED.base_latitude,
           base_longitude = EXCLUDED.base_longitude,
           base_address = EXCLUDED.base_address,
           active = true
         RETURNING id, (xmax = 0) AS inserted`,
        [tenant.id, email, hash, tech.lat, tech.lon, `${tech.city}, Україна`]
      );
      rows[0].inserted ? created++ : updated++;

      // Keep the multi-tenant membership table in sync (migration 010).
      await pool.query(
        `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [rows[0].id, tenant.id]
      );
    }
  }
  return { created, updated };
}

// ── Showcase (plan epic 1.10) ─────────────────────────────
// One read-only login the landing page can hand out, plus a public status link
// of the first site flagged rate_limit_exempt so the demo page never 429s.
const DEMO_VIEWER_EMAIL = process.env.DEMO_VIEWER_EMAIL || 'demo@modesp.com.ua';
const DEMO_APP_URL = (process.env.EMAIL_APP_URL || 'https://modesp.com.ua').replace(/\/$/, '');

async function seedShowcase(pool, tenant, dryRun) {
  if (dryRun) {
    console.log(`  [${tenant.slug}] ${DEMO_VIEWER_EMAIL} (viewer, every site) + showcase link on the first site`);
    return null;
  }
  const hash = await hashPassword(DEMO_PASSWORD);
  const { rows: u } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,'viewer')
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash, role = 'viewer', active = true
     RETURNING id`,
    [tenant.id, DEMO_VIEWER_EMAIL, hash]
  );
  const viewerId = u[0].id;
  await pool.query(
    `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [viewerId, tenant.id]
  );
  await pool.query(
    `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by)
     SELECT $1, s.id, s.tenant_id, $1 FROM sites s WHERE s.tenant_id = $2
     ON CONFLICT DO NOTHING`,
    [viewerId, tenant.id]
  );

  const { rows: sites } = await pool.query(
    `SELECT id, name FROM sites WHERE tenant_id = $1 ORDER BY name LIMIT 1`, [tenant.id]);
  if (sites.length === 0) return { viewerId, token: null, site: null };
  const { rows: existing } = await pool.query(
    `SELECT id FROM site_public_links
      WHERE site_id = $1 AND tenant_id = $2 AND rate_limit_exempt = true
        AND revoked_at IS NULL AND expires_at > NOW()`,
    [sites[0].id, tenant.id]
  );
  if (existing.length) return { viewerId, token: null, site: sites[0].name, existed: true };

  const raw  = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO site_public_links (tenant_id, site_id, token_hash, label, expires_at, created_by, rate_limit_exempt)
     VALUES ($1,$2,$3,'showcase', NOW() + INTERVAL '3650 days', $4, true)`,
    [tenant.id, sites[0].id, tokenHash, viewerId]
  );
  return { viewerId, token: raw, site: sites[0].name };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node src/scripts/seed-demo.js [--dry-run] ' +
                  '[--tenant <slug> --tenant <slug>] [--allow-production]');
    process.exitCode = 1;
    return;
  }
  const { tenants: requested, dryRun, allowProduction } = args;

  // The DB target comes straight from DB_HOST/DB_NAME, so pointing this at a
  // production .env is one shell line away — and the script would then create
  // twelve loginable technician accounts per tenant there. Refuse by default;
  // a --dry-run writes nothing and is always allowed.
  if (process.env.NODE_ENV === 'production' && !dryRun && !allowProduction) {
    console.error('Refusing to seed demo data with NODE_ENV=production.');
    console.error('This creates real, loginable technician accounts. If that is');
    console.error('genuinely what you want, re-run with --allow-production.');
    process.exitCode = 1;
    return;
  }

  let pool = null;

  try {
    // Inside the try: a bad DB_PORT / DSN throws from the constructor, and outside
    // it that surfaced as an unhandled rejection with a raw stack.
    pool = new Pool({
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME || 'modesp_cloud',
      user:     process.env.DB_USER || 'modesp_cloud',
      password: process.env.DB_PASS || '',
    });

    const tenants = await resolveTenants(pool, requested);
    console.log(`Tenants: ${tenants.map((t, i) => `${CHAIN_SLOTS[i]} -> ${t.slug}`).join(', ')}`);

    if (dryRun) console.log('\n-- DRY RUN, nothing will be written --');

    console.log(`\nSites (${SITES.length}):`);
    const s = await seedSites(pool, tenants, dryRun);
    if (!dryRun) {
      console.log(`  ${s.created} created, ${s.updated} updated`);
      for (const line of s.renamed) {
        console.log(
          `\n  !! ${line}.\n` +
          `     Site identity is (tenant_id, name) and the name carries the tenant's\n` +
          `     display name, so this is the signature of a RENAMED tenant: the previous\n` +
          `     set of demo sites is still there, now orphaned. Check for duplicates\n` +
          `     before running link-devices-to-sites.js, which will move the devices onto\n` +
          `     these new rows.`
        );
      }
    }

    console.log(`\nTechnicians (${TECHNICIANS.length} per tenant):`);
    const t = await seedTechnicians(pool, tenants, dryRun);
    if (!dryRun) {
      console.log(`  ${t.created} created, ${t.updated} updated`);
      // Printed ONLY when this run generated it — the operator who set
      // DEMO_PASSWORD already has it, and echoing it would copy the secret into
      // shell history and CI logs for no gain.
      if (DEMO_PASSWORD_FROM_ENV) {
        console.log('  password: (from DEMO_PASSWORD)');
      } else {
        console.log(`  password: ${DEMO_PASSWORD}`);
        console.log('  ^ generated for this run only and shown once. Set DEMO_PASSWORD');
        console.log('    to choose your own; re-running mints a NEW password.');
      }
    }

    console.log(`\nShowcase (${tenants[0].slug}):`);
    const show = await seedShowcase(pool, tenants[0], dryRun);
    if (show) {
      console.log(`  viewer login: ${DEMO_VIEWER_EMAIL} (same password as the technicians)`);
      if (show.token) {
        console.log(`  status page:  ${DEMO_APP_URL}/#/public/site/${show.token}`);
        console.log('  ^ shown once — the token is stored hashed. Put it on the landing page.');
      } else if (show.existed) {
        console.log(`  status page:  showcase link for "${show.site}" already exists (revoke it to mint a new one)`);
      } else {
        console.log('  status page:  no site to link yet');
      }
    }

    console.log('\nDone. Devices are seeded separately, once ModESP_EMU device ids are fixed.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
