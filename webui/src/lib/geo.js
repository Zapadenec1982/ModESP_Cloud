/**
 * Geo helpers shared by every map surface: tile configuration, route deep-links,
 * coordinate maths, status derivation and the thin REST calls the map components
 * make on their own.
 *
 * No Leaflet import here on purpose — address forms and the public status page
 * pull in the deep-link builders without dragging ~150 KB of map code with them.
 */

// ── Tile configuration ───────────────────────────────────
//
// Build-time config, see `webui/.env.example`. The defaults are the values the
// fleet map shipped with, so an absent .env changes nothing.
//
// !! Changing the tile host ALSO requires updating `img-src` in
// !! `backend/src/index.js` (helmet CSP) and in BOTH Content-Security-Policy
// !! headers in `infra/nginx/modesp.conf` (lines 38 and 119). Miss either one and
// !! every tile request is blocked and the map renders grey.
//
// No other external host is contacted from the browser: Nominatim, Open-Meteo,
// OSRM and OpenRouteService are all called server-side, and the Google / Apple /
// Waze / OSM links below are top-level navigations, which CSP does not gate.
// The public OSM tile server has its own usage policy — see
// `docs/THIRD_PARTY_LICENSING.md` before a commercial rollout.

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

export const TILE_URL =
  env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

export const TILE_ATTRIBUTION =
  env.VITE_MAP_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'

export const TILE_MAX_ZOOM = 19

/** Geographic centre of Ukraine — the fleet's home region. */
export const DEFAULT_CENTER = [49.0, 31.4]
export const DEFAULT_ZOOM = 6

/** Zoom used when focusing a single known point (site card, address picker). */
export const POINT_ZOOM = 15

// ── Coordinate primitives ────────────────────────────────

/**
 * Numeric coercion that does NOT turn null/''/undefined into 0.
 * `Number(null) === 0` would silently place a coordinate-less site on Null Island.
 */
function num(value) {
  if (value === null || value === undefined || value === '') return NaN
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : NaN
}

/** True when both values are finite and inside the WGS84 ranges. */
export function isValidCoords(lat, lon) {
  const la = num(lat)
  const lo = num(lon)
  return (
    Number.isFinite(la) && Number.isFinite(lo) &&
    la >= -90 && la <= 90 && lo >= -180 && lo <= 180
  )
}

/** Round to `dp` decimals (6 dp ≈ 11 cm — the precision the API stores). */
export function roundCoord(value, dp = 6) {
  const n = num(value)
  if (!Number.isFinite(n)) return null
  const f = Math.pow(10, dp)
  return Math.round(n * f) / f
}

export function clampLat(value) {
  const n = num(value)
  if (!Number.isFinite(n)) return null
  return Math.max(-90, Math.min(90, n))
}

export function clampLon(value) {
  const n = num(value)
  if (!Number.isFinite(n)) return null
  return Math.max(-180, Math.min(180, n))
}

/** "50.44980, 30.52310" — or `null` when there is nothing to show. */
export function formatCoords(lat, lon, dp = 5) {
  if (!isValidCoords(lat, lon)) return null
  return `${num(lat).toFixed(dp)}, ${num(lon).toFixed(dp)}`
}

/** Great-circle distance in kilometres. NaN when either point is invalid. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  if (!isValidCoords(lat1, lon1) || !isValidCoords(lat2, lon2)) return NaN
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(num(lat2) - num(lat1))
  const dLon = toRad(num(lon2) - num(lon1))
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(num(lat1))) * Math.cos(toRad(num(lat2))) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Leaflet LatLngBounds → the `bbox=minLon,minLat,maxLon,maxLat` the API expects,
 * clamped to the valid ranges (a world-spanning view reports more than 360°).
 */
export function boundsToBbox(bounds) {
  if (!bounds || typeof bounds.getWest !== 'function') return null
  const minLon = clampLon(bounds.getWest())
  const minLat = clampLat(bounds.getSouth())
  const maxLon = clampLon(bounds.getEast())
  const maxLat = clampLat(bounds.getNorth())
  if ([minLon, minLat, maxLon, maxLat].some((v) => v === null)) return null
  return [
    roundCoord(minLon), roundCoord(minLat),
    roundCoord(maxLon), roundCoord(maxLat),
  ]
}

// ── Effective coordinates ────────────────────────────────
//
// A device may carry its own coordinates (per-device override) or inherit them
// from its site. `GET /api/devices` returns the RAW device columns plus the
// joined `site_latitude` / `site_longitude`, so resolution happens client-side.

/** `{ latitude, longitude, source: 'device' | 'site' | null }` */
export function effectiveCoords(device) {
  if (!device) return { latitude: null, longitude: null, source: null }
  if (isValidCoords(device.latitude, device.longitude)) {
    return {
      latitude: num(device.latitude),
      longitude: num(device.longitude),
      source: 'device',
    }
  }
  if (isValidCoords(device.site_latitude, device.site_longitude)) {
    return {
      latitude: num(device.site_latitude),
      longitude: num(device.site_longitude),
      source: 'site',
    }
  }
  return { latitude: null, longitude: null, source: null }
}

export function effectiveLatitude(device) {
  return effectiveCoords(device).latitude
}

export function effectiveLongitude(device) {
  return effectiveCoords(device).longitude
}

export function hasEffectiveCoords(device) {
  return effectiveCoords(device).source !== null
}

// ── Status derivation ────────────────────────────────────

const STATUS_RANK = { online: 1, offline: 2, alarm: 3 }

/** 'alarm' | 'offline' | 'online' for a single device row. */
export function deviceStatus(device) {
  if (!device) return 'offline'
  if (device.alarm_active) return 'alarm'
  return device.online ? 'online' : 'offline'
}

/** Worst status wins: alarm > offline > online. */
export function worstStatus(statuses) {
  let worst = 'online'
  for (const s of statuses || []) {
    if ((STATUS_RANK[s] || 0) > (STATUS_RANK[worst] || 0)) worst = s
  }
  return worst
}

export function statusRank(status) {
  return STATUS_RANK[status] || 0
}

/**
 * Status of one map Feature. `/api/map/devices` gives per-site counters; the
 * synthetic per-device features carry `online` / `alarm_active` instead.
 */
export function featureStatus(feature) {
  const p = (feature && feature.properties) || {}
  if (Number(p.alarm_count) > 0) return 'alarm'
  if (p.alarm_active) return 'alarm'
  // Worst status wins, so offline_count is read BEFORE online_count: a site with
  // one live cabinet out of twenty is a partial outage, not a healthy site, and
  // must not paint the same green as a fully online one. The counters always
  // arrive together from /api/map/devices, so this never reaches the devices[]
  // fallback below for a real payload.
  if (Number(p.offline_count) > 0) return 'offline'
  if (Number(p.online_count) > 0) return 'online'
  if (p.online === true) return 'online'
  if (Array.isArray(p.devices) && p.devices.length > 0) {
    return worstStatus(p.devices.map(deviceStatus))
  }
  return 'offline'
}

/** Devices represented by a Feature — sites carry a counter, devices count as 1. */
export function featureDeviceCount(feature) {
  const p = (feature && feature.properties) || {}
  const n = Number(p.device_count)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  if (Array.isArray(p.devices) && p.devices.length > 0) return p.devices.length
  return 1
}

/**
 * Stable identity for a Feature, used as the marker map key. Site features carry
 * `site_id`; devices with own coordinates but no site come through as synthetic
 * features keyed by device id.
 */
export function featureKey(feature) {
  if (!feature) return null
  const p = feature.properties || {}
  if (p.site_id) return `site:${p.site_id}`
  if (p.device_id) return `dev:${p.device_id}`
  if (p.mqtt_device_id) return `dev:${p.mqtt_device_id}`
  if (feature.id !== undefined && feature.id !== null) return `f:${feature.id}`
  const c = (feature.geometry && feature.geometry.coordinates) || []
  if (c.length >= 2) return `pt:${roundCoord(c[1])},${roundCoord(c[0])}`
  return null
}

/** The site id behind a Feature, or null for a site-less device feature. */
export function featureSiteId(feature) {
  const p = (feature && feature.properties) || {}
  return p.site_id || null
}

/** `[lat, lon]` of a Feature, or null when the geometry is unusable. */
export function featureLatLng(feature) {
  const c = (feature && feature.geometry && feature.geometry.coordinates) || []
  if (c.length < 2) return null
  const lat = num(c[1])
  const lon = num(c[0])
  if (!isValidCoords(lat, lon)) return null
  return [lat, lon]
}

// ── Route deep-links ─────────────────────────────────────
//
// All four are plain navigations to a third-party map app. Render them with
// target="_blank" rel="noopener".

function pair(lat, lon) {
  return `${roundCoord(lat)},${roundCoord(lon)}`
}

export function googleDirectionsUrl(lat, lon) {
  if (!isValidCoords(lat, lon)) return null
  return `https://www.google.com/maps/dir/?api=1&destination=${pair(lat, lon)}`
}

export function appleDirectionsUrl(lat, lon) {
  if (!isValidCoords(lat, lon)) return null
  return `https://maps.apple.com/?daddr=${pair(lat, lon)}&dirflg=d`
}

export function wazeDirectionsUrl(lat, lon) {
  if (!isValidCoords(lat, lon)) return null
  return `https://waze.com/ul?ll=${pair(lat, lon)}&navigate=yes`
}

export function osmDirectionsUrl(lat, lon) {
  if (!isValidCoords(lat, lon)) return null
  return `https://www.openstreetmap.org/directions?to=${roundCoord(lat)}%2C${roundCoord(lon)}`
}

/**
 * The four deep-links as a list, ready to render. `labelKey` is an i18n key —
 * callers resolve it through `$t()`; nothing here is user-facing text.
 * Returns `[]` when the point has no usable coordinates.
 */
export function routeLinks(lat, lon) {
  if (!isValidCoords(lat, lon)) return []
  return [
    { key: 'google', labelKey: 'map.route_google', url: googleDirectionsUrl(lat, lon) },
    { key: 'apple',  labelKey: 'map.route_apple',  url: appleDirectionsUrl(lat, lon) },
    { key: 'waze',   labelKey: 'map.route_waze',   url: wazeDirectionsUrl(lat, lon) },
    { key: 'osm',    labelKey: 'map.route_osm',    url: osmDirectionsUrl(lat, lon) },
  ]
}

/**
 * Multi-stop Google Maps hand-off, used as the client-side fallback when the
 * backend could not build `google_maps_url` itself.
 *
 * @param {Array<{latitude:number, longitude:number}>} points — in visiting order
 * @param {{ origin?: {latitude:number, longitude:number}|null }} [opts]
 */
export function googleRouteUrl(points, { origin = null } = {}) {
  const stops = (points || []).filter((p) => p && isValidCoords(p.latitude, p.longitude))
  if (stops.length === 0) return null

  const hasOrigin = !!(origin && isValidCoords(origin.latitude, origin.longitude))
  const start = hasOrigin ? origin : stops[0]
  const rest = hasOrigin ? stops : stops.slice(1)
  if (rest.length === 0) return googleDirectionsUrl(start.latitude, start.longitude)

  const destination = rest[rest.length - 1]
  const waypoints = rest.slice(0, -1)

  let url =
    'https://www.google.com/maps/dir/?api=1' +
    `&origin=${pair(start.latitude, start.longitude)}` +
    `&destination=${pair(destination.latitude, destination.longitude)}`
  if (waypoints.length > 0) {
    url += `&waypoints=${waypoints.map((p) => pair(p.latitude, p.longitude)).join('%7C')}`
  }
  return url
}

// ── Geocoding precision / source ─────────────────────────

const PRECISION_KEYS = {
  house:   'site.precision_house',
  street:  'site.precision_street',
  city:    'site.precision_city',
  region:  'site.precision_region',
  country: 'site.precision_country',
}

/** i18n key for a `sites.geo_precision` value; unknown/NULL falls back. */
export function precisionKey(precision) {
  return PRECISION_KEYS[precision] || 'site.precision_unknown'
}

/**
 * WMO weather codes, as Open-Meteo reports them in `weather_code`, grouped down
 * to the sixteen conditions the locales carry. The intensity steps inside a group
 * (light / moderate / heavy drizzle = 51 / 53 / 55) are deliberately collapsed:
 * the number next to the reading is the temperature, and "Мряка" is all the
 * context a refrigeration operator needs from the sky.
 */
const WEATHER_CODE_KEYS = {
  0:  'site.wx_clear',
  1:  'site.wx_mainly_clear',
  2:  'site.wx_partly_cloudy',
  3:  'site.wx_overcast',
  45: 'site.wx_fog',          48: 'site.wx_fog',
  51: 'site.wx_drizzle',      53: 'site.wx_drizzle',      55: 'site.wx_drizzle',
  56: 'site.wx_freezing_drizzle', 57: 'site.wx_freezing_drizzle',
  61: 'site.wx_rain',         63: 'site.wx_rain',         65: 'site.wx_rain',
  66: 'site.wx_freezing_rain', 67: 'site.wx_freezing_rain',
  71: 'site.wx_snow',         73: 'site.wx_snow',         75: 'site.wx_snow',
  77: 'site.wx_snow_grains',
  80: 'site.wx_showers',      81: 'site.wx_showers',      82: 'site.wx_showers',
  85: 'site.wx_snow_showers', 86: 'site.wx_snow_showers',
  95: 'site.wx_thunderstorm',
  96: 'site.wx_thunderstorm_hail', 99: 'site.wx_thunderstorm_hail',
}

/** i18n key for a WMO `weather_code`; null/unknown falls back to wx_unknown. */
export function weatherCodeKey(code) {
  const n = num(code)   // NaN for null/''/undefined — never 0, which is "clear sky"
  return (Number.isFinite(n) && WEATHER_CODE_KEYS[n]) || 'site.wx_unknown'
}

const GEO_SOURCE_KEYS = {
  geocoded: 'site.geo_source_geocoded',
  manual:   'site.geo_source_manual',
  failed:   'site.geo_source_failed',
  none:     'site.geo_source_none',
}

/** i18n key for a `sites.geo_source` value. */
export function geoSourceKey(source) {
  return GEO_SOURCE_KEYS[source] || 'site.geo_source_none'
}

/** Single-line address from a site / address object; `null` when empty. */
export function formatAddress(site) {
  if (!site) return null
  const parts = [site.address_line, site.postal_code, site.city, site.region, site.country]
    .map((p) => (typeof p === 'string' ? p.trim() : p != null ? String(p) : ''))
    .filter((p) => p.length > 0)
  return parts.length > 0 ? parts.join(', ') : null
}

/** An empty structured address — the shape `AddressPicker mode="full"` binds. */
export function emptyAddress() {
  return {
    country_code: '',
    country: '',
    region: '',
    city: '',
    address_line: '',
    postal_code: '',
    latitude: null,
    longitude: null,
  }
}

// ── CSS custom properties for Leaflet vector styles ──────
//
// Leaflet path options take real colour strings, not `var(--x)`, so vectors are
// styled from the resolved token. Map components re-read these when the theme
// store changes.

export function cssVar(name, fallback) {
  if (typeof window === 'undefined' || !document.documentElement) return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name)
  const trimmed = (value || '').trim()
  return trimmed.length > 0 ? trimmed : fallback
}

// ── REST calls the map components make themselves ────────
//
// These deliberately do NOT go through `request()` in `lib/api.js`: that helper is
// module-private, and the map components ship in lazily-imported chunks that must
// keep working on their own. Pages that already own a wrapper can inject it —
// every component exposes a `*Fn` prop with these as the defaults.
//
// Each helper degrades where an empty answer is meaningful: the geocoder is
// ENV-gated server-side and answers `200 { data: [] }` when it is switched off, so
// "no suggestions" and "feature disabled" look identical by design.

const API_BASE = '/api'

async function accessToken() {
  try {
    const api = await import('./api.js')
    return typeof api.getAccessToken === 'function' ? api.getAccessToken() : null
  } catch {
    return null
  }
}

async function apiJson(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  const token = await accessToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message || `HTTP ${res.status}`)
    err.status = res.status
    err.body = body
    throw err
  }
  return res.json()
}

/**
 * `GET /api/geo/search` — address autocomplete, FULL envelope.
 *
 * `meta.enabled` is the only way to tell "GEOCODER_PROVIDER is off" from "no
 * matches": a disabled geocoder answers `200 { data: [], meta: { enabled: false } }`,
 * and an empty `data` alone would make the UI claim the address is unknown when
 * the feature is simply switched off (GEO_SPEC §1.2).
 *
 * Queries shorter than 3 characters resolve without touching the network.
 * @returns {Promise<{data: Array, meta: object}>}
 */
export async function geoSearchFull(query, limit = 6) {
  const q = String(query || '').trim()
  if (q.length < 3) return { data: [], meta: {} }
  const lim = Math.max(1, Math.min(10, Math.floor(Number(limit) || 6)))
  const json = await apiJson(`/geo/search?q=${encodeURIComponent(q.slice(0, 200))}&limit=${lim}`)
  return {
    data: Array.isArray(json && json.data) ? json.data : [],
    meta: (json && json.meta) || {},
  }
}

/**
 * `GET /api/geo/search` — address autocomplete, results only.
 * Drops `meta`, so a caller that needs to distinguish "disabled" from "no
 * matches" must use geoSearchFull() instead.
 * @returns {Promise<Array<{display_name, latitude, longitude, precision, address}>>}
 */
export async function geoSearch(query, limit = 6) {
  const { data } = await geoSearchFull(query, limit)
  return data
}

/**
 * `GET /api/geo/reverse` — coordinates to structured address.
 * @returns {Promise<object|null>} `null` when the geocoder is off or found nothing.
 */
export async function geoReverse(lat, lon) {
  if (!isValidCoords(lat, lon)) return null
  const json = await apiJson(`/geo/reverse?lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`)
  return (json && json.data) || null
}

/**
 * `POST /api/map/route` — service-round planning.
 * The backend answers 200 even with routing disabled, degrading to a
 * nearest-neighbour order with `legs: null` and `meta.optimized: false`.
 * @returns {Promise<{ data: object|null, meta: object }>} — `meta.optimized` /
 *          `meta.provider` decide whether the UI shows the "orientation only" label.
 */
export async function planRoute({ site_ids, start = null, roundtrip = false } = {}) {
  const body = { site_ids: site_ids || [] }
  if (start && isValidCoords(start.lat, start.lon)) {
    body.start = { lat: roundCoord(start.lat), lon: roundCoord(start.lon) }
  }
  if (roundtrip) body.roundtrip = true
  const json = await apiJson('/map/route', { method: 'POST', body: JSON.stringify(body) })
  return { data: (json && json.data) || null, meta: (json && json.meta) || {} }
}
