'use strict';

// Sites (торгові точки) — the normalized physical location a group of devices
// shares. Mounted at /api/sites by index.js, with no router-level authorize(),
// so every route below states its own maybeAuthorize(...).
//
// Tenant isolation: every statement carries an explicit tenant predicate. The
// superadmin bypass mirrors buildDeviceWhere() in routes/devices.js — the tenant
// predicate is dropped only for role === 'superadmin'. Child queries (devices,
// weather, public links, grants) are scoped by the LOADED SITE's tenant_id, not
// by req.tenantId, so the superadmin path stays consistent instead of silently
// returning nothing.
//
// The migration deliberately ships no set_updated_at() trigger, so EVERY
// `UPDATE sites …` in this file appends `updated_at = NOW()` by hand.

const { Router } = require('express');
const crypto     = require('crypto');
const { z }      = require('zod');
const db         = require('../services/db');
const planMw = require('../middleware/plan');
const mqttSvc    = require('../services/mqtt');
const geocodeSvc = require('../services/geocode');
const weatherSvc = require('../services/weather');
const routingSvc = require('../services/routing');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

const router = Router();

// Auth helper: skip authorize middleware when AUTH_ENABLED=false
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

// ── Constants ─────────────────────────────────────────────

// One sweep of POST /geocode-pending. The OSM policy bars systematic bulk
// querying, so the cap is small and the bulk lane is gated separately.
const BULK_SWEEP_LIMIT = 50;
// Real driving times cost one upstream call each — enrich only the closest few.
const NEAREST_ENRICH_MAX = 5;
// weather_observations is hourly: 400 days ≈ 9600 rows, so the cap is a ceiling
// rather than a page size. Both exist to bound the response, not to paginate.
const WEATHER_HISTORY_MAX_DAYS = 400;
const WEATHER_HISTORY_MAX_ROWS = 10000;
const WEATHER_HISTORY_DEFAULT_DAYS = 7;
// geo_attempts at which a still-unlocated site is parked as 'failed'.
const GEO_FAIL_AFTER_ATTEMPTS = 3;

const SITE_FIELDS = [
  'id', 'tenant_id', 'name', 'country_code', 'country', 'region', 'city',
  'address_line', 'postal_code', 'latitude', 'longitude',
  'geo_source', 'geo_precision', 'geocoded_at',
  'geo_attempts', 'geo_last_attempt_at', 'geo_error',
  'osm_type', 'osm_id', 'timezone', 'notes', 'created_at', 'updated_at',
];
const SITE_COLUMNS   = SITE_FIELDS.map(c => `s.${c}`).join(', ');
const SITE_RETURNING = SITE_FIELDS.join(', ');

// The fields that make an address geocodable, and the ones a geocode result may fill.
const ADDRESS_FIELDS = ['country_code', 'country', 'region', 'city', 'address_line', 'postal_code'];

// Column length limits, so a verbose Nominatim value can never raise 22001.
const MAX_LEN = {
  name: 256, country_code: 2, country: 64, region: 128, city: 128,
  address_line: 256, postal_code: 16, timezone: 64, geo_precision: 16, osm_type: 16,
};

// One in-flight bulk sweep PER TENANT (§ geocode-pending is idempotent). Keyed by
// tenant id rather than a single process-wide boolean: one tenant's 50-site sweep
// runs for about a minute at GEOCODER_RATE_LIMIT_MS=1100, and a plain flag would
// answer every other tenant's admin with `reason: 'sweep_in_progress'` for a sweep
// they never started. Still per-process — two node workers behind nginx each hold
// their own set; a Postgres advisory lock keyed on the tenant id is the fix if the
// deployment ever grows a second worker.
const sweepInFlight = new Set();

// ── Small helpers ─────────────────────────────────────────

function siteNotFound(res) {
  return res.status(404).json({ error: 'not_found', message: 'Site not found', status: 404 });
}

function validationFailed(res, message) {
  return res.status(400).json({ error: 'validation_failed', message, status: 400 });
}

function trimOrNull(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return max ? s.slice(0, max) : s;
}

function normCountryCode(v) {
  const s = trimOrNull(v);
  return s ? s.toUpperCase().slice(0, 2) : null;
}

/** Escape LIKE wildcards so a search for "50%" is not a full-table match. */
function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, m => `\\${m}`);
}

/**
 * WHERE clause for a single site with the superadmin bypass.
 * Mirrors buildDeviceWhere() in routes/devices.js.
 */
function buildSiteWhere(id, req, alias = '') {
  const p = alias ? `${alias}.` : '';
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  if (isSuperAdmin) {
    return { where: `${p}id = $1`, params: [id] };
  }
  return { where: `${p}id = $1 AND ${p}tenant_id = $2`, params: [id, req.tenantId] };
}

/** Load one site with tenant scoping. Returns the row or null. */
async function loadSite(req, id) {
  const { where, params } = buildSiteWhere(id, req, 's');
  const { rows } = await db.query(
    `SELECT ${SITE_COLUMNS} FROM sites s WHERE ${where}`,
    params
  );
  return rows[0] || null;
}

/**
 * Horizontal-authorisation gate for the per-site sub-resources (weather,
 * nearest-technicians). loadSite() is tenant-scoped but carries NO RBAC, so on
 * its own it turns every sub-resource into a site-existence oracle: a viewer
 * with no grants would get 200 for a site id that GET /api/sites/:id answers
 * with 404.
 *
 * Same rule as GET /api/sites/:id: the caller must see at least one device on
 * the site, or hold an explicit user_sites grant. Requires filterDeviceAccess()
 * upstream — req.deviceFilter is null for admin, superadmin and
 * AUTH_ENABLED=false, and those pass straight through.
 */
async function canReadSite(req, site) {
  if (!req.deviceFilter || !req.user) return true;

  const { rows } = await db.query(
    `SELECT 1 FROM devices
      WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' AND id = ANY($3)
      LIMIT 1`,
    [site.id, site.tenant_id, req.deviceFilter]
  );
  if (rows.length > 0) return true;

  const grant = await db.query(
    `SELECT 1 FROM user_sites WHERE site_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [site.id, site.tenant_id, req.user.id]
  );
  return grant.rows.length > 0;
}

/**
 * The tenant a management action applies to. Only a superadmin may aim at
 * another tenant, and only through an explicit ?tenant_id=.
 */
function resolveTenantId(req) {
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  const asked = req.query.tenant_id;
  if (isSuperAdmin && typeof asked === 'string' && isUuidFormat(asked)) return asked;
  return req.tenantId;
}

function hasAddress(site) {
  return ADDRESS_FIELDS.some(f => site[f] !== undefined && site[f] !== null && String(site[f]).trim() !== '');
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return `${s[0]}***${s.slice(at)}`;
}

// ── Geocoding ─────────────────────────────────────────────

/**
 * Geocode one site row and decide what may be written.
 *
 * Returns { meta, reason, applied, failure }:
 *   meta    — 'ok' | 'disabled' | 'failed'   (the value POST /:id/geocode reports)
 *   reason  — extra detail: 'no_match' | 'busy' | 'failed' | 'country_mismatch' | null
 *   applied — column patch to write, ONLY on success (never on failure)
 *   failure — short string for geo_error, set only for outcomes worth counting
 *             as an attempt: a queue timeout ('busy') is not the site's fault.
 */
async function runSiteGeocode(site, lane) {
  const out = (await geocodeSvc.resolveAddress({
    name:         site.name,
    address_line: site.address_line,
    city:         site.city,
    region:       site.region,
    postal_code:  site.postal_code,
    country:      site.country,
    country_code: site.country_code,
  }, { lane })) || {};

  if (out.status === geocodeSvc.OUTCOME.DISABLED) {
    return { meta: 'disabled', reason: null, applied: null, failure: null };
  }
  if (out.status === geocodeSvc.OUTCOME.BUSY) {
    // The job is still running in the background and will warm the cache — this
    // is not a failed address, so it must not bump geo_attempts.
    return { meta: 'failed', reason: 'busy', applied: null, failure: null };
  }

  if (out.status === geocodeSvc.OUTCOME.OK && out.result) {
    // A mangled query fails silently and confidently: corrupted Cyrillic once
    // resolved to French departments with high importance scores and no error.
    // Never store coordinates that contradict the country the admin typed.
    const want = normCountryCode(site.country_code);
    const got  = normCountryCode(out.result.address && out.result.address.country_code);
    if (want && got && want !== got) {
      return { meta: 'failed', reason: 'country_mismatch', applied: null, failure: `country_mismatch:${got}` };
    }
    return { meta: 'ok', reason: null, applied: buildGeocodePatch(site, out.result), failure: null };
  }

  // A provider outage is not the same as "this address does not exist" — the
  // operator reading geo_error needs to know which one to act on.
  const reason = out.status === geocodeSvc.OUTCOME.FAILED ? 'provider_error' : 'no_match';
  return { meta: 'failed', reason, applied: null, failure: reason };
}

/** Columns to write after a successful geocode. Never clears what the admin typed. */
function buildGeocodePatch(site, result) {
  const address = result.address || {};
  const patch = {
    latitude:      result.latitude,
    longitude:     result.longitude,
    geo_source:    'geocoded',
    geo_precision: trimOrNull(result.precision, MAX_LEN.geo_precision),
    geocoded_at:   new Date(),
    osm_type:      trimOrNull(result.osm_type, MAX_LEN.osm_type),
    osm_id:        result.osm_id === undefined ? null : result.osm_id,
    geo_attempts:  0,
    geo_error:     null,
  };

  // Fill only the fields left empty — the admin's own spelling wins.
  for (const f of ADDRESS_FIELDS) {
    const current = site[f];
    if (current !== undefined && current !== null && String(current).trim() !== '') continue;
    const value = f === 'country_code' ? normCountryCode(address[f]) : trimOrNull(address[f], MAX_LEN[f]);
    if (value) patch[f] = value;
  }

  // Kyiv is a city with special status and carries no `state`: group it under
  // its own name rather than creating an "unknown region" bucket in geo-stats.
  const regionAfter = patch.region !== undefined ? patch.region : site.region;
  if (!regionAfter) {
    const cityAfter = patch.city !== undefined ? patch.city : site.city;
    if (cityAfter) patch.region = trimOrNull(cityAfter, MAX_LEN.region);
  }

  return patch;
}

/**
 * IANA timezone for a coordinate, taken from the weather provider's response.
 * That is how sites.timezone is filled without an extra npm dependency; when
 * weather is disabled the column stays NULL and the operator sets it by hand.
 */
async function resolveTimezone(latitude, longitude) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return null;
  try {
    if (!weatherSvc.isEnabled()) return null;
    return trimOrNull(await weatherSvc.timezoneFor(latitude, longitude), MAX_LEN.timezone);
  } catch {
    return null;   // weather is a best-effort enrichment — never fail a site write over it
  }
}

/** Write a geocode patch to an existing site. Tenant-scoped, bumps updated_at. */
async function writeGeocodeResult(site, patch) {
  const keys = Object.keys(patch);
  const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = keys.map(k => (patch[k] === undefined ? null : patch[k]));
  const { rows } = await db.query(
    `UPDATE sites
        SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${keys.length + 1} AND tenant_id = $${keys.length + 2}
      RETURNING ${SITE_RETURNING}`,
    [...values, site.id, site.tenant_id]
  );
  return rows[0] || null;
}

/**
 * Failure bookkeeping. Coordinates, geo_source, geo_precision and geocoded_at are
 * left untouched: an admin fixing a typo during a provider outage must not wipe
 * the site off the map. geo_source flips to 'failed' only for a site that never
 * had a position to lose.
 */
async function recordGeocodeFailure(siteId, tenantId, reason) {
  await db.query(
    `UPDATE sites
        SET geo_attempts        = geo_attempts + 1,
            geo_last_attempt_at = NOW(),
            geo_error           = $3,
            geo_source          = CASE WHEN geo_source = 'none' AND geo_attempts + 1 >= $4
                                       THEN 'failed' ELSE geo_source END,
            updated_at          = NOW()
      WHERE id = $1 AND tenant_id = $2`,
    [siteId, tenantId, String(reason).slice(0, 200), GEO_FAIL_AFTER_ATTEMPTS]
  );
}

/** Background bulk sweep. Never throws, always releases the tenant's claim. */
async function runGeocodeSweep(tenantId, sites, log) {
  try {
    for (const site of sites) {
      try {
        const out = await runSiteGeocode(site, 'bulk');
        if (out.applied) {
          const patch = { ...out.applied };
          if (!site.timezone) {
            const tz = await resolveTimezone(patch.latitude, patch.longitude);
            if (tz) patch.timezone = tz;
          }
          await writeGeocodeResult(site, patch);
        } else if (out.failure) {
          await recordGeocodeFailure(site.id, site.tenant_id, out.failure);
        }
      } catch (err) {
        log?.warn?.({ err, siteId: site.id }, 'Bulk geocode failed for one site');
      }
    }
  } catch (err) {
    log?.error?.({ err }, 'Bulk geocode sweep failed');
  } finally {
    sweepInFlight.delete(tenantId);
  }
}

// ── Validation schemas ────────────────────────────────────

const addressSchema = {
  country_code: z.string().length(2).nullable().optional(),
  country:      z.string().max(64).nullable().optional(),
  region:       z.string().max(128).nullable().optional(),
  city:         z.string().max(128).nullable().optional(),
  address_line: z.string().max(256).nullable().optional(),
  postal_code:  z.string().max(16).nullable().optional(),
  latitude:     z.number().min(-90).max(90).nullable().optional(),
  longitude:    z.number().min(-180).max(180).nullable().optional(),
  timezone:     z.string().max(64).nullable().optional(),
  notes:        z.string().max(4000).nullable().optional(),
};

const createSiteSchema = z.object({
  name: z.string().min(1).max(256),
  ...addressSchema,
  tenant_id: z.string().uuid().optional(),   // superadmin only — create in another tenant
});

// "Any subset" is withdrawn: id, tenant_id and every geo_* provenance column are
// server-owned. tenant_id in particular — moving a site would move every device's
// map visibility and every user_sites grant with it.
const updateSiteSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  ...addressSchema,
}).refine(d => Object.keys(d).length > 0, {
  message: 'At least one field is required',
});

// The only columns PATCH may name. zod already strips unknown keys — this is the
// second lock, because the SET list is built from the parsed keys.
const PATCHABLE = new Set(['name', ...ADDRESS_FIELDS, 'latitude', 'longitude', 'timezone', 'notes']);

const createLinkSchema = z.object({
  label:           z.string().max(128).nullable().optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

const nearestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** latitude and longitude are one value: half a pin is not a position. */
function readCoords(data) {
  const hasLat = Object.prototype.hasOwnProperty.call(data, 'latitude');
  const hasLon = Object.prototype.hasOwnProperty.call(data, 'longitude');
  if (hasLat !== hasLon) {
    return { ok: false, message: 'latitude and longitude must be provided together' };
  }
  const lat = hasLat ? data.latitude : null;
  const lon = hasLon ? data.longitude : null;
  if ((lat === null) !== (lon === null)) {
    return { ok: false, message: 'latitude and longitude must be provided together' };
  }
  return { ok: true, provided: hasLat, latitude: lat, longitude: lon };
}

/** Normalize one request field to what the column can hold. */
function normalizeField(key, value) {
  if (value === undefined || value === null) return null;
  if (key === 'country_code') return normCountryCode(value);
  if (key === 'latitude' || key === 'longitude') return value;
  if (key === 'notes') return String(value).trim() || null;
  return trimOrNull(value, MAX_LEN[key]);
}

/** ISO date range for the weather history endpoint. */
function parseRange(fromRaw, toRaw) {
  const now = new Date();
  let to = now;
  if (fromRaw !== undefined && typeof fromRaw !== 'string') return { ok: false, message: 'from must be an ISO date' };
  if (toRaw !== undefined && typeof toRaw !== 'string') return { ok: false, message: 'to must be an ISO date' };

  if (toRaw) {
    to = new Date(toRaw);
    if (Number.isNaN(to.getTime())) return { ok: false, message: 'to must be an ISO date' };
  }
  let from = new Date(to.getTime() - WEATHER_HISTORY_DEFAULT_DAYS * 86400000);
  if (fromRaw) {
    from = new Date(fromRaw);
    if (Number.isNaN(from.getTime())) return { ok: false, message: 'from must be an ISO date' };
  }
  if (from.getTime() > to.getTime()) return { ok: false, message: 'from must be before to' };
  if (to.getTime() - from.getTime() > WEATHER_HISTORY_MAX_DAYS * 86400000) {
    return { ok: false, message: `Range must not exceed ${WEATHER_HISTORY_MAX_DAYS} days` };
  }
  return { ok: true, from: from.toISOString(), to: to.toISOString() };
}

/** NUMERIC comes back from pg as a string; the chart needs numbers. */
function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ══════════════════════════════════════════════════════════
//  Collection endpoints
// ══════════════════════════════════════════════════════════

// ── GET /api/sites ────────────────────────────────────────
// List sites with device/online/alarm counts.
// Filters: ?search= &country_code= &region= &city= &tenant_id=(superadmin).
// Non-admin callers see only sites where they can see a device or hold a site grant,
// and every count is computed over that visible subset.
//
// No maybeAuthorize(): every authenticated role may read, and filterDeviceAccess()
// does the narrowing. Note that `maybeAuthorize()` with no roles would 403 EVERY
// caller — authorize() tests membership in the given list — so "any role" is
// expressed by omitting it, not by calling it empty.
router.get('/', filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const params = [];
    const where  = [];

    if (isSuperadmin) {
      if (req.query.tenant_id !== undefined) {
        if (typeof req.query.tenant_id !== 'string' || !isUuidFormat(req.query.tenant_id)) {
          return validationFailed(res, 'tenant_id must be a UUID');
        }
        params.push(req.query.tenant_id);
        where.push(`s.tenant_id = $${params.length}`);
      }
    } else {
      params.push(req.tenantId);
      where.push(`s.tenant_id = $${params.length}`);
    }

    if (req.query.country_code) {
      params.push(normCountryCode(req.query.country_code));
      where.push(`upper(s.country_code) = $${params.length}`);
    }
    if (req.query.region) {
      params.push(trimOrNull(req.query.region, MAX_LEN.region));
      where.push(`s.region = $${params.length}`);
    }
    if (req.query.city) {
      params.push(trimOrNull(req.query.city, MAX_LEN.city));
      where.push(`s.city = $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${likeEscape(String(req.query.search).trim().slice(0, 128))}%`);
      const p = `$${params.length}`;
      where.push(`(s.name ILIKE ${p} OR s.city ILIKE ${p} OR s.region ILIKE ${p} OR s.address_line ILIKE ${p})`);
    }

    // Per-device RBAC. req.deviceFilter is non-null only for a technician/viewer
    // under AUTH_ENABLED; [] (no grants) must therefore hide every site.
    let deviceFilterSql = '';
    if (req.deviceFilter) {
      params.push(req.deviceFilter);
      deviceFilterSql = ` AND d.id = ANY($${params.length})`;
      params.push(req.user.id);
      where.push(
        `(EXISTS (SELECT 1 FROM devices d
                   WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id
                     AND d.status = 'active'${deviceFilterSql})
          OR EXISTS (SELECT 1 FROM user_sites us
                      WHERE us.site_id = s.id AND us.tenant_id = s.tenant_id
                        AND us.user_id = $${params.length}))`
      );
    }

    const tenantCols = isSuperadmin ? ', t.slug AS tenant_slug, t.name AS tenant_name' : '';
    const whereSql   = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT ${SITE_COLUMNS}${tenantCols},
              COALESCE(agg.device_count, 0) AS device_count,
              COALESCE(agg.online_count, 0) AS online_count,
              COALESCE(agg.alarm_count, 0)  AS alarm_count
         FROM sites s
         LEFT JOIN tenants t ON t.id = s.tenant_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int                                  AS device_count,
                  COUNT(*) FILTER (WHERE d.online)::int          AS online_count,
                  COUNT(*) FILTER (WHERE al.has_alarm)::int      AS alarm_count
             FROM devices d
             LEFT JOIN LATERAL (
               SELECT true AS has_alarm
                 FROM alarms a
                WHERE a.tenant_id = d.tenant_id
                  AND a.device_id = d.mqtt_device_id
                  AND a.active = true
                LIMIT 1
             ) al ON TRUE
            WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id
              AND d.status = 'active'${deviceFilterSql}
         ) agg ON TRUE
         ${whereSql}
         ORDER BY s.name`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sites/geocode-status ─────────────────────────
// Progress counters for the geocoding indicator. Registered before /:id so the
// literal path is never captured as a site id.
router.get('/geocode-status', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE geo_source = 'none')::int                    AS pending,
              COUNT(*) FILTER (WHERE geo_source IN ('geocoded', 'manual'))::int    AS geocoded,
              COUNT(*) FILTER (WHERE geo_source = 'failed')::int                   AS failed
         FROM sites
        WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({
      data: rows[0],
      meta: {
        geocoder_enabled:  geocodeSvc.isEnabled(),
        bulk_enabled:      geocodeSvc.isBulkEnabled(),
        sweep_in_progress: sweepInFlight.has(tenantId),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sites/geocode-pending ───────────────────────
// Geocode sites that still have no position, in the background. Idempotent: a
// second call while a sweep runs queues nothing.
router.post('/geocode-pending', maybeAuthorize('admin'), async (req, res, next) => {
  // Tracked outside the try so the catch releases only a claim THIS request took.
  // Re-deriving the tenant in the catch would let a request that threw before
  // claiming clear a concurrent sweep's claim for the same tenant.
  let claimed = null;
  try {
    // The OSM policy bars systematic querying of the public instance regardless
    // of pacing, so bulk work has its own gate on top of GEOCODER_PROVIDER.
    if (!geocodeSvc.isBulkEnabled()) {
      return res.json({ data: { queued: 0, reason: 'bulk_disabled' } });
    }
    const tenantId    = resolveTenantId(req);
    const retryFailed = req.query.retry_failed === 'true';

    if (sweepInFlight.has(tenantId)) {
      return res.json({ data: { queued: 0, reason: 'sweep_in_progress' } });
    }
    // Claimed BEFORE the await: two clicks arriving together would both clear the
    // check above and start two sweeps against a 1 req/s provider.
    sweepInFlight.add(tenantId);
    claimed = tenantId;

    const { rows } = await db.query(
      `SELECT ${SITE_RETURNING}
         FROM sites
        WHERE tenant_id = $1
          AND geo_source = ANY($2)
          AND (address_line IS NOT NULL OR city IS NOT NULL OR region IS NOT NULL
               OR country IS NOT NULL OR country_code IS NOT NULL OR postal_code IS NOT NULL)
        ORDER BY created_at
        LIMIT $3`,
      [tenantId, retryFailed ? ['none', 'failed'] : ['none'], BULK_SWEEP_LIMIT]
    );

    if (rows.length === 0) {
      sweepInFlight.delete(tenantId);
      claimed = null;
      return res.json({ data: { queued: 0 } });
    }

    req.auditContext = {
      entityId: null,
      changes: { queued: rows.length, tenant_id: tenantId, retry_failed: retryFailed },
    };

    // Fire-and-forget: a 50-site sweep at 1 req/s would blow the request timeout.
    // runGeocodeSweep never rejects and always releases the tenant's claim.
    runGeocodeSweep(tenantId, rows, req.log);
    claimed = null;   // ownership handed to the sweep, which clears it in a finally

    res.json({ data: { queued: rows.length } });
  } catch (err) {
    if (claimed !== null) sweepInFlight.delete(claimed);
    next(err);
  }
});

// ── POST /api/sites ───────────────────────────────────────
// Create a site. When no pin is given but an address is, geocode inline —
// best effort, and a failure never blocks the creation.
router.post('/', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const parsed = createSiteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationFailed(res, parsed.error.errors[0]?.message || 'Invalid input');
    }

    const coords = readCoords(parsed.data);
    if (!coords.ok) return validationFailed(res, coords.message);

    const isSuperadmin   = req.user && req.user.role === 'superadmin';
    const targetTenantId = (isSuperadmin && parsed.data.tenant_id) ? parsed.data.tenant_id : req.tenantId;

    // Plan capacity (plan epic 1.8): sites against max_sites
    const cap = await planMw.checkCapacity(targetTenantId, 'sites');
    if (!cap.ok) return planMw.planLimitResponse(res, cap);

    const site = {
      tenant_id:     targetTenantId,
      name:          trimOrNull(parsed.data.name, MAX_LEN.name),
      country_code:  normCountryCode(parsed.data.country_code),
      country:       trimOrNull(parsed.data.country, MAX_LEN.country),
      region:        trimOrNull(parsed.data.region, MAX_LEN.region),
      city:          trimOrNull(parsed.data.city, MAX_LEN.city),
      address_line:  trimOrNull(parsed.data.address_line, MAX_LEN.address_line),
      postal_code:   trimOrNull(parsed.data.postal_code, MAX_LEN.postal_code),
      latitude:      coords.latitude,
      longitude:     coords.longitude,
      timezone:      trimOrNull(parsed.data.timezone, MAX_LEN.timezone),
      notes:         normalizeField('notes', parsed.data.notes),
      geo_source:    coords.latitude !== null ? 'manual' : 'none',
      geo_precision: null,
      geocoded_at:   null,
      osm_type:      null,
      osm_id:        null,
    };
    if (!site.name) return validationFailed(res, 'name is required');

    let geocoder = coords.latitude !== null ? 'manual' : 'skipped';
    if (site.latitude === null && hasAddress(site)) {
      const out = await runSiteGeocode(site, 'interactive');
      geocoder = out.meta;
      if (out.applied) {
        Object.assign(site, out.applied);
      } else if (out.failure) {
        site.geo_attempts        = 1;
        site.geo_last_attempt_at = new Date();
        site.geo_error           = out.failure;
      }
    }

    if (site.latitude !== null && !site.timezone) {
      site.timezone = await resolveTimezone(site.latitude, site.longitude);
    }

    const keys = Object.keys(site);
    const { rows } = await db.query(
      `INSERT INTO sites (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${SITE_RETURNING}`,
      keys.map(k => (site[k] === undefined ? null : site[k]))
    );

    req.auditContext = {
      entityId: rows[0].id,
      changes: { after: { name: rows[0].name, city: rows[0].city, country_code: rows[0].country_code } },
    };

    res.status(201).json({ data: { ...rows[0], device_count: 0, online_count: 0, alarm_count: 0 }, meta: { geocoder } });
  } catch (err) {
    if (err.code === '23505') {   // uq_sites_tenant_name
      return res.status(409).json({
        error: 'conflict',
        message: 'A site with this name already exists in this tenant',
        status: 409,
      });
    }
    if (err.code === '23503') {   // tenant_id FK — a superadmin aiming at a ghost tenant
      return res.status(400).json({
        error: 'invalid_tenant',
        message: 'Tenant does not exist',
        status: 400,
      });
    }
    next(err);
  }
});

// ══════════════════════════════════════════════════════════
//  Single-site endpoints
// ══════════════════════════════════════════════════════════

// ── GET /api/sites/:id ────────────────────────────────────
// Site detail with its devices. A non-admin caller sees only the devices they
// may see; a caller who can see none of them and holds no grant gets a 404
// rather than a confirmation that the site exists.
// No maybeAuthorize() — same reasoning as GET /api/sites above.
router.get('/:id', filterDeviceAccess(), async (req, res, next) => {
  try {
    // A non-UUID compared against a uuid column raises 22P02 → 500. 404, not 400:
    // a malformed id must not be distinguishable from a nonexistent one.
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    const params = [site.id, site.tenant_id];
    let filterSql = '';
    if (req.deviceFilter) {
      params.push(req.deviceFilter);
      filterSql = ` AND d.id = ANY($${params.length})`;
    }

    const { rows } = await db.query(
      `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.status, d.online,
              d.latitude, d.longitude
         FROM devices d
        WHERE d.site_id = $1 AND d.tenant_id = $2 AND d.status = 'active'${filterSql}
        ORDER BY d.name NULLS LAST, d.mqtt_device_id`,
      params
    );

    if (req.deviceFilter && rows.length === 0) {
      const grant = await db.query(
        `SELECT 1 FROM user_sites WHERE site_id = $1 AND tenant_id = $2 AND user_id = $3`,
        [site.id, site.tenant_id, req.user.id]
      );
      if (grant.rows.length === 0) return siteNotFound(res);
    }

    // Active alarms come from the alarms table so the detail counts agree with
    // the list; live MQTT state adds the not-yet-persisted transitions.
    let alarming = new Set();
    if (rows.length > 0) {
      const alarmRes = await db.query(
        `SELECT DISTINCT device_id FROM alarms
          WHERE tenant_id = $1 AND active = true AND device_id = ANY($2)`,
        [site.tenant_id, rows.map(r => r.mqtt_device_id)]
      );
      alarming = new Set(alarmRes.rows.map(r => r.device_id));
    }

    const devices = rows.map(row => {
      const live = mqttSvc.getDeviceState(row.mqtt_device_id);
      const meta = mqttSvc.getDeviceMeta(row.mqtt_device_id);
      return {
        ...row,
        online:       meta ? meta.online : row.online,
        alarm_active: (live ? !!live['protection.alarm_active'] : false) || alarming.has(row.mqtt_device_id),
        air_temp:     live ? live['equipment.air_temp'] ?? null : null,
      };
    });

    res.json({
      data: {
        ...site,
        devices,
        device_count: devices.length,
        online_count: devices.filter(d => d.online).length,
        alarm_count:  devices.filter(d => d.alarm_active).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/sites/:id ──────────────────────────────────
// Update a site. An address change triggers a re-geocode, but coordinates are
// overwritten ONLY on success — a provider outage must not wipe a site off the map.
router.patch('/:id', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const parsed = updateSiteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationFailed(res, parsed.error.errors[0]?.message || 'Invalid input');
    }

    const coords = readCoords(parsed.data);
    if (!coords.ok) return validationFailed(res, coords.message);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    // The SET list is built from the PARSED keys only. zod strips unknown keys,
    // which is the only reason this pattern is safe; iterating req.body would
    // make {"name = 'x', tenant_id = '…' --": 1} arbitrary SQL for a tenant admin.
    const patch = {};
    for (const key of Object.keys(parsed.data)) {
      if (!PATCHABLE.has(key)) continue;
      patch[key] = normalizeField(key, parsed.data[key]);
    }
    if (patch.name === null) return validationFailed(res, 'name must not be empty');

    // A hand-dropped pin owns the position: clear the provenance that no longer
    // describes it, so the map never shows OSM ids belonging to other coordinates.
    if (coords.provided) {
      patch.geo_source    = coords.latitude === null ? 'none' : 'manual';
      patch.geo_precision = null;
      patch.geocoded_at   = null;
      patch.osm_type      = null;
      patch.osm_id        = null;
      patch.geo_attempts  = 0;
      patch.geo_error     = null;
    }

    let geocoder = 'skipped';
    const addressChanged = ADDRESS_FIELDS.some(
      f => f in patch && String(patch[f] ?? '') !== String(site[f] ?? '')
    );

    if (!coords.provided && addressChanged) {
      const merged = { ...site, ...patch };
      if (hasAddress(merged)) {
        const out = await runSiteGeocode(merged, 'interactive');
        geocoder = out.meta;
        if (out.applied) {
          Object.assign(patch, out.applied);
        } else if (out.failure) {
          // Same bookkeeping as recordGeocodeFailure(), folded into this UPDATE.
          const attempts = (site.geo_attempts || 0) + 1;
          patch.geo_attempts        = attempts;
          patch.geo_last_attempt_at = new Date();
          patch.geo_error           = String(out.failure).slice(0, 200);
          if (site.geo_source === 'none' && attempts >= GEO_FAIL_AFTER_ATTEMPTS) {
            patch.geo_source = 'failed';
          }
        }
      }
    }

    const finalLat = 'latitude'  in patch ? patch.latitude  : site.latitude;
    const finalLon = 'longitude' in patch ? patch.longitude : site.longitude;
    const finalTz  = 'timezone'  in patch ? patch.timezone  : site.timezone;
    if (finalLat !== null && finalLat !== undefined && !finalTz) {
      const tz = await resolveTimezone(finalLat, finalLon);
      if (tz) patch.timezone = tz;
    }

    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return res.json({ data: site, meta: { geocoder } });
    }

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values     = keys.map(k => (patch[k] === undefined ? null : patch[k]));
    const offset     = values.length;
    const { where, params: whereParams } = buildSiteWhere(req.params.id, req);
    const shiftedWhere = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);

    const { rows } = await db.query(
      `UPDATE sites
          SET ${setClauses.join(', ')}, updated_at = NOW()
        WHERE ${shiftedWhere}
        RETURNING ${SITE_RETURNING}`,
      [...values, ...whereParams]
    );

    if (rows.length === 0) return siteNotFound(res);

    const before = {}, after = {};
    for (const k of keys) {
      before[k] = site[k] === undefined ? null : site[k];
      after[k]  = rows[0][k];
    }
    req.auditContext = { entityId: rows[0].id, changes: { before, after } };

    res.json({ data: rows[0], meta: { geocoder } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'conflict',
        message: 'A site with this name already exists in this tenant',
        status: 409,
      });
    }
    next(err);
  }
});

// ── DELETE /api/sites/:id ─────────────────────────────────
// 409 while devices are attached, unless ?force=true detaches them first.
router.delete('/:id', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    // Strict flag parsing: `if (req.query.force)` would treat ?force=false as true.
    const force = req.query.force === 'true';

    const { rows: attached } = await db.query(
      `SELECT id FROM devices WHERE site_id = $1 AND tenant_id = $2 ORDER BY id`,
      [site.id, site.tenant_id]
    );

    if (attached.length > 0 && !force) {
      return res.status(409).json({
        error: 'site_has_devices',
        message: `Site still has ${attached.length} device(s). Re-send with ?force=true to detach them.`,
        status: 409,
        device_count: attached.length,
      });
    }

    // Audit context BEFORE the transaction: the auto-audit middleware strips the
    // query string and leaves changes: null otherwise, so a forced delete would be
    // indistinguishable from deleting an empty site while site_id is nulled for good.
    req.auditContext = {
      entityId: site.id,
      changes: {
        before: { name: site.name, device_count: attached.length },
        force,
        detached_device_ids: attached.map(r => r.id),
      },
    };

    await db.transaction(async (client) => {
      if (attached.length > 0) {
        await client.query(
          `UPDATE devices SET site_id = NULL WHERE site_id = $1 AND tenant_id = $2`,
          [site.id, site.tenant_id]
        );
      }
      // user_sites / weather_observations / site_public_links cascade through
      // their composite (tenant_id, site_id) foreign keys.
      await client.query(`DELETE FROM sites WHERE id = $1 AND tenant_id = $2`, [site.id, site.tenant_id]);
    });

    res.json({ data: { deleted: true, id: site.id, detached_devices: attached.length } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sites/:id/geocode ───────────────────────────
// Force a re-geocode. Always 200 with meta.geocoder so the UI can say why
// nothing happened instead of silently no-oping.
router.post('/:id/geocode', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    if (!geocodeSvc.isEnabled()) {
      return res.json({ data: site, meta: { geocoder: 'disabled' } });
    }
    if (!hasAddress(site)) {
      return res.json({ data: site, meta: { geocoder: 'failed', reason: 'no_address' } });
    }

    const out = await runSiteGeocode(site, 'interactive');

    if (out.applied) {
      const patch = { ...out.applied };
      if (!site.timezone) {
        const tz = await resolveTimezone(patch.latitude, patch.longitude);
        if (tz) patch.timezone = tz;
      }
      const updated = await writeGeocodeResult(site, patch);
      if (!updated) return siteNotFound(res);

      req.auditContext = {
        entityId: site.id,
        changes: {
          before: { latitude: site.latitude, longitude: site.longitude, geo_source: site.geo_source },
          after:  { latitude: updated.latitude, longitude: updated.longitude, geo_source: updated.geo_source },
        },
      };
      return res.json({ data: updated, meta: { geocoder: 'ok' } });
    }

    if (out.failure) {
      await recordGeocodeFailure(site.id, site.tenant_id, out.failure);
    }
    req.auditContext = { entityId: site.id, changes: { geocoder: out.meta, reason: out.reason } };

    const fresh = await loadSite(req, site.id);
    res.json({ data: fresh || site, meta: { geocoder: out.meta, reason: out.reason } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sites/:id/weather/history ────────────────────
// Historical outdoor conditions, straight from weather_observations.
// Registered before /:id/weather for clarity — Express matches exact paths.
// Any role that may READ THE SITE: outdoor weather is public data, but "which
// site ids exist in this tenant" is not — hence the same gate as GET /:id.
router.get('/:id/weather/history', filterDeviceAccess(), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);
    if (!await canReadSite(req, site)) return siteNotFound(res);

    const range = parseRange(req.query.from, req.query.to);
    if (!range.ok) return validationFailed(res, range.message);

    const { rows } = await db.query(
      `SELECT observed_at, temp_c, humidity, pressure_hpa, wind_ms, weather_code
         FROM weather_observations
        WHERE site_id = $1 AND tenant_id = $2
          AND observed_at >= $3::timestamptz
          AND observed_at <= $4::timestamptz
        ORDER BY observed_at
        LIMIT $5`,
      [site.id, site.tenant_id, range.from, range.to, WEATHER_HISTORY_MAX_ROWS]
    );

    res.json({
      data: rows.map(r => ({
        observed_at:  r.observed_at,
        temp_c:       toNumber(r.temp_c),
        humidity:     toNumber(r.humidity),
        pressure_hpa: toNumber(r.pressure_hpa),
        wind_ms:      toNumber(r.wind_ms),
        weather_code: toNumber(r.weather_code),
      })),
      meta: { from: range.from, to: range.to, truncated: rows.length >= WEATHER_HISTORY_MAX_ROWS },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sites/:id/weather ────────────────────────────
// Current conditions + hourly forecast. Open-Meteo is disabled by default and
// the endpoint degrades to { data: null } with a reason — never a 500.
// Any role that may READ THE SITE — same gate as GET /:id, so an unentitled
// caller cannot use this endpoint to enumerate the tenant's site ids.
router.get('/:id/weather', filterDeviceAccess(), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);
    if (!await canReadSite(req, site)) return siteNotFound(res);

    if (!weatherSvc.isEnabled()) {
      return res.json({ data: null, meta: { weather: 'disabled' } });
    }
    if (site.latitude === null || site.longitude === null) {
      return res.json({ data: null, meta: { weather: 'no_coordinates' } });
    }

    const parsedHours = z.coerce.number().int().min(1).max(168).optional().safeParse(req.query.hours);
    if (!parsedHours.success) return validationFailed(res, 'hours must be an integer between 1 and 168');
    const hours = parsedHours.data ?? 24;

    const w = await weatherSvc.siteWeather(site.latitude, site.longitude, hours);
    if (!w) {
      return res.json({ data: null, meta: { weather: 'unavailable' } });
    }

    res.json({
      data: {
        current:  w.current || null,
        forecast: w.forecast || [],
        timezone: w.timezone || site.timezone || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sites/:id/nearest-technicians ────────────────
// Staff with a home base, closest first. Distance is haversine (always
// available); driving duration needs OSRM and is null without it.
//
// The response carries exactly { id, email, distance_km, duration_s, base_address }
// — never a password hash, token, telegram id or any other user column. A
// technician caller sees a masked label and no home address: they may find the
// nearest colleague without enumerating the roster's contact details.
//
// filterDeviceAccess() + canReadSite() are load-bearing here, not decoration:
// without them any technician could ask about any site id in the tenant, and
// three such queries triangulate a colleague's home base from the returned
// distances — the very base_address the masking below exists to withhold.
router.get('/:id/nearest-technicians', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const parsedQ = nearestSchema.safeParse({ limit: req.query.limit });
    if (!parsedQ.success) return validationFailed(res, 'limit must be an integer between 1 and 50');
    const limit = parsedQ.data.limit ?? 5;

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);
    if (!await canReadSite(req, site)) return siteNotFound(res);

    if (site.latitude === null || site.longitude === null) {
      return res.json({ data: [], meta: { reason: 'site_has_no_coordinates', routing: null } });
    }

    // users.tenant_id, never a user_tenants join — that would pull in staff who
    // merely have a membership in another tenant.
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.base_address, u.base_latitude, u.base_longitude,
              6371 * 2 * asin(sqrt(least(1.0::double precision,
                power(sin(radians(u.base_latitude - $2) / 2), 2) +
                cos(radians($2)) * cos(radians(u.base_latitude)) *
                power(sin(radians(u.base_longitude - $3) / 2), 2)
              ))) AS distance_km
         FROM users u
        WHERE u.tenant_id = $1
          AND u.active = true
          AND u.role IN ('technician', 'admin')
          AND u.base_latitude IS NOT NULL
          AND u.base_longitude IS NOT NULL
        ORDER BY distance_km ASC
        LIMIT $4`,
      [site.tenant_id, site.latitude, site.longitude, limit]
    );

    // Real driving times for the closest few only — each is one upstream call.
    const durations = new Map();
    if (routingSvc.isEnabled() && rows.length > 0) {
      const top = rows.slice(0, NEAREST_ENRICH_MAX);
      const legs = await Promise.allSettled(top.map(r => routingSvc.route([
        { lat: Number(r.base_latitude), lon: Number(r.base_longitude) },
        { lat: site.latitude,           lon: site.longitude },
      ])));
      legs.forEach((leg, i) => {
        if (leg.status === 'fulfilled' && leg.value && Number.isFinite(leg.value.total_duration_s)) {
          durations.set(top[i].id, leg.value.total_duration_s);
        }
      });
    }

    const isStaff = !AUTH_ENABLED || !req.user
      || req.user.role === 'admin' || req.user.role === 'superadmin';

    res.json({
      data: rows.map(r => ({
        id:           r.id,
        email:        isStaff ? r.email : maskEmail(r.email),
        // Coarsened to whole kilometres for a non-staff caller. 0.1 km precision
        // over three sites they serve trilaterates a colleague's home base to
        // ~100 m, which is exactly the base_address withheld one line below;
        // whole kilometres keep the ranking useful without handing over a point.
        distance_km:  isStaff
          ? Math.round(toNumber(r.distance_km) * 10) / 10
          : Math.round(toNumber(r.distance_km)),
        duration_s:   durations.has(r.id) ? durations.get(r.id) : null,
        base_address: isStaff ? (r.base_address || null) : null,
      })),
      meta: { routing: routingSvc.isEnabled() ? 'osrm' : null },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════
//  Public status links
// ══════════════════════════════════════════════════════════

// ── GET /api/sites/:id/public-links ───────────────────────
// Metadata only. token_hash never leaves the database, and the raw token cannot
// be recovered from it — that is the point.
router.get('/:id/public-links', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    const { rows } = await db.query(
      `SELECT id, label, expires_at, revoked_at, view_count, last_viewed,
              created_by, created_at,
              (revoked_at IS NULL AND expires_at > NOW()) AS active
         FROM site_public_links
        WHERE site_id = $1 AND tenant_id = $2
        ORDER BY created_at DESC`,
      [site.id, site.tenant_id]
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sites/:id/public-links ──────────────────────
// Mint a public status token. The raw token is returned exactly once here and
// never again: only its sha256 is stored, it is never logged, and it never
// reaches audit_log (which is protected by an immutability trigger, so a token
// written there could never be scrubbed).
router.post('/:id/public-links', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id)) return siteNotFound(res);

    const parsed = createLinkSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return validationFailed(res, parsed.error.errors[0]?.message || 'Invalid input');
    }

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    // 256 bits of CSPRNG. sha256 is fast, so the hash is only as strong as its
    // input — never Math.random, never a short id. This token is the sole
    // credential guarding the page.
    const raw       = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const days      = parsed.data.expires_in_days ?? 90;

    const { rows } = await db.query(
      `INSERT INTO site_public_links (tenant_id, site_id, token_hash, label, expires_at, created_by)
       VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 day'), $6)
       RETURNING id, label, expires_at, revoked_at, view_count, last_viewed, created_by, created_at`,
      [site.tenant_id, site.id, tokenHash, trimOrNull(parsed.data.label, 128), days, req.user?.id || null]
    );

    // Never the token, never the created row verbatim.
    req.auditContext = {
      entityId: site.id,
      changes: { site_id: site.id, label: rows[0].label, expires_at: rows[0].expires_at },
    };

    res.status(201).json({
      data: { ...rows[0], token: raw, active: true },
      meta: { token_shown_once: true },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/sites/:id/public-links/:linkId ────────────
// Revoke, not erase: a revoked row keeps the evidence of who shared what, and
// GET /api/public/site answers 404 for it exactly as for an unknown token.
router.delete('/:id/public-links/:linkId', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    if (!isUuidFormat(req.params.id) || !isUuidFormat(req.params.linkId)) {
      return res.status(404).json({ error: 'not_found', message: 'Public link not found', status: 404 });
    }

    const site = await loadSite(req, req.params.id);
    if (!site) return siteNotFound(res);

    const { rows } = await db.query(
      `UPDATE site_public_links
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id = $1 AND site_id = $2 AND tenant_id = $3
        RETURNING id, label, revoked_at`,
      [req.params.linkId, site.id, site.tenant_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Public link not found', status: 404 });
    }

    req.auditContext = {
      entityId: site.id,
      changes: { site_id: site.id, link_id: rows[0].id, label: rows[0].label, action: 'revoke' },
    };

    res.json({ data: { revoked: true, id: rows[0].id, revoked_at: rows[0].revoked_at } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
