'use strict';

/**
 * routing.js — service-round planning (OSRM) and coverage isochrones (OpenRouteService).
 *
 * Both providers are disabled by default and every entry point degrades instead
 * of failing: `route()` / `trip()` answer `null` so the caller can fall back to
 * the haversine helpers below, and `isochrones()` answers straight-line rings
 * flagged `approximate: true`. Nothing here ever throws at the caller.
 *
 * LICENSING: the public OSRM demo server is explicitly not for production and
 * the OpenRouteService free tier is rate-limited and commercially restricted.
 * See docs/THIRD_PARTY_LICENSING.md.
 */

// ── Config ────────────────────────────────────────────────

const DEFAULT_ORS_URL = 'https://api.openrouteservice.org';

const OSRM_PROFILE   = 'driving';       // OSRM demo server only serves the car profile
const ORS_PROFILE    = 'driving-car';
const MAX_POINTS     = 25;              // matches the API cap in POST /api/map/route
const COORD_DP       = 6;               // ~0.1 m — plenty, and keeps the URL numeric-only
const RING_POINTS    = 64;              // vertices per approximate isochrone ring
const MAX_RANGES     = 3;               // at most three isochrone bands per request
const MAX_MINUTES    = 120;
const METRES_PER_DEG_LAT = 111320;      // WGS-84 mean

/**
 * Average speed assumed by the fallback rings. 30 km/h is a realistic
 * urban/suburban service-van average once junctions, lights and parking are
 * included — deliberately pessimistic, because an over-large ring would suggest
 * coverage that does not exist. The UI must label these rings as approximate.
 */
const ASSUMED_SPEED_KMH = 30;

let logger = null;

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
 * Logger accessor. Routing is called straight from route handlers and may never
 * be wired from index.js, so fall back to a local pino instance.
 */
function log() {
  if (!logger) {
    logger = require('pino')({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })
      .child({ svc: 'routing' });
  }
  return logger;
}

/** Optional wiring hook — mirrors the other services. */
function init(log_) {
  if (log_) logger = log_.child({ svc: 'routing' });
  log().info(
    { osrm: isEnabled(), isochrones: isochronesEnabled() },
    'Routing service configured'
  );
  return isEnabled();
}

/** Base URL with a guaranteed trailing slash so `new URL(path, base)` keeps any path prefix. */
function baseUrl(raw, fallback) {
  const value = (raw || '').trim() || fallback || '';
  return value.replace(/\/+$/, '') + '/';
}

/**
 * `new URL()` throws on a malformed base — a misconfigured OSRM_URL must
 * degrade like any other upstream failure, not blow up the request handler.
 * @returns {URL|null}
 */
function makeUrl(path, base) {
  try {
    return new URL(path, base);
  } catch (err) {
    log().warn({ err: err.message, base }, 'Routing: malformed provider URL');
    return null;
  }
}

/**
 * Strict numeric coercion. Plain `Number()` turns null, '' and false into 0,
 * which would silently place a point without coordinates on Null Island.
 */
function toNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  return Number(v);
}

function validPoint(p) {
  if (!p) return false;
  const lat = toNum(p.lat);
  const lon = toNum(p.lon);
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * OSRM takes coordinates in the URL PATH and OSRM_URL points at an internal
 * host, so nothing but numbers may ever reach it: every value goes through
 * toNum(...).toFixed(), which cannot produce a path separator, a query or a
 * host. The `,` and `;` separators are structural OSRM syntax and are therefore
 * not percent-encoded; the surrounding path segments are.
 */
function coordString(points) {
  return points
    .map(p => `${toNum(p.lon).toFixed(COORD_DP)},${toNum(p.lat).toFixed(COORD_DP)}`)
    .join(';');
}

function clampLat(v) { return Math.min(90, Math.max(-90, v)); }
function wrapLon(v)  { return ((v + 180) % 360 + 360) % 360 - 180; }

/**
 * GET/POST a JSON document. Never throws: a timeout, a non-2xx or a malformed
 * body all resolve to null after a structured warn.
 */
async function fetchJson(url, { timeoutMs, method = 'GET', body = null, headers = {}, ctx = {} }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    log().warn({ err: err.message, timeoutMs, ...ctx }, 'Routing: upstream request failed');
    return null;
  }
  if (!res.ok) {
    log().warn({ status: res.status, ...ctx }, 'Routing: upstream returned non-2xx');
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    log().warn({ err: err.message, ...ctx }, 'Routing: upstream returned invalid JSON');
    return null;
  }
}

// ── Distance helpers (no upstream needed) ─────────────────

/**
 * Great-circle distance in kilometres. Used by the nearest-technician endpoint
 * and by the route fallback, both of which must work with OSRM_URL empty.
 * @returns {number} kilometres, or NaN for invalid input
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;                    // mean Earth radius, km
  const toRad = d => (d * Math.PI) / 180;

  const [a1, o1, a2, o2] = [lat1, lon1, lat2, lon2].map(toNum);
  if (![a1, o1, a2, o2].every(Number.isFinite)) return NaN;

  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest-neighbour ordering over straight-line distances — the degradation
 * path for POST /api/map/route when OSRM is unset or down. Orientation only:
 * it is not drive-time optimised and the UI must say so.
 * @param {Array<{lat:number,lon:number}>} points
 * @param {number} [startIndex=0]
 * @returns {{ order: number[], total_distance_m: number }}
 */
function nearestNeighbourOrder(points, startIndex = 0) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length === 0) return { order: [], total_distance_m: 0 };

  const start = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < pts.length
    ? startIndex : 0;

  const remaining = new Set(pts.map((_, i) => i));
  remaining.delete(start);

  const order = [start];
  let totalKm = 0;
  let currentIdx = start;

  while (remaining.size > 0) {
    let bestIdx = null;
    let bestKm = Infinity;
    for (const idx of remaining) {
      const km = haversineKm(pts[currentIdx].lat, pts[currentIdx].lon, pts[idx].lat, pts[idx].lon);
      // NaN never wins: an unusable point is appended last rather than dropped.
      if (Number.isFinite(km) && km < bestKm) { bestKm = km; bestIdx = idx; }
    }
    if (bestIdx === null) { for (const idx of remaining) order.push(idx); break; }
    totalKm += bestKm;
    order.push(bestIdx);
    remaining.delete(bestIdx);
    currentIdx = bestIdx;
  }

  return { order, total_distance_m: Math.round(totalKm * 1000) };
}

// ── OSRM ──────────────────────────────────────────────────

/** @returns {boolean} true when OSRM_URL is configured. */
function isEnabled() {
  return !off(process.env.OSRM_URL);
}

/** Build an OSRM service URL. Returns null when the input is unusable. */
function osrmUrl(service, points) {
  if (!isEnabled()) return null;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS) return null;
  if (!points.every(validPoint)) return null;

  const path = `${encodeURIComponent(service)}/v1/${encodeURIComponent(OSRM_PROFILE)}/${coordString(points)}`;
  const url = makeUrl(path, baseUrl(process.env.OSRM_URL));
  if (!url) return null;

  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  return url;
}

/**
 * Shortest path through the points in the order given.
 * @param {Array<{lat:number,lon:number}>} points  2..25 points
 * @returns {Promise<{order:number[], legs:Array<object>, geometry:object|null,
 *                    total_distance_m:number, total_duration_s:number,
 *                    provider:'osrm', optimized:false}|null>}
 */
async function route(points) {
  if (!isEnabled()) return null;

  const url = osrmUrl('route', points);
  if (!url) {
    log().warn({ count: Array.isArray(points) ? points.length : 0 }, 'Routing: invalid route input');
    return null;
  }

  const json = await fetchJson(url, {
    timeoutMs: envInt('OSRM_TIMEOUT_MS', 10000),
    ctx: { service: 'route', points: points.length },
  });
  if (!json || json.code !== 'Ok' || !Array.isArray(json.routes) || json.routes.length === 0) {
    if (json) log().warn({ code: json.code, service: 'route' }, 'Routing: OSRM returned no route');
    return null;
  }

  const r = json.routes[0];
  const legs = (Array.isArray(r.legs) ? r.legs : []).map((leg, i) => ({
    from: i,
    to: i + 1,
    distance_m: Math.round(Number(leg.distance) || 0),
    duration_s: Math.round(Number(leg.duration) || 0),
  }));

  return {
    order: points.map((_, i) => i),
    legs,
    geometry: r.geometry || null,
    total_distance_m: Math.round(Number(r.distance) || 0),
    total_duration_s: Math.round(Number(r.duration) || 0),
    provider: 'osrm',
    optimized: false,
  };
}

/**
 * Travelling-salesman optimisation over the points (OSRM /trip).
 * @param {Array<{lat:number,lon:number}>} points  2..25 points
 * @param {{ roundtrip?: boolean, source?: 'first'|'any', destination?: 'last'|'any' }} [opts]
 * @returns {Promise<{order:number[], legs:Array<object>, geometry:object|null,
 *                    total_distance_m:number, total_duration_s:number,
 *                    provider:'osrm', optimized:true}|null>}
 *   `order` holds INPUT indices in visiting order.
 */
async function trip(points, opts = {}) {
  if (!isEnabled()) return null;

  const url = osrmUrl('trip', points);
  if (!url) {
    log().warn({ count: Array.isArray(points) ? points.length : 0 }, 'Routing: invalid trip input');
    return null;
  }

  const roundtrip = opts.roundtrip !== false;
  url.searchParams.set('roundtrip', roundtrip ? 'true' : 'false');
  // OSRM only accepts roundtrip=false when at least the start is pinned.
  url.searchParams.set('source', opts.source === 'any' ? 'any' : 'first');
  if (!roundtrip) url.searchParams.set('destination', opts.destination === 'any' ? 'any' : 'last');

  const json = await fetchJson(url, {
    timeoutMs: envInt('OSRM_TIMEOUT_MS', 10000),
    ctx: { service: 'trip', points: points.length, roundtrip },
  });
  if (!json || json.code !== 'Ok' || !Array.isArray(json.trips) || json.trips.length === 0) {
    if (json) log().warn({ code: json.code, service: 'trip' }, 'Routing: OSRM returned no trip');
    return null;
  }

  const t = json.trips[0];

  // waypoints[i].waypoint_index is the position of INPUT point i in the optimised
  // tour, so sorting by it turns the response back into an order of input indices.
  const order = (Array.isArray(json.waypoints) ? json.waypoints : [])
    .map((w, inputIndex) => ({ inputIndex, pos: Number(w && w.waypoint_index) }))
    .filter(x => Number.isFinite(x.pos))
    .sort((a, b) => a.pos - b.pos)
    .map(x => x.inputIndex);

  if (order.length !== points.length) {
    log().warn({ expected: points.length, got: order.length }, 'Routing: incomplete OSRM waypoint set');
    return null;
  }

  // Leg i connects stop i to stop i+1 of the optimised tour; on a roundtrip the
  // final leg closes the loop back to the first stop.
  const legs = (Array.isArray(t.legs) ? t.legs : []).map((leg, i) => ({
    from: order[i],
    to: order[i + 1] !== undefined ? order[i + 1] : order[0],
    distance_m: Math.round(Number(leg.distance) || 0),
    duration_s: Math.round(Number(leg.duration) || 0),
  }));

  return {
    order,
    legs,
    geometry: t.geometry || null,
    total_distance_m: Math.round(Number(t.distance) || 0),
    total_duration_s: Math.round(Number(t.duration) || 0),
    provider: 'osrm',
    optimized: true,
  };
}

// ── OpenRouteService pacing ───────────────────────────────
// ORS meters per ACCOUNT, not per user: the free plan allows 20 isochrone
// requests a minute and 500 a day. `externalLimiter` in index.js is per-user and
// allows 30/min, so a single enthusiastic user — let alone two — would exhaust
// the account budget and every isochrone would quietly downgrade to an
// approximate ring. One process-wide pacer keeps us under the account ceiling
// regardless of how many people are on the map.
//
// When the pacer is already backed up we degrade immediately rather than making
// someone wait behind a queue: an approximate ring now beats a real polygon in
// fifteen seconds, and the UI labels it as approximate either way.
const ORS_MIN_INTERVAL_MS = 3500;   // ≈17 req/min, headroom under the 20/min cap
const ORS_MAX_QUEUED      = 3;

let orsChain  = Promise.resolve();
let orsLastAt = 0;
let orsQueued = 0;

/**
 * Pacer interval. Read directly rather than through envInt(), which rejects 0 as
 * a valid value — and 0 is meaningful here: a self-hosted ORS has no account
 * quota, so an operator pointing ORS_URL at their own instance should be able to
 * turn the pacing off entirely.
 */
function orsGapMs() {
  const n = parseInt(process.env.ORS_MIN_INTERVAL_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : ORS_MIN_INTERVAL_MS;
}

/** Run `work` on the shared ORS pacer. Returns null when the queue is saturated. */
function paceOrs(work) {
  if (orsQueued >= ORS_MAX_QUEUED) return null;
  orsQueued++;
  const run = orsChain
    .then(async () => {
      const gap  = orsGapMs();
      const wait = orsLastAt + gap - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      orsLastAt = Date.now();
      return work();
    })
    .finally(() => { orsQueued--; });
  // Swallow rejections on the chain itself so one failure cannot wedge the pacer.
  orsChain = run.then(() => {}, () => {});
  return run;
}

// ── OpenRouteService isochrones ───────────────────────────

/**
 * Gated on the KEY, never the URL: ORS_URL ships populated while ORS_API_KEY is
 * empty, so a URL-based gate would advertise isochrones and then 403 on every
 * call instead of drawing the approximate rings.
 * @returns {boolean}
 */
function isochronesEnabled() {
  return !off(process.env.ORS_API_KEY);
}

/** Normalise the requested bands: at most 3 distinct integers in 1..120 minutes. */
function normaliseMinutes(minutes) {
  const list = Array.isArray(minutes) ? minutes : [minutes];
  const clean = [];
  for (const m of list) {
    const n = Number(m);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) continue;
    if (!clean.includes(n)) clean.push(n);
    if (clean.length === MAX_RANGES) break;
  }
  return clean.sort((a, b) => a - b);
}

/**
 * A circle of `radiusM` around the point, as a GeoJSON Polygon.
 * The longitude delta is divided by cos(latitude): at ~50°N a degree of
 * longitude is ~71.7 km against ~111.3 km for latitude, so equal-degree offsets
 * would draw an ellipse ~1.55x too wide.
 */
function ringPolygon(lat, lon, radiusM) {
  const latRad = (lat * Math.PI) / 180;
  const dLat = radiusM / METRES_PER_DEG_LAT;
  const cos  = Math.max(Math.abs(Math.cos(latRad)), 1e-6);   // no divide-by-zero at the poles
  const dLon = radiusM / (METRES_PER_DEG_LAT * cos);

  const coords = [];
  for (let i = 0; i < RING_POINTS; i++) {
    const theta = (i / RING_POINTS) * 2 * Math.PI;
    coords.push([
      Number(wrapLon(lon + dLon * Math.cos(theta)).toFixed(COORD_DP)),
      Number(clampLat(lat + dLat * Math.sin(theta)).toFixed(COORD_DP)),
    ]);
  }
  coords.push(coords[0]);   // GeoJSON rings must be closed

  return { type: 'Polygon', coordinates: [coords] };
}

/** Straight-line fallback bands, largest first so the small ones stay on top. */
function approximateCollection(lat, lon, minutes) {
  const features = [...minutes].sort((a, b) => b - a).map(m => ({
    type: 'Feature',
    geometry: ringPolygon(lat, lon, (ASSUMED_SPEED_KMH * 1000 / 60) * m),
    properties: {
      value: m * 60,
      minutes: m,
      approximate: true,
      provider: null,
      assumed_speed_kmh: ASSUMED_SPEED_KMH,
    },
  }));

  return {
    collection: { type: 'FeatureCollection', features },
    meta: { approximate: true, provider: null, assumed_speed_kmh: ASSUMED_SPEED_KMH, minutes },
  };
}

/**
 * Drive-time coverage polygons around a point.
 * With ORS_API_KEY set these are real isochrones; without it — or when ORS
 * times out, 4xx's or answers garbage — they are straight-line rings and every
 * Feature carries `approximate: true` so the flag travels with the geometry
 * that gets drawn, cached or exported.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number[]} minutes  up to 3 values in 1..120
 * @returns {Promise<{ collection: object,
 *                     meta: { approximate: boolean, provider: string|null,
 *                             assumed_speed_kmh: number|null, minutes: number[] } }|null>}
 *   null only for unusable input.
 */
async function isochrones(lat, lon, minutes) {
  const nLat = toNum(lat);
  const nLon = toNum(lon);
  if (!validPoint({ lat: nLat, lon: nLon })) {
    log().warn({ lat, lon }, 'Routing: invalid isochrone centre');
    return null;
  }

  const bands = normaliseMinutes(minutes);
  if (bands.length === 0) {
    log().warn({ minutes }, 'Routing: no usable isochrone ranges');
    return null;
  }

  if (!isochronesEnabled()) return approximateCollection(nLat, nLon, bands);

  const url = makeUrl(
    `v2/isochrones/${encodeURIComponent(ORS_PROFILE)}`,
    baseUrl(process.env.ORS_URL, DEFAULT_ORS_URL)
  );
  if (!url) return approximateCollection(nLat, nLon, bands);

  const paced = paceOrs(() => fetchJson(url, {
    timeoutMs: envInt('ORS_TIMEOUT_MS', 10000),
    method: 'POST',
    headers: { Authorization: process.env.ORS_API_KEY.trim(), 'Content-Type': 'application/json' },
    body: {
      locations:  [[Number(nLon.toFixed(COORD_DP)), Number(nLat.toFixed(COORD_DP))]],
      range:      bands.map(m => m * 60),
      range_type: 'time',
    },
    ctx: { service: 'isochrones', bands: bands.length },
  }));
  if (!paced) {
    log().info({ lat: nLat, lon: nLon }, 'Routing: ORS pacer saturated — serving approximate rings');
    return approximateCollection(nLat, nLon, bands);
  }
  const json = await paced;

  const raw = json && Array.isArray(json.features) ? json.features : null;
  if (!raw || raw.length === 0) {
    log().warn({ lat: nLat, lon: nLon, bands }, 'Routing: ORS unavailable — falling back to approximate rings');
    return approximateCollection(nLat, nLon, bands);
  }

  const features = raw
    .filter(f => f && f.geometry)
    .map(f => {
      const seconds = Number(f.properties && f.properties.value);
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          value: Number.isFinite(seconds) ? seconds : null,
          minutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : null,
          approximate: false,
          provider: 'openrouteservice',
          assumed_speed_kmh: null,
        },
      };
    })
    // Largest band first so the smaller polygons stay visible on top of it.
    .sort((a, b) => (b.properties.value || 0) - (a.properties.value || 0));

  if (features.length === 0) return approximateCollection(nLat, nLon, bands);

  return {
    collection: { type: 'FeatureCollection', features },
    meta: { approximate: false, provider: 'openrouteservice', assumed_speed_kmh: null, minutes: bands },
  };
}

module.exports = {
  init,
  isEnabled,
  isochronesEnabled,
  route,
  trip,
  isochrones,
  haversineKm,
  nearestNeighbourOrder,
  ASSUMED_SPEED_KMH,
};
