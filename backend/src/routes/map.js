'use strict';

/**
 * Fleet map — mounted at /api/map (see src/index.js).
 *
 *   GET  /api/map/devices        GeoJSON FeatureCollection, one Feature per site
 *   GET  /api/map/filters        option lists for the filter bar
 *   GET  /api/map/alarm-heatmap  [[lat, lon, weight], …], aggregated in SQL
 *   GET  /api/map/isochrones     drive-time coverage polygons (or approximate rings)
 *   POST /api/map/route          service-round planner (OSRM /trip + degradation)
 *
 * Every device-facing query is tenant-scoped with the superadmin bypass from
 * devices.js, and every one of them applies req.deviceFilter / req.deviceMqttIds:
 * a site in which the caller has no visible device produces no Feature, no
 * filter option and no heat point.
 *
 * Effective device coordinates are COALESCE(d.latitude, s.latitude) — the
 * per-device override wins over the site. This COALESCE belongs here and in
 * DeviceLocationMap only; the device CRUD payload keeps the raw columns.
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const { requireFeature } = require('../middleware/plan');
const mqttSvc    = require('../services/mqtt');
const routingSvc = require('../services/routing');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

const router = Router();

// Auth helper: skip authorize middleware when AUTH_ENABLED=false
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

// Payload guards. The map is a browser view: a tenant with 40k devices must get
// a truncated map with a flag, not a 60 MB response.
const MAX_MAP_DEVICES  = 5000;
const MAX_HEAT_POINTS  = 5000;
const MAX_ROUTE_POINTS = 25;    // OSRM /trip ceiling in services/routing.js
const HEATMAP_DEFAULT_DAYS = 30;

const VALID_STATUS = ['online', 'offline', 'alarm', 'all'];

// ── Small helpers ────────────────────────────────────────

function badRequest(res, message) {
  return res.status(400).json({ error: 'validation_failed', message, status: 400 });
}

/** ILIKE metacharacters are not injection, but they make ?q= behave unpredictably. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, c => `\\${c}`);
}

/** @returns {Date|null} null for a missing or unparsable value */
function parseIsoDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse and validate every filter shared by the map endpoints.
 * Nothing here reaches SQL as text — the returned values are only ever bound
 * as parameters by buildDeviceScope().
 * @returns {{ error: string }|{ filters: object }}
 */
function parseCommonFilters(req) {
  const q = req.query;
  const filters = {};

  const uuid = (name) => {
    const raw = q[name];
    if (raw === undefined || String(raw).trim() === '') return null;
    const value = String(raw).trim();
    if (!isUuidFormat(value)) return { error: `Invalid ${name}` };
    return { value };
  };

  const text = (name, max) => {
    const raw = q[name];
    if (raw === undefined || String(raw).trim() === '') return null;
    const value = String(raw).trim();
    if (value.length > max) return { error: `${name} must be at most ${max} characters` };
    return { value };
  };

  for (const name of ['site_id', 'user_id', 'tenant_id']) {
    const parsed = uuid(name);
    if (parsed && parsed.error) return { error: parsed.error };
    if (parsed) filters[name] = parsed.value;
  }

  for (const [name, max] of [['region', 128], ['city', 128], ['model', 64], ['firmware_version', 16], ['q', 200]]) {
    const parsed = text(name, max);
    if (parsed && parsed.error) return { error: parsed.error };
    if (parsed) filters[name === 'q' ? 'search' : name] = parsed.value;
  }

  if (q.country_code !== undefined && String(q.country_code).trim() !== '') {
    const cc = String(q.country_code).trim();
    if (!/^[A-Za-z]{2}$/.test(cc)) return { error: 'country_code must be a 2-letter ISO code' };
    filters.country_code = cc.toUpperCase();
  }

  const status = q.status === undefined || String(q.status).trim() === '' ? 'all' : String(q.status).trim();
  if (!VALID_STATUS.includes(status)) return { error: `status must be one of ${VALID_STATUS.join('|')}` };
  filters.status = status;

  // bbox=minLon,minLat,maxLon,maxLat — unvalidated this is a guaranteed 22P02/22003
  // (→ 500) and the only place a caller can feed raw text into a numeric column.
  if (q.bbox !== undefined && String(q.bbox).trim() !== '') {
    const parts = String(q.bbox).split(',');
    if (parts.length !== 4 || parts.some(p => p.trim() === '')) {
      return { error: 'bbox must be minLon,minLat,maxLon,maxLat' };
    }
    const [minLon, minLat, maxLon, maxLat] = parts.map(p => Number(p.trim()));
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return { error: 'bbox must contain four numbers' };
    }
    if (minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) {
      return { error: 'bbox latitudes must be between -90 and 90' };
    }
    if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180) {
      return { error: 'bbox longitudes must be between -180 and 180' };
    }
    if (minLon > maxLon || minLat > maxLat) {
      return { error: 'bbox min values must not exceed max values' };
    }
    filters.bbox = { minLon, minLat, maxLon, maxLat };
  }

  return { filters };
}

/**
 * Build the shared WHERE fragments for a query rooted at
 * `devices d LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id`.
 *
 * @param {object}  req
 * @param {object}  filters   from parseCommonFilters()
 * @param {object} [opts]
 * @param {boolean} [opts.rbac=true]         apply req.deviceFilter on d.id
 * @param {boolean} [opts.bbox=true]         apply the bbox on effective coordinates
 * @param {boolean} [opts.optionFilters=true] apply the user-chosen facet filters
 * @returns {{ where: string[], params: any[] }}
 */
function buildDeviceScope(req, filters, opts = {}) {
  const { rbac = true, bbox = true, optionFilters = true } = opts;
  const isSuperadmin = req.user && req.user.role === 'superadmin';

  const where  = [];
  const params = [];
  const p = value => { params.push(value); return `$${params.length}`; };

  // Tenant isolation, with the same superadmin bypass devices.js uses.
  if (isSuperadmin) {
    where.push(`d.status = 'active'`);
    if (filters.tenant_id) where.push(`d.tenant_id = ${p(filters.tenant_id)}`);
  } else {
    where.push(`d.tenant_id = ${p(req.tenantId)}`);
    where.push(`d.status <> 'deleted'`);
  }

  // Per-device RBAC (user_devices ∪ user_sites). null = admin/superadmin = no limit.
  if (rbac && req.deviceFilter) where.push(`d.id = ANY(${p(req.deviceFilter)})`);

  if (optionFilters) {
    if (filters.site_id)          where.push(`d.site_id = ${p(filters.site_id)}`);
    if (filters.country_code)     where.push(`s.country_code = ${p(filters.country_code)}`);
    if (filters.region)           where.push(`s.region = ${p(filters.region)}`);
    if (filters.city)             where.push(`s.city = ${p(filters.city)}`);
    if (filters.model)            where.push(`d.model = ${p(filters.model)}`);
    if (filters.firmware_version) where.push(`d.firmware_version = ${p(filters.firmware_version)}`);

    if (filters.search) {
      const pattern = `%${escapeLike(filters.search)}%`;
      where.push(`(d.name ILIKE ${p(pattern)} OR d.mqtt_device_id ILIKE ${p(pattern)}
                   OR d.location ILIKE ${p(pattern)} OR s.name ILIKE ${p(pattern)})`);
    }

    if (filters.status === 'online')  where.push(`d.online = true`);
    if (filters.status === 'offline') where.push(`d.online = false`);
    if (filters.status === 'alarm') {
      where.push(`EXISTS (SELECT 1 FROM alarms a
                           WHERE a.device_id = d.mqtt_device_id
                             AND a.tenant_id = d.tenant_id
                             AND a.active = true)`);
    }

    // Devices accessible to one user — the same user_devices ∪ user_sites union
    // middleware/device-access.js resolves, so the filter matches what that user
    // actually sees. Admin-only (checked by the handler before we get here).
    if (filters.user_id) {
      const uid = p(filters.user_id);
      where.push(`(EXISTS (SELECT 1 FROM user_devices ud
                            WHERE ud.device_id = d.id AND ud.user_id = ${uid})
                   OR EXISTS (SELECT 1 FROM user_sites us
                               WHERE us.site_id = d.site_id
                                 AND us.user_id = ${uid}
                                 AND us.tenant_id = d.tenant_id))`);
    }
  }

  if (bbox && filters.bbox) {
    where.push(`COALESCE(d.latitude, s.latitude)   BETWEEN ${p(filters.bbox.minLat)} AND ${p(filters.bbox.maxLat)}`);
    where.push(`COALESCE(d.longitude, s.longitude) BETWEEN ${p(filters.bbox.minLon)} AND ${p(filters.bbox.maxLon)}`);
  }

  return { where, params };
}

/** `?user_id=` exposes another user's device assignments — admin+ only (§F.1). */
function userFilterAllowed(req) {
  if (!AUTH_ENABLED || !req.user) return true;
  return req.user.role === 'admin' || req.user.role === 'superadmin';
}

/**
 * Overlay live MQTT state on a DB row, exactly as devices.js does for the
 * device list, so a marker and its list entry never disagree.
 */
function liveDeviceView(row) {
  const live = mqttSvc.getDeviceState(row.mqtt_device_id);
  const meta = mqttSvc.getDeviceMeta(row.mqtt_device_id);
  return {
    id:            row.id,
    mqtt_device_id: row.mqtt_device_id,
    name:          row.name,
    online:        meta ? !!meta.online : !!row.online,
    // Fall back to the SQL EXISTS when the device has never published state.
    alarm_active:  live ? !!live['protection.alarm_active'] : !!row.alarm_active,
    air_temp:      live ? live['equipment.air_temp'] ?? null : null,
  };
}

// ── GET /api/map/devices ─────────────────────────────────
// GeoJSON FeatureCollection: one Feature per site, plus one synthetic Feature
// per device that carries its own coordinates but belongs to no site.
router.get('/devices', filterDeviceAccess(), async (req, res, next) => {
  const parsed = parseCommonFilters(req);
  if (parsed.error) return badRequest(res, parsed.error);
  const { filters } = parsed;

  if (filters.user_id && !userFilterAllowed(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions', status: 403 });
  }

  try {
    const scope = buildDeviceScope(req, filters);
    const placed = [
      ...scope.where,
      `COALESCE(d.latitude, s.latitude) IS NOT NULL`,
      `COALESCE(d.longitude, s.longitude) IS NOT NULL`,
    ];
    const params = [...scope.params];
    params.push(MAX_MAP_DEVICES + 1);

    // The ungeocoded counter must ignore the viewport — a device with no
    // coordinates is missing from every bbox, not just the current one.
    const unplacedScope = buildDeviceScope(req, filters, { bbox: false });

    const [placedRes, unplacedRes] = await Promise.all([
      db.query(
        `SELECT d.id, d.mqtt_device_id, d.name, d.online,
                COALESCE(d.latitude,  s.latitude)  AS lat,
                COALESCE(d.longitude, s.longitude) AS lon,
                s.id AS site_id, s.name AS site_name,
                s.city, s.region, s.country, s.country_code,
                s.latitude AS site_latitude, s.longitude AS site_longitude,
                t.slug AS tenant_slug,
                EXISTS (SELECT 1 FROM alarms a
                         WHERE a.device_id = d.mqtt_device_id
                           AND a.tenant_id = d.tenant_id
                           AND a.active = true) AS alarm_active
           FROM devices d
           LEFT JOIN sites   s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
           LEFT JOIN tenants t ON t.id = d.tenant_id
          WHERE ${placed.join(' AND ')}
          ORDER BY s.name NULLS LAST, d.name NULLS LAST, d.mqtt_device_id
          LIMIT $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS count
           FROM devices d
           LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
          WHERE ${unplacedScope.where.join(' AND ')}
            AND (COALESCE(d.latitude, s.latitude) IS NULL
                 OR COALESCE(d.longitude, s.longitude) IS NULL)`,
        unplacedScope.params
      ),
    ]);

    const rows = placedRes.rows;
    const truncated = rows.length > MAX_MAP_DEVICES;
    if (truncated) rows.length = MAX_MAP_DEVICES;

    // Group in one pass over the single result set — no per-site query.
    const features = [];
    const byKey = new Map();

    for (const row of rows) {
      const key = row.site_id ? `s:${row.site_id}` : `d:${row.id}`;
      let feature = byKey.get(key);

      if (!feature) {
        // A site is drawn at its own coordinates; a site without any is drawn at
        // the first device that has them. A site-less device is its own marker.
        const lat = row.site_id && row.site_latitude  !== null ? row.site_latitude  : row.lat;
        const lon = row.site_id && row.site_longitude !== null ? row.site_longitude : row.lon;

        feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(lon), Number(lat)] },
          properties: {
            site_id:      row.site_id,
            site_name:    row.site_name,
            city:         row.city,
            region:       row.region,
            country:      row.country,
            country_code: row.country_code,
            tenant_slug:  row.tenant_slug,
            device_count: 0,
            online_count: 0,
            offline_count: 0,
            alarm_count:  0,
            devices:      [],
          },
        };
        byKey.set(key, feature);
        features.push(feature);
      }

      const device = liveDeviceView(row);

      // A site-less device is its own Feature, and the map reads its identity and
      // live values at the PROPERTIES level (popup title, temperature, the
      // "open device" link, and featureKey() in webui/src/lib/geo.js). Without
      // these the popup renders "—" and two devices pinned at the same rounded
      // coordinates collapse onto one marker, because featureKey() would fall
      // through to its coordinate-derived key.
      if (!row.site_id) {
        feature.properties.device_id      = device.id;
        feature.properties.mqtt_device_id = device.mqtt_device_id;
        feature.properties.name           = device.name;
        feature.properties.online         = device.online;
        feature.properties.alarm_active   = device.alarm_active;
        feature.properties.air_temp       = device.air_temp;
      }

      feature.properties.devices.push(device);
      feature.properties.device_count += 1;
      if (device.online) feature.properties.online_count += 1;
      else feature.properties.offline_count += 1;
      if (device.alarm_active) feature.properties.alarm_count += 1;
    }

    res.json({
      data: { type: 'FeatureCollection', features },
      meta: {
        total_sites:        features.filter(f => f.properties.site_id !== null).length,
        total_features:     features.length,
        total_devices:      rows.length,
        ungeocoded_devices: unplacedRes.rows[0]?.count ?? 0,
        truncated,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/map/filters ─────────────────────────────────
// Option lists for the filter bar. The facet filters themselves are NOT applied
// (a filter list that empties as you narrow it is unusable) — only the tenant
// scope and the caller's RBAC are.
router.get('/filters', filterDeviceAccess(), async (req, res, next) => {
  const parsed = parseCommonFilters(req);
  if (parsed.error) return badRequest(res, parsed.error);
  const { filters } = parsed;

  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const isAdmin = !AUTH_ENABLED || !req.user
      || req.user.role === 'admin' || req.user.role === 'superadmin';

    const scope = buildDeviceScope(req, filters, { bbox: false, optionFilters: false });
    const where = scope.where.join(' AND ');
    const params = scope.params;

    const siteJoin = `FROM devices d
      JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
     WHERE ${where}`;

    const queries = [
      db.query(
        `SELECT s.country_code AS code, MIN(s.country) AS name, COUNT(*)::int AS count
         ${siteJoin} AND s.country_code IS NOT NULL
          GROUP BY s.country_code
          ORDER BY count DESC, s.country_code`,
        params
      ),
      db.query(
        `SELECT s.region AS name, COUNT(*)::int AS count
         ${siteJoin} AND s.region IS NOT NULL
          GROUP BY s.region
          ORDER BY count DESC, s.region`,
        params
      ),
      db.query(
        `SELECT s.city AS name, COUNT(*)::int AS count
         ${siteJoin} AND s.city IS NOT NULL
          GROUP BY s.city
          ORDER BY count DESC, s.city`,
        params
      ),
      db.query(
        `SELECT d.model AS name, COUNT(*)::int AS count
           FROM devices d
           LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
          WHERE ${where} AND d.model IS NOT NULL
          GROUP BY d.model
          ORDER BY count DESC, d.model`,
        params
      ),
      db.query(
        `SELECT d.firmware_version AS version, COUNT(*)::int AS count
           FROM devices d
           LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
          WHERE ${where} AND d.firmware_version IS NOT NULL
          GROUP BY d.firmware_version
          ORDER BY count DESC, d.firmware_version`,
        params
      ),
    ];

    // Superadmin-only: which tenants own the devices currently in scope.
    if (isSuperadmin) {
      queries.push(db.query(
        `SELECT t.id, t.slug, t.name, COUNT(d.id)::int AS count
           FROM devices d
           JOIN tenants t ON t.id = d.tenant_id
           LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
          WHERE ${where}
          GROUP BY t.id, t.slug, t.name
          ORDER BY count DESC, t.slug`,
        params
      ));
    }

    // Admin+ only: the roster with each user's accessible device count
    // (user_devices ∪ user_sites — the same union device-access.js resolves).
    const usersTenantId = isSuperadmin ? (filters.tenant_id || req.tenantId) : req.tenantId;
    if (isAdmin && usersTenantId) {
      queries.push(db.query(
        `SELECT u.id, u.email,
                (SELECT COUNT(DISTINCT d.id)::int
                   FROM devices d
                   LEFT JOIN user_devices ud ON ud.device_id = d.id AND ud.user_id = u.id
                   LEFT JOIN sites      s  ON s.id = d.site_id AND s.tenant_id = d.tenant_id
                   LEFT JOIN user_sites us ON us.site_id = s.id AND us.user_id = u.id AND us.tenant_id = $1
                  WHERE d.tenant_id = $1 AND d.status <> 'deleted'
                    AND (ud.user_id IS NOT NULL OR us.user_id IS NOT NULL)) AS count
           FROM users u
          WHERE u.tenant_id = $1 AND u.active = true
          ORDER BY u.email`,
        [usersTenantId]
      ));
    }

    const results = await Promise.all(queries);
    const [countries, regions, cities, models, firmwares] = results;

    const data = {
      countries:         countries.rows,
      regions:           regions.rows,
      cities:            cities.rows,
      models:            models.rows,
      firmware_versions: firmwares.rows,
    };

    // The optional lists are appended in the order they were pushed above.
    let idx = 5;
    if (isSuperadmin) data.tenants = results[idx++].rows;
    if (isAdmin && usersTenantId) data.users = results[idx++].rows;

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/map/alarm-heatmap ───────────────────────────
// [[lat, lon, weight], …] aggregated in SQL. meta.max_weight is load-bearing:
// L.heatLayer normalises against its `max` option, defaulting to 1.0, which
// renders any real dataset as one solid blob.
router.get('/alarm-heatmap', filterDeviceAccess(), async (req, res, next) => {
  const parsed = parseCommonFilters(req);
  if (parsed.error) return badRequest(res, parsed.error);
  const { filters } = parsed;

  if (filters.user_id && !userFilterAllowed(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions', status: 403 });
  }

  const to   = req.query.to   ? parseIsoDate(req.query.to)   : new Date();
  const from = req.query.from ? parseIsoDate(req.query.from)
                              : new Date(Date.now() - HEATMAP_DEFAULT_DAYS * 86400 * 1000);
  if (!from) return badRequest(res, 'from must be an ISO date');
  if (!to)   return badRequest(res, 'to must be an ISO date');
  if (from > to) return badRequest(res, 'from must not be after to');

  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';

    // RBAC on the alarms side uses the mqtt ids (alarms.device_id is VARCHAR(16),
    // it holds the mqtt id — see alarms.js), so the device scope skips it.
    const scope = buildDeviceScope(req, filters, { rbac: false });
    const where  = [...scope.where];
    const params = [...scope.params];
    const p = value => { params.push(value); return `$${params.length}`; };

    if (!isSuperadmin) where.push(`a.tenant_id = ${p(req.tenantId)}`);
    where.push(`a.triggered_at >= ${p(from.toISOString())}::timestamptz`);
    where.push(`a.triggered_at <  ${p(to.toISOString())}::timestamptz`);
    if (req.deviceMqttIds) where.push(`a.device_id = ANY(${p(req.deviceMqttIds)})`);
    where.push(`COALESCE(d.latitude,  s.latitude)  IS NOT NULL`);
    where.push(`COALESCE(d.longitude, s.longitude) IS NOT NULL`);

    const { rows } = await db.query(
      `WITH points AS (
         SELECT COALESCE(d.latitude,  s.latitude)  AS lat,
                COALESCE(d.longitude, s.longitude) AS lon,
                COUNT(*)::int AS weight
           FROM alarms a
           JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
           LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
          WHERE ${where.join(' AND ')}
          GROUP BY 1, 2
       )
       SELECT lat, lon, weight,
              (MAX(weight) OVER ())::int AS max_weight,
              (SUM(weight) OVER ())::int AS total
         FROM points
        ORDER BY weight DESC, lat, lon
        LIMIT ${MAX_HEAT_POINTS + 1}`,
      params
    );

    const truncated = rows.length > MAX_HEAT_POINTS;
    if (truncated) rows.length = MAX_HEAT_POINTS;

    res.json({
      data: rows.map(r => [Number(r.lat), Number(r.lon), r.weight]),
      meta: {
        // Window functions run before LIMIT, so both stay correct when the
        // point list is capped.
        max_weight: rows.length > 0 ? rows[0].max_weight : 0,
        total:      rows.length > 0 ? rows[0].total : 0,
        from:       from.toISOString(),
        to:         to.toISOString(),
        truncated,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/map/isochrones ──────────────────────────────
// Coverage polygons around a point. Without ORS_API_KEY these are straight-line
// rings and every Feature carries approximate:true — the UI must label them.
router.get('/isochrones', maybeAuthorize('admin', 'technician'), requireFeature('geo'), async (req, res, next) => {
  const lat = Number(String(req.query.lat ?? '').trim());
  const lon = Number(String(req.query.lon ?? '').trim());
  if (String(req.query.lat ?? '').trim() === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return badRequest(res, 'lat must be a number between -90 and 90');
  }
  if (String(req.query.lon ?? '').trim() === '' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return badRequest(res, 'lon must be a number between -180 and 180');
  }

  // At most 3 bands, 1..120 min each: an unbounded `minutes` list burns the
  // whole ORS quota in a single request.
  const rawMinutes = req.query.minutes === undefined || String(req.query.minutes).trim() === ''
    ? '15,30,60'
    : String(req.query.minutes);
  const parts = rawMinutes.split(',').map(s => s.trim());
  if (parts.length === 0 || parts.length > 3 || parts.some(s => s === '')) {
    return badRequest(res, 'minutes must be 1..3 comma-separated values');
  }
  const minutes = parts.map(Number);
  if (!minutes.every(m => Number.isInteger(m) && m >= 1 && m <= 120)) {
    return badRequest(res, 'each minutes value must be an integer between 1 and 120');
  }

  try {
    const result = await routingSvc.isochrones(lat, lon, minutes);
    if (!result) return badRequest(res, 'Unable to build isochrones for these parameters');

    res.json({ data: result.collection, meta: result.meta });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/map/route ──────────────────────────────────
// Service-round planner. Every site_id is verified against the caller's tenant
// AND their RBAC before any upstream call.
const routeSchema = z.object({
  site_ids: z.array(z.string().uuid()).min(1).max(MAX_ROUTE_POINTS),
  start: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }).nullable().optional(),
  roundtrip: z.boolean().optional(),
});

/**
 * Hand the finished round to a phone. Coordinates are numbers straight out of
 * the DB / the validated body, and URLSearchParams does the encoding.
 */
function googleMapsUrl(stops, roundtrip) {
  if (stops.length === 0) return null;
  const ll = s => `${s.latitude},${s.longitude}`;

  const origin      = stops[0];
  const destination = roundtrip ? stops[0] : stops[stops.length - 1];
  const waypoints   = roundtrip ? stops.slice(1) : stops.slice(1, -1);

  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', ll(origin));
  url.searchParams.set('destination', ll(destination));
  if (waypoints.length > 0) url.searchParams.set('waypoints', waypoints.map(ll).join('|'));
  return url.toString();
}

router.post('/route', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) {
    return badRequest(res, parsed.error.issues[0]?.message || 'Invalid input');
  }

  const { site_ids: siteIds, start } = parsed.data;
  // Explicit opt-in. With roundtrip=false OSRM only supports a pinned start AND
  // end, so the last stop is the last site the caller selected (or the start
  // point when it is the only pin) — services/routing.js sends source=first,
  // destination=last for that case.
  const roundtrip = parsed.data.roundtrip === true;

  const uniqueIds = [...new Set(siteIds)];
  if (uniqueIds.length + (start ? 1 : 0) > MAX_ROUTE_POINTS) {
    return badRequest(res, `At most ${MAX_ROUTE_POINTS} points per route`);
  }

  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';

    const params = [uniqueIds];
    // "Routable" must mean exactly what the map DREW, or the user picks a pin
    // they can see and gets 400 invalid_site. GET /api/map/devices places a site
    // without its own coordinates at its first placed device
    // (COALESCE(d.latitude, s.latitude)), so the round planner resolves the same
    // effective point here. A site the map cannot draw is still rejected.
    const where = ['s.id = ANY($1)', 'eff.latitude IS NOT NULL', 'eff.longitude IS NOT NULL'];
    if (!isSuperadmin) {
      params.push(req.tenantId);
      where.push(`s.tenant_id = $${params.length}`);
    }
    // A technician may only route to sites where they can actually see a device.
    let deviceFilterIdx = null;
    if (req.deviceFilter) {
      params.push(req.deviceFilter);
      deviceFilterIdx = params.length;
      where.push(`EXISTS (SELECT 1 FROM devices d
                           WHERE d.site_id = s.id
                             AND d.tenant_id = s.tenant_id
                             AND d.status <> 'deleted'
                             AND d.id = ANY($${deviceFilterIdx}))`);
    }

    // The fallback device is drawn from the caller's own accessible set when one
    // is in force — a coordinate must never arrive from a device they cannot see.
    const fallbackFilter = deviceFilterIdx ? `AND d.id = ANY($${deviceFilterIdx})` : '';

    const { rows: sites } = await db.query(
      `SELECT s.id, s.name, eff.latitude, eff.longitude
         FROM sites s
         LEFT JOIN LATERAL (
           SELECT d.latitude, d.longitude
             FROM devices d
            WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id
              AND d.status <> 'deleted'
              AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
              ${fallbackFilter}
            ORDER BY d.name NULLS LAST, d.mqtt_device_id
            LIMIT 1
         ) dev ON true
         CROSS JOIN LATERAL (
           -- Both coordinates come from ONE source: mixing a site latitude with a
           -- device longitude would put the stop in the sea.
           SELECT CASE WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL
                       THEN s.latitude  ELSE dev.latitude  END AS latitude,
                  CASE WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL
                       THEN s.longitude ELSE dev.longitude END AS longitude
         ) eff
        WHERE ${where.join(' AND ')}`,
      params
    );

    const found = new Map(sites.map(s => [s.id, s]));
    const unresolved = uniqueIds.filter(id => !found.has(id));
    if (unresolved.length > 0) {
      return res.status(400).json({
        error: 'invalid_site',
        message: 'One or more sites are not accessible or have no coordinates',
        status: 400,
        site_ids: unresolved,
      });
    }

    // Input order: the start point (when given) is always index 0.
    const points = [];
    if (start) {
      points.push({ site_id: null, name: null, latitude: start.lat, longitude: start.lon, kind: 'start' });
    }
    for (const id of uniqueIds) {
      const s = found.get(id);
      points.push({
        site_id: s.id, name: s.name,
        latitude: Number(s.latitude), longitude: Number(s.longitude),
        kind: 'site',
      });
    }

    const osrmPoints = points.map(pt => ({ lat: pt.latitude, lon: pt.longitude }));
    const trip = await routingSvc.trip(osrmPoints, { roundtrip, source: 'first' });

    // Degradation (never { data: null }): a nearest-neighbour ordering and the
    // Google deep link need no upstream at all, and the demo posture points at a
    // rate-limited community server where 429/5xx are routine.
    if (!trip) {
      const fallback = routingSvc.nearestNeighbourOrder(osrmPoints, 0);
      const stops = fallback.order.map(i => points[i]);
      return res.json({
        data: {
          order: stops.filter(s => s.site_id !== null).map(s => s.site_id),
          stops,
          legs: null,
          geometry: null,
          total_distance_m: fallback.total_distance_m,
          total_duration_s: null,
          google_maps_url: googleMapsUrl(stops, roundtrip),
        },
        meta: {
          optimized: false,
          provider: null,
          approximate: true,
          roundtrip,
          reason: routingSvc.isEnabled() ? 'router_unavailable' : 'router_disabled',
        },
      });
    }

    const stops = trip.order.map(i => points[i]);
    // routing.js reports legs with INPUT indices; the client needs positions in
    // the visiting order it is about to render.
    const positionOf = new Map(trip.order.map((inputIdx, pos) => [inputIdx, pos]));
    const legs = (trip.legs || []).map(leg => ({
      from: positionOf.has(leg.from) ? positionOf.get(leg.from) : leg.from,
      to:   positionOf.has(leg.to)   ? positionOf.get(leg.to)   : leg.to,
      from_site_id: points[leg.from] ? points[leg.from].site_id : null,
      to_site_id:   points[leg.to]   ? points[leg.to].site_id   : null,
      distance_m: leg.distance_m,
      duration_s: leg.duration_s,
    }));

    res.json({
      data: {
        order: stops.filter(s => s.site_id !== null).map(s => s.site_id),
        stops,
        legs,
        geometry: trip.geometry,
        total_distance_m: trip.total_distance_m,
        total_duration_s: trip.total_duration_s,
        google_maps_url: googleMapsUrl(stops, roundtrip),
      },
      meta: {
        optimized: true,
        provider: trip.provider,
        approximate: false,
        roundtrip,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
