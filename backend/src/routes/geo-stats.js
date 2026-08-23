'use strict';

// Geo aggregates — mounted at /api/stats by index.js (no router-level authorize,
// so every route below states its own middleware).
//
//   GET /api/stats/geo             metric table grouped by country / region / city / site
//   GET /api/stats/geo/export.csv  the same table as a CSV download
//
// Tenant isolation: the `scoped` CTE carries an explicit tenant predicate with the
// superadmin bypass from routes/devices.js, and EVERY metric CTE joins `scoped`
// instead of reaching into alarms / telemetry / service_records / events on its
// own. That is what keeps a technician from seeing alarm or energy totals for
// devices they cannot open — the metric tables are never queried outside the
// already-filtered device set.
//
// group_by and sort are whitelists resolved through fixed maps. No user-supplied
// value ever reaches the SQL text, including the ORDER BY.
//
// Join keys differ per source table and getting them wrong is a runtime 22P02:
//   alarms.device_id          VARCHAR(16) -> devices.mqtt_device_id
//   telemetry.device_id       VARCHAR(16) -> devices.mqtt_device_id
//   events.device_id          VARCHAR(16) -> devices.mqtt_device_id
//   service_records.device_id UUID        -> devices.id
//
// Metrics that cannot be known are reported as null, never as a comforting zero:
//   avg_air_temp  null when no 'air' telemetry sample exists in the period
//   energy_kwh    null when no 'energy' telemetry sample exists (the sampler only
//                 writes for online devices, so "no rows" means unknown, not 0 kWh)
//   uptime_pct    null when no device in the group has a single device_online /
//                 device_offline event to establish its state
// alarm_count, alarms_period and service_visits are real zeros — those rows are
// written by the platform and by humans, so their absence genuinely means "none".

const { Router }    = require('express');
const { stringify } = require('csv-stringify');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../services/db');
const { filterDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

const router = Router();

// ── Constants ─────────────────────────────────────────────

// A drill-down table is read by a human; 500 rows is already more than anyone
// scrolls, and the cap bounds the response for a superadmin querying every site
// on the platform.
const MAX_GROUPS = 500;
// The uptime and telemetry CTEs scan per-device time ranges. A year keeps the
// year-over-year use case while bounding the worst-case scan; a longer request is
// clamped (and says so in meta), not rejected.
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

const VALID_STATUS = ['online', 'offline', 'alarm', 'all'];

// group_by -> the grouping key and its human label. Never interpolated from
// input: `?group_by=city);DROP--` misses the map and returns 400.
const GROUP_BY = {
  country: { key: 's.country_code::text', label: 'COALESCE(s.country, s.country_code::text)' },
  region:  { key: 's.region',             label: 's.region' },
  city:    { key: 's.city',               label: 's.city' },
  site:    { key: 's.id::text',           label: 's.name' },
};

// sort -> a fixed aggregate expression. Same whitelist rule as group_by.
const SORT_BY = {
  device_count:   'device_count',
  online_count:   'online_count',
  offline_count:  'offline_count',
  alarm_count:    'alarm_count',
  alarms_period:  'alarms_period',
  service_visits: 'service_visits',
  energy_kwh:     'SUM(t.energy_sum)',
  avg_air_temp:   'CASE WHEN COALESCE(SUM(t.air_n), 0) > 0 THEN SUM(t.air_sum) / SUM(t.air_n) END',
  uptime_pct:     'CASE WHEN COUNT(up.device_id) > 0 THEN SUM(up.online_s) / COUNT(up.device_id) END',
  label:          'MIN(sc.grp_label)',
  key:            'sc.grp_key',
};

// ── Small helpers ─────────────────────────────────────────

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

/** Number(null) is 0 — that would turn "unknown" into a fabricated measurement. */
function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits) {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function shortDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** `?user_id=` exposes another user's device assignments — admin+ only. */
function userFilterAllowed(req) {
  if (!AUTH_ENABLED || !req.user) return true;
  return req.user.role === 'admin' || req.user.role === 'superadmin';
}

// ── Filter parsing ────────────────────────────────────────

/**
 * Parse the filter set /api/map/devices accepts, so the map and the stats table
 * answer the same question for the same query string.
 * Nothing here reaches SQL as text — every value is bound as a parameter.
 *
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
  // (-> 500) and the only place a caller can feed raw text into a numeric column.
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
 * Resolve ?from / ?to into a bounded range.
 * @returns {{ error: string }|{ from: Date, to: Date, clamped: boolean }}
 */
function parseRange(req) {
  const hasFrom = req.query.from !== undefined && String(req.query.from).trim() !== '';
  const hasTo   = req.query.to   !== undefined && String(req.query.to).trim()   !== '';

  const to = hasTo ? parseIsoDate(req.query.to) : new Date();
  if (!to) return { error: 'to must be an ISO date' };

  const from = hasFrom
    ? parseIsoDate(req.query.from)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86400 * 1000);
  if (!from) return { error: 'from must be an ISO date' };

  if (from > to) return { error: 'from must not be after to' };

  const maxMs = MAX_RANGE_DAYS * 86400 * 1000;
  if (to - from > maxMs) {
    return { from: new Date(to.getTime() - maxMs), to, clamped: true };
  }
  return { from, to, clamped: false };
}

// ── Device scope ──────────────────────────────────────────

/**
 * WHERE fragments for a query rooted at
 * `devices d LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id`.
 * That site join predicate is mandatory on every devices<->sites join in this
 * codebase — there is deliberately no composite FK, so a stale cross-tenant
 * site_id has to be neutralised in the join itself.
 *
 * @returns {{ where: string[], params: any[], p: (v: any) => string }}
 */
function buildDeviceScope(req, filters) {
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

  // Per-device RBAC (user_devices ∪ user_sites). null = admin/superadmin = no
  // limit; [] = a user with no grants, which must hide everything.
  if (req.deviceFilter) where.push(`d.id = ANY(${p(req.deviceFilter)})`);

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

  if (filters.bbox) {
    where.push(`COALESCE(d.latitude, s.latitude)   BETWEEN ${p(filters.bbox.minLat)} AND ${p(filters.bbox.maxLat)}`);
    where.push(`COALESCE(d.longitude, s.longitude) BETWEEN ${p(filters.bbox.minLon)} AND ${p(filters.bbox.maxLon)}`);
  }

  return { where, params, p };
}

// ── The aggregate ─────────────────────────────────────────

/**
 * Run the geo aggregate for the current request.
 * Everything is aggregated in SQL: one round trip, no per-group follow-up query,
 * no arithmetic over device rows in Node.
 *
 * @returns {Promise<{ error: string, status?: number, message?: string }
 *                  |{ rows: object[], totals: object, meta: object }>}
 */
async function collectGeoStats(req) {
  const groupByKey = req.query.group_by === undefined || String(req.query.group_by).trim() === ''
    ? 'country'
    : String(req.query.group_by).trim();
  const group = GROUP_BY[groupByKey];
  if (!group) {
    return { error: `group_by must be one of ${Object.keys(GROUP_BY).join('|')}` };
  }

  const sortKey = req.query.sort === undefined || String(req.query.sort).trim() === ''
    ? 'device_count'
    : String(req.query.sort).trim();
  const sortExpr = SORT_BY[sortKey];
  if (!sortExpr) {
    return { error: `sort must be one of ${Object.keys(SORT_BY).join('|')}` };
  }

  const orderKey = req.query.order === undefined || String(req.query.order).trim() === ''
    ? (sortKey === 'label' || sortKey === 'key' ? 'asc' : 'desc')
    : String(req.query.order).trim().toLowerCase();
  if (orderKey !== 'asc' && orderKey !== 'desc') {
    return { error: 'order must be asc or desc' };
  }
  const direction = orderKey === 'asc' ? 'ASC' : 'DESC';
  // Stable tiebreak so two groups with the same metric never swap between
  // requests — skipped when the label already IS the sort key.
  const tieBreak = sortKey === 'label' ? '' : ', MIN(sc.grp_label) ASC NULLS LAST';

  const parsedFilters = parseCommonFilters(req);
  if (parsedFilters.error) return { error: parsedFilters.error };
  const { filters } = parsedFilters;

  if (filters.user_id && !userFilterAllowed(req)) {
    return { status: 403, error: 'forbidden', message: 'Insufficient permissions' };
  }

  const range = parseRange(req);
  if (range.error) return { error: range.error };
  const { from, to, clamped } = range;

  const isSuperadmin = req.user && req.user.role === 'superadmin';
  const scope = buildDeviceScope(req, filters);
  const { where, params, p } = scope;

  const pFrom = p(from.toISOString());
  const pTo   = p(to.toISOString());

  // Defence in depth. The joins below already inherit the tenant scope through
  // `scoped`, but the house rule is an explicit tenant predicate on every query,
  // and it also lets the planner use idx_alarms_time / idx_telemetry_lookup /
  // idx_events_lookup, all of which lead with tenant_id.
  const tenantParam = isSuperadmin ? null : p(req.tenantId);
  const tenantOn = alias => (tenantParam ? ` AND ${alias}.tenant_id = ${tenantParam}` : '');

  const pLimit = p(MAX_GROUPS + 2);

  const sql = `
    WITH scoped AS (
      SELECT d.id             AS device_id,
             d.mqtt_device_id AS mqtt_device_id,
             d.tenant_id      AS tenant_id,
             d.online         AS online,
             ${group.key}     AS grp_key,
             ${group.label}   AS grp_label
        FROM devices d
        LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
       WHERE ${where.join(' AND ')}
    ),
    -- Currently active alarms (no time filter — "active" is a present-tense fact).
    alarm_active AS (
      SELECT sc.device_id, COUNT(*)::int AS n
        FROM alarms a
        JOIN scoped sc ON sc.mqtt_device_id = a.device_id AND sc.tenant_id = a.tenant_id
       WHERE a.active = true${tenantOn('a')}
       GROUP BY sc.device_id
    ),
    -- Alarms raised inside [from, to).
    alarm_period AS (
      SELECT sc.device_id, COUNT(*)::int AS n
        FROM alarms a
        JOIN scoped sc ON sc.mqtt_device_id = a.device_id AND sc.tenant_id = a.tenant_id
       WHERE a.triggered_at >= ${pFrom}::timestamptz
         AND a.triggered_at <  ${pTo}::timestamptz${tenantOn('a')}
       GROUP BY sc.device_id
    ),
    -- Air temperature and energy in one pass over the partitioned table.
    -- 'energy' is the Phase 13 model: services/mqtt.js writes one kWh delta per
    -- sampling interval (the metered reading when the firmware publishes one, the
    -- device_models power profile otherwise), so the period total is a plain SUM.
    tele AS (
      SELECT sc.device_id,
             SUM(tm.value) FILTER (WHERE tm.channel = 'air')    AS air_sum,
             COUNT(*)      FILTER (WHERE tm.channel = 'air')    AS air_n,
             SUM(tm.value) FILTER (WHERE tm.channel = 'energy') AS energy_sum,
             COUNT(*)      FILTER (WHERE tm.channel = 'energy') AS energy_n
        FROM telemetry tm
        JOIN scoped sc ON sc.mqtt_device_id = tm.device_id AND sc.tenant_id = tm.tenant_id
       WHERE tm.channel IN ('air', 'energy')
         AND tm.time >= ${pFrom}::timestamptz
         AND tm.time <  ${pTo}::timestamptz${tenantOn('tm')}
       GROUP BY sc.device_id
    ),
    -- service_records.device_id is the device UUID, not the mqtt id, and
    -- service_date is a DATE — so the range is compared at day granularity and
    -- both boundary days are included.
    svc AS (
      SELECT sc.device_id, COUNT(*)::int AS n
        FROM service_records sr
        JOIN scoped sc ON sc.device_id = sr.device_id AND sc.tenant_id = sr.tenant_id
       WHERE sr.service_date >= (${pFrom}::timestamptz)::date
         AND sr.service_date <= (${pTo}::timestamptz)::date${tenantOn('sr')}
       GROUP BY sc.device_id
    ),
    -- Uptime is reconstructed from the device_online / device_offline events
    -- services/mqtt.js writes on every LWT transition. The window's opening state
    -- is seeded from the last transition BEFORE \`from\`, clamped to \`from\`:
    -- without that seed a device that stayed online all month, and therefore
    -- emitted no event, would score 0%.
    up_ev AS (
      SELECT sc.device_id, e.time AS ev_at, e.event_type
        FROM events e
        JOIN scoped sc ON sc.mqtt_device_id = e.device_id AND sc.tenant_id = e.tenant_id
       WHERE e.event_type IN ('device_online', 'device_offline')
         AND e.time >= ${pFrom}::timestamptz
         AND e.time <  ${pTo}::timestamptz${tenantOn('e')}
      UNION ALL
      SELECT sc.device_id, ${pFrom}::timestamptz AS ev_at, seed.event_type
        FROM scoped sc
        CROSS JOIN LATERAL (
          SELECT e.event_type
            FROM events e
           WHERE e.tenant_id = sc.tenant_id
             AND e.device_id = sc.mqtt_device_id
             AND e.event_type IN ('device_online', 'device_offline')
             AND e.time < ${pFrom}::timestamptz
           ORDER BY e.time DESC
           LIMIT 1
        ) seed
    ),
    up_seg AS (
      SELECT device_id, event_type, ev_at,
             LEAD(ev_at, 1, ${pTo}::timestamptz)
               OVER (PARTITION BY device_id ORDER BY ev_at, event_type) AS next_at
        FROM up_ev
    ),
    uptime AS (
      SELECT device_id,
             COALESCE(SUM(EXTRACT(EPOCH FROM (next_at - ev_at)))
                        FILTER (WHERE event_type = 'device_online'), 0) AS online_s
        FROM up_seg
       GROUP BY device_id
    )
    SELECT GROUPING(sc.grp_key)                       AS is_total,
           sc.grp_key                                 AS "key",
           MIN(sc.grp_label)                          AS label,
           COUNT(*)::int                              AS device_count,
           COUNT(*) FILTER (WHERE sc.online)::int     AS online_count,
           COUNT(*) FILTER (WHERE NOT sc.online)::int AS offline_count,
           COALESCE(SUM(aa.n), 0)::int                AS alarm_count,
           COALESCE(SUM(ap.n), 0)::int                AS alarms_period,
           COALESCE(SUM(sv.n), 0)::int                AS service_visits,
           SUM(t.air_sum)                             AS air_sum,
           COALESCE(SUM(t.air_n), 0)::bigint          AS air_n,
           SUM(t.energy_sum)                          AS energy_sum,
           COALESCE(SUM(t.energy_n), 0)::bigint       AS energy_n,
           COALESCE(SUM(up.online_s), 0)              AS online_s,
           COUNT(up.device_id)::int                   AS uptime_devices
      FROM scoped sc
      LEFT JOIN alarm_active aa ON aa.device_id = sc.device_id
      LEFT JOIN alarm_period ap ON ap.device_id = sc.device_id
      LEFT JOIN tele         t  ON t.device_id  = sc.device_id
      LEFT JOIN svc          sv ON sv.device_id = sc.device_id
      LEFT JOIN uptime       up ON up.device_id = sc.device_id
     GROUP BY GROUPING SETS ((sc.grp_key), ())
     ORDER BY is_total DESC, ${sortExpr} ${direction} NULLS LAST${tieBreak}
     LIMIT ${pLimit}
  `;

  const { rows } = await db.query(sql, params);

  const periodSeconds = (to.getTime() - from.getTime()) / 1000;

  const shape = (row) => {
    const airN      = num(row.air_n) || 0;
    const energyN   = num(row.energy_n) || 0;
    const devices   = num(row.uptime_devices) || 0;
    const airSum    = num(row.air_sum);
    const energySum = num(row.energy_sum);
    const onlineS   = num(row.online_s) || 0;

    let uptimePct = null;
    if (devices > 0 && periodSeconds > 0) {
      const pct = (onlineS / (devices * periodSeconds)) * 100;
      // Clamp: a transition pair landing on the same timestamp plus float drift
      // can push this a hair past 100, and a 100.03% uptime column destroys
      // trust in the whole table.
      uptimePct = round(Math.min(100, Math.max(0, pct)), 1);
    }

    return {
      key:            row.key === null || row.key === undefined ? null : String(row.key),
      label:          row.label === null || row.label === undefined ? null : String(row.label),
      device_count:   row.device_count,
      online_count:   row.online_count,
      offline_count:  row.offline_count,
      alarm_count:    row.alarm_count,
      alarms_period:  row.alarms_period,
      avg_air_temp:   airN > 0 && airSum !== null ? round(airSum / airN, 2) : null,
      uptime_pct:     uptimePct,
      energy_kwh:     energyN > 0 && energySum !== null ? round(energySum, 3) : null,
      service_visits: row.service_visits,
    };
  };

  const totalRow  = rows.find(r => Number(r.is_total) === 1);
  const groupRows = rows.filter(r => Number(r.is_total) !== 1);

  const truncated = groupRows.length > MAX_GROUPS;
  if (truncated) groupRows.length = MAX_GROUPS;

  // An empty scope still yields the () grouping set on PostgreSQL, but a
  // synthesised zero row costs nothing and keeps meta.totals a fixed shape.
  const totals = totalRow ? shape(totalRow) : {
    key: null, label: null,
    device_count: 0, online_count: 0, offline_count: 0,
    alarm_count: 0, alarms_period: 0,
    avg_air_temp: null, uptime_pct: null, energy_kwh: null,
    service_visits: 0,
  };
  delete totals.key;
  delete totals.label;

  return {
    rows: groupRows.map(shape),
    totals,
    meta: {
      group_by: groupByKey,
      sort:     sortKey,
      order:    orderKey,
      from:     from.toISOString(),
      to:       to.toISOString(),
      clamped,
      truncated,
      totals,
    },
  };
}

/** Translate a collectGeoStats() failure into the house error envelope. */
function sendFailure(res, result) {
  if (result.status) {
    return res.status(result.status).json({
      error: result.error, message: result.message, status: result.status,
    });
  }
  return badRequest(res, result.error);
}

// ── GET /api/stats/geo ────────────────────────────────────
// No maybeAuthorize(): every authenticated role may read, and filterDeviceAccess()
// does the narrowing. `maybeAuthorize()` with no roles would 403 EVERY caller —
// authorize() tests membership in the given list — so "any role" is expressed by
// omitting it, not by calling it empty.
router.get('/geo', filterDeviceAccess(), async (req, res, next) => {
  try {
    const result = await collectGeoStats(req);
    if (result.error) return sendFailure(res, result);
    res.json({ data: result.rows, meta: result.meta });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/stats/geo/export.csv ─────────────────────────
// Same filters, same RBAC, same numbers — rendered server-side so the frontend
// goes through downloadFile() like the four exports already shipped in
// routes/export.js, instead of rebuilding the arithmetic in the browser.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: 'rate_limited', message: 'Too many export requests. Try again in a minute.' },
});

// Parenthesised units rather than "Avg air temp, °C": a comma inside a header
// forces csv-stringify to quote the cell, which is legal CSV but noisy to read.
const CSV_COLUMNS = [
  'Key', 'Label', 'Devices', 'Online', 'Offline',
  'Active alarms', 'Alarms in period', 'Avg air temp (°C)',
  'Uptime (%)', 'Energy (kWh)', 'Service visits',
];

/** A metric we could not compute must read as blank, not as 0. */
const csvCell = v => (v === null || v === undefined ? '' : v);

function csvRow(row) {
  return [
    csvCell(row.key), csvCell(row.label),
    row.device_count, row.online_count, row.offline_count,
    row.alarm_count, row.alarms_period,
    csvCell(row.avg_air_temp), csvCell(row.uptime_pct), csvCell(row.energy_kwh),
    row.service_visits,
  ];
}

router.get('/geo/export.csv', exportLimiter, filterDeviceAccess(), async (req, res, next) => {
  try {
    const result = await collectGeoStats(req);
    if (result.error) return sendFailure(res, result);

    const { group_by, from, to } = result.meta;
    const filename = `geo_stats_${group_by}_${shortDate(from)}_${shortDate(to)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // BOM for Excel Cyrillic compatibility (same as routes/export.js).
    res.write('\uFEFF');

    const csvStream = stringify({ header: true, columns: CSV_COLUMNS });
    csvStream.pipe(res);

    for (const row of result.rows) csvStream.write(csvRow(row));
    // The totals line closes the table so a spreadsheet does not have to re-derive
    // the columns whose aggregate is not a sum (avg_air_temp, uptime_pct).
    csvStream.write(csvRow({ ...result.totals, key: '', label: 'TOTAL' }));
    csvStream.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
