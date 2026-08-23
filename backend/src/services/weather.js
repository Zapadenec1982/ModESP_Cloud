'use strict';

/**
 * weather.js — outdoor weather for geocoded sites (Open-Meteo).
 *
 * Disabled by default: an empty (or 'none') WEATHER_PROVIDER switches the whole
 * feature off. Every public function then answers `null` / no-op instead of
 * throwing, so a route can call it unconditionally and still return HTTP 200.
 *
 * LICENSING: the free Open-Meteo API is NON-COMMERCIAL only. A commercial
 * ModESP deployment needs a paid plan or a self-hosted instance.
 * See docs/THIRD_PARTY_LICENSING.md.
 *
 * Lifecycle (mirrors services/ota.js):
 *   init(logger)   — pure config gate, starts no timers
 *   start(logger)  — starts the periodic poller (no-op when disabled)
 *   shutdown()     — clears every timer
 */

const db = require('./db');

// ── Config ────────────────────────────────────────────────

const DEFAULT_URL = 'https://api.open-meteo.com/v1';

const ROUND_DP            = 2;      // ~1.1 km — cache key and poll granularity
const MAX_CACHE_ENTRIES   = 5000;   // hard ceiling; oldest entries are evicted first
const MAX_FORECAST_HOURS  = 168;    // 7 days — Open-Meteo's practical hourly horizon
const MAX_POLL_SITES      = 5000;   // safety cap for one sweep
const COORDS_PER_REQUEST  = 100;    // Open-Meteo accepts comma-separated coordinate lists
const CHUNK_DELAY_MS      = 1000;   // small fixed pause between batched requests
const INSERT_CHUNK        = 500;    // rows per multi-row INSERT
const BOOT_DELAY_MS       = 60000;  // first sweep delay after boot
const BOOT_JITTER_MS      = 60000;  // + up to this much jitter (crash-loop protection)

// Open-Meteo field names → our column names.
const CURRENT_FIELDS = 'temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,weather_code';
const HOURLY_FIELDS  = CURRENT_FIELDS;

let logger    = null;
let poller    = null;   // setInterval handle
let bootTimer = null;   // setTimeout handle for the delayed first sweep
let sweeping  = false;  // guards against overlapping sweeps

/** @type {Map<string, { at: number, value: any }>}  cache key → entry */
const cache = new Map();

// ── Helpers ───────────────────────────────────────────────

/**
 * Shared "disabled sentinel" helper — empty or 'none' means the service is off.
 * Kept identical in geocode.js / weather.js / routing.js.
 */
const off = v => { const s = (v || '').trim().toLowerCase(); return s === '' || s === 'none'; };

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Logger accessor. The service can be reached from a route before index.js
 * wires it in, so fall back to a local pino instance instead of crashing.
 */
function log() {
  if (!logger) {
    logger = require('pino')({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })
      .child({ svc: 'weather' });
  }
  return logger;
}

/** Base URL with a guaranteed trailing slash so `new URL(path, base)` keeps the /v1 prefix. */
function baseUrl() {
  const raw = (process.env.WEATHER_URL || '').trim() || DEFAULT_URL;
  return raw.replace(/\/+$/, '') + '/';
}

/**
 * Strict numeric coercion. Plain `Number()` turns null, '' and false into 0,
 * which would silently place a site without coordinates on Null Island.
 */
function toNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  return Number(v);
}

/** Round an already-validated coordinate to the cache/poll grid. */
function round(v) {
  return Number(v.toFixed(ROUND_DP));
}

/** True when both values are usable WGS-84 coordinates. */
function validCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** Numeric passthrough that turns undefined / NaN / null into NULL. */
function num(v) {
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

/** As num(), rounded — for the SMALLINT columns (humidity, weather_code). */
function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** Safe indexed read of an Open-Meteo parallel array. */
function at(arr, i) {
  return Array.isArray(arr) ? arr[i] : undefined;
}

/**
 * Validate a coordinate pair and snap it to the cache/poll grid.
 * @returns {{ lat: number, lon: number }|null}
 */
function grid(lat, lon) {
  const nLat = toNum(lat);
  const nLon = toNum(lon);
  if (!validCoords(nLat, nLon)) {
    log().warn({ lat, lon }, 'Weather: invalid coordinates');
    return null;
  }
  return { lat: round(nLat), lon: round(nLon) };
}

/** Forecast horizon, clamped to 1..168 h. */
function clampHours(hours) {
  return Math.min(Math.max(parseInt(hours, 10) || 24, 1), MAX_FORECAST_HOURS);
}

/** Unix seconds → ISO string floored to the top of the hour (stable PK for re-runs). */
function hourIso(unixSeconds) {
  const seconds = toNum(unixSeconds);          // a missing timestamp must not become 1970
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Cache ─────────────────────────────────────────────────

function ttlMs() {
  return envInt('WEATHER_CACHE_TTL_MIN', 30) * 60 * 1000;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs()) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size <= MAX_CACHE_ENTRIES) return;

  // Only over the ceiling: drop what has expired, then the oldest entries
  // (a Map iterates in insertion order). Stale entries are harmless until then,
  // because cacheGet() re-checks the TTL on every read.
  const now = Date.now();
  const ttl = ttlMs();
  for (const [k, v] of cache) {
    if (now - v.at > ttl) cache.delete(k);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

/** Drop every cached reading. Exposed for tests and for ops after a config change. */
function clearCache() {
  cache.clear();
}

// ── Upstream ──────────────────────────────────────────────

/**
 * GET a JSON document. Never throws: a timeout, a non-2xx or a malformed body
 * all resolve to null after a structured warn.
 * @returns {Promise<any|null>}
 */
async function fetchJson(url, ctx) {
  const timeoutMs = envInt('WEATHER_TIMEOUT_MS', 8000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    log().warn({ err: err.message, timeoutMs, ...ctx }, 'Weather: upstream request failed');
    return null;
  }
  if (!res.ok) {
    log().warn({ status: res.status, ...ctx }, 'Weather: upstream returned non-2xx');
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    log().warn({ err: err.message, ...ctx }, 'Weather: upstream returned invalid JSON');
    return null;
  }
}

/**
 * Build an Open-Meteo /forecast URL for one or many coordinates.
 * `timeformat=unixtime` keeps every timestamp an unambiguous UTC instant while
 * `timezone=auto` still makes the response carry the IANA zone of each point.
 * @param {number[]} lats
 * @param {number[]} lons
 * @param {{ current?: boolean, hourlyHours?: number }} opts
 */
function buildUrl(lats, lons, opts) {
  const url = new URL('forecast', baseUrl());
  url.searchParams.set('latitude',  lats.join(','));
  url.searchParams.set('longitude', lons.join(','));
  if (opts.current) url.searchParams.set('current', CURRENT_FIELDS);
  if (opts.hourlyHours) {
    url.searchParams.set('hourly', HOURLY_FIELDS);
    url.searchParams.set('forecast_hours', String(opts.hourlyHours));
  }
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('timeformat', 'unixtime');
  return url;
}

/** Open-Meteo answers with an array for multi-coordinate requests, an object for one. */
function asList(json) {
  if (!json) return [];
  return Array.isArray(json) ? json : [json];
}

/** Map one Open-Meteo `current` block onto our observation shape. */
function readCurrent(entry) {
  const c = entry && entry.current;
  if (!c) return null;
  return {
    observed_at:  hourIso(c.time),
    temp_c:       num(c.temperature_2m),
    humidity:     int(c.relative_humidity_2m),
    pressure_hpa: num(c.surface_pressure),
    wind_ms:      num(c.wind_speed_10m),
    weather_code: int(c.weather_code),
    timezone:     typeof entry.timezone === 'string' ? entry.timezone : null,
  };
}

/** Map one Open-Meteo `hourly` block onto an array of observations. */
function readHourly(entry) {
  const h = entry && entry.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  return h.time.map((t, i) => ({
    observed_at:  hourIso(t),
    temp_c:       num(at(h.temperature_2m, i)),
    humidity:     int(at(h.relative_humidity_2m, i)),
    pressure_hpa: num(at(h.surface_pressure, i)),
    wind_ms:      num(at(h.wind_speed_10m, i)),
    weather_code: int(at(h.weather_code, i)),
  })).filter(p => p.observed_at !== null);
}

/** The cached forecast shape: the IANA zone plus the hourly series. */
function readForecast(entry) {
  return {
    timezone: typeof entry.timezone === 'string' ? entry.timezone : null,
    hourly:   readHourly(entry),
  };
}

// ── Public API ────────────────────────────────────────────

/** @returns {boolean} true when WEATHER_PROVIDER is set to something other than 'none'. */
function isEnabled() {
  return !off(process.env.WEATHER_PROVIDER);
}

/**
 * Pure config gate — starts no timers. Safe to call from tests.
 * @param {import('pino').Logger} log_
 * @returns {boolean} whether the feature is enabled
 */
function init(log_) {
  if (log_) logger = log_.child({ svc: 'weather' });
  const enabled = isEnabled();
  if (enabled) {
    log().info({ provider: (process.env.WEATHER_PROVIDER || '').trim(), url: baseUrl() },
      'Weather service configured');
  } else {
    log().info('Weather service disabled (WEATHER_PROVIDER empty)');
  }
  return enabled;
}

/**
 * Start the periodic poller. No-op — logged once — when the feature is disabled.
 * @param {import('pino').Logger} log_
 */
function start(log_) {
  if (log_) logger = log_.child({ svc: 'weather' });

  if (!isEnabled()) {
    log().info('Weather: disabled — poller not started');
    return;
  }
  if (bootTimer || poller) return;   // already running

  const intervalMs = envInt('WEATHER_POLL_INTERVAL_MIN', 60) * 60 * 1000;
  // Delay + jitter: systemd restarts the backend every 5 s on failure, and without
  // this a crash loop would replay the whole sweep against a free API each time.
  const bootDelayMs = BOOT_DELAY_MS + Math.floor(Math.random() * BOOT_JITTER_MS);

  bootTimer = setTimeout(() => {
    bootTimer = null;
    pollOnce();                                  // never rejects — see pollOnce()
    poller = setInterval(pollOnce, intervalMs);
  }, bootDelayMs);

  log().info({ intervalMs, bootDelayMs }, 'Weather poller started');
}

/** Clear every timer. Must stay in the index.js shutdown() list. */
function shutdown() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (poller)    { clearInterval(poller);   poller = null; }
  cache.clear();
  if (logger) logger.info('Weather service stopped');
}

/**
 * Current conditions for a coordinate.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ observed_at, temp_c, humidity, pressure_hpa, wind_ms, weather_code, timezone }|null>}
 */
async function current(lat, lon) {
  if (!isEnabled()) return null;

  const g = grid(lat, lon);
  if (!g) return null;

  const key = `c|${g.lat}|${g.lon}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const json = await fetchJson(buildUrl([g.lat], [g.lon], { current: true }), { lat: g.lat, lon: g.lon });
  const value = readCurrent(asList(json)[0]);
  if (value) cacheSet(key, value);
  return value;
}

/**
 * Hourly forecast for a coordinate.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [hours=24]  clamped to 1..168
 * @returns {Promise<{ timezone: string|null, hourly: Array<object> }|null>}
 */
async function forecast(lat, lon, hours = 24) {
  if (!isEnabled()) return null;

  const g = grid(lat, lon);
  if (!g) return null;
  const n = clampHours(hours);

  const key = `f|${g.lat}|${g.lon}|${n}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const json  = await fetchJson(buildUrl([g.lat], [g.lon], { hourlyHours: n }), { lat: g.lat, lon: g.lon, hours: n });
  const entry = asList(json)[0];
  if (!entry) return null;

  const value = readForecast(entry);
  cacheSet(key, value);
  return value;
}

/**
 * Everything `GET /api/sites/:id/weather` needs — current conditions, the
 * hourly forecast and the IANA zone — from ONE upstream request. Both halves
 * are seeded into the shared cache, so a later current()/forecast() call for
 * the same cell is free.
 * @returns {Promise<{ current: object|null, forecast: Array<object>, timezone: string|null }|null>}
 */
async function siteWeather(lat, lon, hours = 24) {
  if (!isEnabled()) return null;

  const g = grid(lat, lon);
  if (!g) return null;
  const n = clampHours(hours);

  const curKey = `c|${g.lat}|${g.lon}`;
  const fcKey  = `f|${g.lat}|${g.lon}|${n}`;

  let cur = cacheGet(curKey);
  let fc  = cacheGet(fcKey);

  if (cur === undefined || fc === undefined) {
    const json  = await fetchJson(
      buildUrl([g.lat], [g.lon], { current: true, hourlyHours: n }),
      { lat: g.lat, lon: g.lon, hours: n }
    );
    const entry = asList(json)[0];
    if (!entry) return null;

    cur = readCurrent(entry);
    fc  = readForecast(entry);
    if (cur) cacheSet(curKey, cur);
    cacheSet(fcKey, fc);
  }

  if (!cur && (!fc || fc.hourly.length === 0)) return null;

  return {
    current:  cur || null,
    forecast: fc ? fc.hourly : [],
    timezone: (cur && cur.timezone) || (fc && fc.timezone) || null,
  };
}

/**
 * IANA timezone for a coordinate, taken from the Open-Meteo response.
 * This is how sites.timezone is filled automatically after geocoding — no extra
 * npm dependency. Returns null when weather is disabled, so the operator can
 * still set the zone by hand.
 * @returns {Promise<string|null>}
 */
async function timezoneFor(lat, lon) {
  const cur = await current(lat, lon);
  return (cur && cur.timezone) || null;
}

// ── Poller ────────────────────────────────────────────────

/**
 * Run one sweep now. Never rejects — the whole body is wrapped, because an
 * escaped rejection is fatal in Node 22 and would feed straight back into the
 * systemd restart loop.
 * Exported so ops (and the tests) can trigger a sweep without waiting an hour.
 */
async function pollOnce() {
  if (!isEnabled()) return { coordinates: 0, requests: 0, inserted: 0, skipped: 'disabled' };
  if (sweeping) {
    log().debug('Weather: sweep already in progress — skipped');
    return { coordinates: 0, requests: 0, inserted: 0, skipped: 'in_progress' };
  }

  sweeping = true;
  const started = Date.now();
  let requests = 0;
  let inserted = 0;
  let coordinates = 0;

  try {
    // System-wide background sweep across every tenant — the same shape as the
    // OTA status checker. Tenant isolation is preserved by carrying each site's
    // own tenant_id into weather_observations (composite FK to sites).
    const { rows } = await db.query(
      `SELECT id, tenant_id, latitude, longitude, timezone
         FROM sites
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
        ORDER BY id
        LIMIT $1`,
      [MAX_POLL_SITES]
    );

    // One request per DISTINCT rounded coordinate, not one per site.
    /** @type {Map<string, { lat: number, lon: number, sites: Array<object> }>} */
    const byCoord = new Map();
    for (const site of rows) {
      const nLat = toNum(site.latitude);
      const nLon = toNum(site.longitude);
      if (!validCoords(nLat, nLon)) continue;
      const lat = round(nLat);
      const lon = round(nLon);
      const key = `${lat}|${lon}`;
      let bucket = byCoord.get(key);
      if (!bucket) { bucket = { lat, lon, sites: [] }; byCoord.set(key, bucket); }
      bucket.sites.push(site);
    }

    const buckets = Array.from(byCoord.values());
    coordinates = buckets.length;

    for (let i = 0; i < buckets.length; i += COORDS_PER_REQUEST) {
      const chunk = buckets.slice(i, i + COORDS_PER_REQUEST);
      if (i > 0) await sleep(CHUNK_DELAY_MS);

      const url  = buildUrl(chunk.map(b => b.lat), chunk.map(b => b.lon), { current: true });
      const json = await fetchJson(url, { coordinates: chunk.length });
      requests++;
      if (!json) continue;

      const entries = asList(json);
      const observations = [];
      const tzUpdates = new Map();   // IANA zone → site ids still missing one

      // Open-Meteo answers in request order, so index i maps back to chunk[i].
      for (let j = 0; j < chunk.length; j++) {
        const reading = readCurrent(entries[j]);
        if (!reading || !reading.observed_at) continue;

        cacheSet(`c|${chunk[j].lat}|${chunk[j].lon}`, reading);

        for (const site of chunk[j].sites) {
          observations.push([
            site.id, site.tenant_id, reading.observed_at,
            reading.temp_c, reading.humidity, reading.pressure_hpa,
            reading.wind_ms, reading.weather_code,
          ]);
          if (reading.timezone && !site.timezone) {
            if (!tzUpdates.has(reading.timezone)) tzUpdates.set(reading.timezone, []);
            tzUpdates.get(reading.timezone).push(site.id);
          }
        }
      }

      inserted += await insertObservations(observations);
      await fillTimezones(tzUpdates);
    }

    log().info(
      { coordinates, sites: rows.length, requests, inserted, ms: Date.now() - started },
      'Weather sweep finished'
    );
  } catch (err) {
    log().error({ err }, 'Weather sweep failed');
  } finally {
    sweeping = false;
  }

  return { coordinates, requests, inserted };
}

/**
 * Multi-row INSERT of observations, chunked. `ON CONFLICT DO NOTHING` makes a
 * restart inside the same hour a no-op (observed_at is hour-aligned).
 * @param {Array<Array<any>>} rows
 * @returns {Promise<number>} rows attempted
 */
async function insertObservations(rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const params = [];
    const tuples = [];
    for (const row of chunk) {
      const base = params.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      params.push(...row);
    }
    await db.query(
      `INSERT INTO weather_observations
         (site_id, tenant_id, observed_at, temp_c, humidity, pressure_hpa, wind_ms, weather_code)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (site_id, observed_at) DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return written;
}

/**
 * Fill sites.timezone from the Open-Meteo response (extra #4). Only ever fills a
 * NULL — a zone the operator set by hand is never overwritten. `updated_at` is
 * set explicitly: there is no updated_at trigger on sites by design.
 * @param {Map<string, string[]>} tzUpdates  IANA zone → site ids
 */
async function fillTimezones(tzUpdates) {
  for (const [tz, siteIds] of tzUpdates) {
    if (siteIds.length === 0) continue;
    await db.query(
      `UPDATE sites
          SET timezone = $1, updated_at = NOW()
        WHERE id = ANY($2::uuid[])
          AND timezone IS NULL`,
      [tz, siteIds]
    );
  }
}

module.exports = {
  isEnabled,
  init,
  start,
  shutdown,
  current,
  forecast,
  siteWeather,
  timezoneFor,
  pollOnce,
  clearCache,
};
