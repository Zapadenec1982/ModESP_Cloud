'use strict';

/**
 * Geocoding service — provider-agnostic, Nominatim by default.
 *
 * The browser NEVER calls a geocoder directly. Every lookup goes through this
 * module so the whole deployment presents ONE identifying User-Agent, ONE
 * serialized rate limiter and ONE shared cache — exactly what the OSM /
 * Nominatim usage policy requires (max 1 req/s, identifying UA, no bulk
 * geocoding).
 *
 * Contract for callers: nothing here throws and nothing here rejects.
 * A disabled provider, a timeout, an HTTP 5xx, a full queue, even a missing
 * `geocode_cache` table — every one of them degrades to an empty result.
 * Routes can call this without a try/catch and must never 500 because a third
 * party is unset or down.
 *
 * Exports:
 *   isEnabled()                  → boolean             provider configured & supported
 *   isBulkEnabled()              → boolean             GEOCODER_BULK_ENABLED gate (OSM policy)
 *   search(q, opts)              → result[]            forward search, autocomplete
 *   geocode(address, opts)       → result | null       forward geocode of a site address
 *   resolveAddress(address, opts)→ { status, result }  same, with the reason attached
 *   reverse(lat, lon, opts)      → result | null       reverse geocode of a marker drop
 *   init(log) / start(log) / shutdown()                lifecycle (see services/ota.js)
 *   stats()                      → object              queue / cache counters
 *   OUTCOME                      → enum                status values of resolveAddress()
 *
 * A `result` is:
 *   { display_name, latitude, longitude, precision, osm_type, osm_id,
 *     address: { country_code, country, region, city, address_line, postal_code } }
 */

const crypto = require('crypto');
const db     = require('./db');

// ── Configuration ─────────────────────────────────────────

// Only providers we actually speak. An unknown value behaves like 'none':
// better a hidden autocomplete than one that silently never answers.
const SUPPORTED_PROVIDERS = new Set(['nominatim']);

const DEFAULT_URL         = 'https://nominatim.openstreetmap.org';
const DEFAULT_USER_AGENT  = 'ModESP-Cloud/1.0 (+https://modesp.com.ua)';
const DEFAULT_RATE_LIMIT_MS      = 1100;   // OSM policy: max 1 req/s
const DEFAULT_TIMEOUT_MS         = 8000;
const DEFAULT_CACHE_TTL_DAYS     = 180;
const DEFAULT_NEGATIVE_TTL_MIN   = 360;    // 6 h — a no-match is not a 180-day fact
const DEFAULT_LIMIT              = 5;

const MAX_QUERY_CHARS = 200;
const MAX_LIMIT       = 10;
const MAX_QUEUE_DEPTH = 200;               // interactive + bulk combined

// Never let a request handler sit on the queue: nginx `proxy_read_timeout 30s`
// on `location /api/` would turn a long wait into a 504 for an operation that
// has already succeeded. On expiry the caller gets an empty result and the job
// keeps running in the background, warming the cache for the next attempt.
const QUEUE_BUDGET_MS = 5000;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;   // expired-cache eviction

// Ukrainian is the primary language of the platform and a site address is
// stored once, not per UI locale — ask the provider for uk with an en fallback.
const ACCEPT_LANGUAGE = 'uk,en';

// Cache-key rounding for reverse lookups: 5 decimals ≈ 1.1 m, far below the
// precision any hand-dropped marker carries.
const REVERSE_KEY_DECIMALS = 5;

// ── Module state ──────────────────────────────────────────

let logger   = null;
let sweeper  = null;                       // setInterval handle
let stopping = false;

const queues = { interactive: [], bulk: [] };
let pumping        = false;
let lastUpstreamAt = 0;
let pacer          = null;                 // { timer, resolve } — the active rate-limit wait

/** @type {Map<string, Promise<{ status: string, rows: object[] }>>}  cache key → in-flight job (deduplicates concurrent identical lookups) */
const inflight = new Map();

const counters = { refused: 0, upstream: 0, cacheHits: 0, cacheWrites: 0 };

const BUDGET_EXPIRED = Symbol('budget_expired');

// ── Env helpers ───────────────────────────────────────────

// Shared "disabled" sentinel — the same predicate guards weather and routing.
const off = v => {
  const s = (v || '').trim().toLowerCase();
  return s === '' || s === 'none';
};

function providerName() {
  return (process.env.GEOCODER_PROVIDER || '').trim().toLowerCase();
}

function intEnv(name, def) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const rateLimitMs   = () => intEnv('GEOCODER_RATE_LIMIT_MS', DEFAULT_RATE_LIMIT_MS);
const timeoutMs     = () => Math.max(1, intEnv('GEOCODER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));
const cacheTtlDays  = () => intEnv('GEOCODER_CACHE_TTL_DAYS', DEFAULT_CACHE_TTL_DAYS);
const negativeTtlMin = () => intEnv('GEOCODER_NEGATIVE_TTL_MIN', DEFAULT_NEGATIVE_TTL_MIN);

/** Geocoding configured and supported. `GEOCODER_PROVIDER=none` (or empty) disables it entirely. */
function isEnabled() {
  const p = providerName();
  return !off(p) && SUPPORTED_PROVIDERS.has(p);
}

/**
 * Bulk sweeps (CSV import, geocode-pending) are gated separately: the OSM
 * policy bars systematic/bulk querying of the public Nominatim instance
 * regardless of how politely it is paced.
 */
function isBulkEnabled() {
  return isEnabled() && process.env.GEOCODER_BULK_ENABLED === 'true';
}

// ── Logging (logger is optional — the service works before start()) ──

function warn(obj, msg)  { if (logger) logger.warn(obj, msg); }
function info(obj, msg)  { if (logger) logger.info(obj, msg); }
function debug(obj, msg) { if (logger) logger.debug(obj, msg); }

// ── Lifecycle ─────────────────────────────────────────────

/** Pure config gate: attach a logger, start no timers. */
function init(log) {
  if (log) logger = log.child ? log.child({ svc: 'geocode' }) : log;
}

/** Attach the logger and arm the cache sweeper. Safe to call twice. */
function start(log) {
  init(log);
  stopping = false;
  if (!isEnabled()) {
    info({ provider: providerName() || null }, 'Geocoding disabled (GEOCODER_PROVIDER)');
    return;
  }
  armSweeper();
  info(
    { provider: providerName(), rateLimitMs: rateLimitMs(), cacheTtlDays: cacheTtlDays(), bulk: isBulkEnabled() },
    'Geocoding service started'
  );
}

/** Stop the sweeper and release everything still queued (each gets an empty result). */
function shutdown() {
  stopping = true;
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  drainQueues();
  if (pacer) {                      // wake the paced pump so it can exit
    clearTimeout(pacer.timer);
    const resume = pacer.resolve;
    pacer = null;
    resume();
  }
  inflight.clear();
  if (logger) logger.info('Geocoding service stopped');
}

function stats() {
  return {
    enabled:        isEnabled(),
    provider:       providerName() || null,
    queued:         { interactive: queues.interactive.length, bulk: queues.bulk.length, total: queueDepth() },
    max_depth:      MAX_QUEUE_DEPTH,
    refused:        counters.refused,
    upstream_calls: counters.upstream,
    cache_hits:     counters.cacheHits,
    cache_writes:   counters.cacheWrites,
    sweeper_armed:  sweeper !== null,
  };
}

// ── Public API ────────────────────────────────────────────

/**
 * Why a lookup produced no coordinates. Callers that only need the answer use
 * search()/geocode()/reverse(); a site geocode needs the reason too, so it can
 * record `geo_error`, decide whether to bump `geo_attempts`, and tell the UI
 * "geocoder off" apart from "address not found".
 * @readonly
 */
const OUTCOME = {
  OK:       'ok',          // at least one result
  DISABLED: 'disabled',    // GEOCODER_PROVIDER unset / none / unsupported
  NO_MATCH: 'no_match',    // the provider answered, with nothing for this query
  FAILED:   'failed',      // timeout, 4xx/5xx or transport error — retry later
  BUSY:     'busy',        // queue full or the caller's wait budget expired
};

const outcome = (status, rows = []) => ({ status, rows });

/**
 * Forward search — the autocomplete path behind GET /api/geo/search.
 * @param {string} query
 * @param {{ limit?: number, lane?: 'interactive'|'bulk', budgetMs?: number }} [opts]
 * @returns {Promise<object[]>} never rejects; `[]` when disabled, empty or failed
 */
async function search(query, opts = {}) {
  return (await searchDetailed(query, opts)).rows;
}

/**
 * Geocode one site address. Accepts a free-form string or the structured
 * address object from `sites` ({ address_line, city, region, postal_code,
 * country, country_code }).
 * @returns {Promise<object|null>} never rejects; `null` when disabled or unresolved
 */
async function geocode(address, opts = {}) {
  return (await resolveAddress(address, opts)).result;
}

/**
 * Same lookup as geocode(), with the reason attached.
 * @returns {Promise<{ status: string, result: object|null }>} never rejects
 */
async function resolveAddress(address, opts = {}) {
  if (!isEnabled()) return { status: OUTCOME.DISABLED, result: null };

  const q = buildQuery(address);
  if (!q) return { status: OUTCOME.NO_MATCH, result: null };

  const out = await searchDetailed(q, { ...opts, limit: 1 });
  return { status: out.status, result: out.rows[0] || null };
}

/**
 * Reverse geocode a dropped marker.
 * @returns {Promise<object|null>} never rejects; `null` when disabled or unresolved
 */
async function reverse(lat, lon, opts = {}) {
  if (!isEnabled()) return null;

  const la = Number(lat);
  const lo = Number(lon);
  if (!inRange(la, lo)) return null;

  const key = cacheKey(['reverse', la.toFixed(REVERSE_KEY_DECIMALS), lo.toFixed(REVERSE_KEY_DECIMALS)]);
  const out = await lookup(key, () => upstreamReverse(la, lo), opts);
  return out.rows[0] || null;
}

/** @returns {Promise<{ status: string, rows: object[] }>} */
async function searchDetailed(query, opts = {}) {
  if (!isEnabled()) return outcome(OUTCOME.DISABLED);

  const q = clampQuery(query);
  if (!q) return outcome(OUTCOME.NO_MATCH);
  const limit = clampLimit(opts.limit);

  const key = cacheKey(['search', normalizeText(q), String(limit)]);
  return lookup(key, () => upstreamSearch(q, limit), opts);
}

/** Cache first, queue second — a cache hit never touches the rate limiter. */
async function lookup(key, work, opts) {
  const cached = await readCache(key.hash);
  if (cached.hit) {
    return cached.value && cached.value.length
      ? outcome(OUTCOME.OK, cached.value)
      : outcome(OUTCOME.NO_MATCH);
  }
  return runQueued(key, work, opts);
}

// ── Queue: two priority lanes over one serialized pacer ───

/**
 * Interactive work (site create/PATCH, /api/geo/*) always overtakes bulk work
 * (CSV import, geocode-pending) on the single ≥ GEOCODER_RATE_LIMIT_MS pacer.
 */
function queueDepth() {
  return queues.interactive.length + queues.bulk.length;
}

function enqueue(task, lane) {
  if (queueDepth() >= MAX_QUEUE_DEPTH) return null;   // refuse, never grow unbounded
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  queues[lane].push({ task, resolve });
  pump();
  return promise;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = queues.interactive.shift() || queues.bulk.shift();
      if (!job) break;
      if (stopping) { job.resolve(outcome(OUTCOME.BUSY)); continue; }

      const waitMs = rateLimitMs() - (Date.now() - lastUpstreamAt);
      if (waitMs > 0) await pace(waitMs);
      if (stopping) { job.resolve(outcome(OUTCOME.BUSY)); continue; }

      lastUpstreamAt = Date.now();
      let value = outcome(OUTCOME.FAILED);
      try {
        value = await job.task();
      } catch (err) {
        // Tasks are written not to throw; this is the last line of defence so
        // one bad job can never wedge the queue for every other caller.
        warn({ err: err && err.message }, 'Geocoder job failed');
      }
      job.resolve(value || outcome(OUTCOME.FAILED));
    }
  } finally {
    pumping = false;
  }
}

function pace(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { pacer = null; resolve(); }, ms);
    pacer = { timer, resolve };
  });
}

function drainQueues() {
  for (const lane of ['interactive', 'bulk']) {
    while (queues[lane].length) queues[lane].shift().resolve(outcome(OUTCOME.BUSY));
  }
}

/**
 * Run `work` through the queue, deduplicating concurrent identical lookups and
 * capping how long the caller waits.
 * @returns {Promise<{ status: string, rows: object[] }>}
 */
async function runQueued(key, work, opts) {
  const lane = opts.lane === 'bulk' ? 'bulk' : 'interactive';
  // Bulk callers are background workers — they may wait for their turn.
  const laneBudget = lane === 'bulk' ? 0 : QUEUE_BUDGET_MS;
  const asked = Number(opts.budgetMs);
  const budgetMs = Number.isFinite(asked) ? asked : laneBudget;

  let job = inflight.get(key.hash);
  if (!job) {
    job = enqueue(async () => {
      const out = await work();
      if (out.cacheable) await writeCache(key, out.value);
      return outcome(out.status, out.value || []);
    }, lane);

    if (!job) {
      counters.refused++;
      warn({ depth: queueDepth() }, 'Geocoder queue full — request refused');
      return outcome(OUTCOME.BUSY);
    }
    inflight.set(key.hash, job);
    const cleanup = () => { if (inflight.get(key.hash) === job) inflight.delete(key.hash); };
    job.then(cleanup, cleanup);
  }

  const result = await raceBudget(job, budgetMs);
  if (result === BUDGET_EXPIRED) {
    debug({ query: key.text }, 'Geocoder budget expired — job continues in background');
    return outcome(OUTCOME.BUSY);
  }
  return result || outcome(OUTCOME.FAILED);
}

async function raceBudget(promise, budgetMs) {
  if (!budgetMs || budgetMs <= 0) return promise;
  let timer = null;
  const budget = new Promise(resolve => { timer = setTimeout(() => resolve(BUDGET_EXPIRED), budgetMs); });
  try {
    return await Promise.race([promise, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Cache (geocode_cache) ─────────────────────────────────
//
// The table is deliberately global — the key is a normalized public address
// string and the value is a public OSM response, so nothing tenant-derived is
// stored. `expires_at` splits the two lifetimes: a real answer lives for
// GEOCODER_CACHE_TTL_DAYS, a "no match" only for GEOCODER_NEGATIVE_TTL_MIN.

const SQL_CACHE_GET = `
  SELECT result
    FROM geocode_cache
   WHERE query_hash = $1
     AND expires_at > NOW()`;

// params: [query_hash, query_text, provider, result_json|null, ttl_seconds]
const SQL_CACHE_PUT = `
  INSERT INTO geocode_cache (query_hash, query_text, provider, result, expires_at)
  VALUES ($1, $2, $3, $4::jsonb, NOW() + ($5::text || ' seconds')::interval)
  ON CONFLICT (query_hash) DO UPDATE
     SET query_text = EXCLUDED.query_text,
         provider   = EXCLUDED.provider,
         result     = EXCLUDED.result,
         created_at = NOW(),
         expires_at = EXCLUDED.expires_at`;

const SQL_CACHE_EVICT = `DELETE FROM geocode_cache WHERE expires_at < NOW()`;

function cacheKey(parts) {
  const text = [providerName(), ...parts].join('|');
  return { text, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

/**
 * @returns {Promise<{ hit: boolean, value?: object[]|null }>}
 *          `hit:false` = miss, `value:null` = negative cache entry.
 */
async function readCache(hash) {
  try {
    const { rows } = await db.query(SQL_CACHE_GET, [hash]);
    if (rows.length === 0) return { hit: false };
    counters.cacheHits++;
    const value = rows[0].result;
    return { hit: true, value: Array.isArray(value) ? value : null };
  } catch (err) {
    // A missing table or a DB hiccup must not stop geocoding.
    warn({ err: err && err.message }, 'Geocode cache read failed');
    return { hit: false };
  }
}

/**
 * Only a successful HTTP 200 from the provider reaches this function —
 * a timeout, a 429, a 5xx or a transport error writes NOTHING, so one upstream
 * blip can never make an address un-geocodable for the next 180 days.
 * @param {object[]|null} value  null = the provider answered, with no match
 */
async function writeCache(key, value) {
  const seconds = value ? cacheTtlDays() * 86400 : negativeTtlMin() * 60;
  try {
    await db.query(SQL_CACHE_PUT, [
      key.hash,
      key.text.slice(0, 512),
      providerName(),
      value ? JSON.stringify(value) : null,
      String(seconds),
    ]);
    counters.cacheWrites++;
    armSweeper();
  } catch (err) {
    warn({ err: err && err.message }, 'Geocode cache write failed');
  }
}

/**
 * Without eviction the table only grows and /api/geo/search becomes an
 * authenticated disk-fill primitive. Armed by start() and, defensively, by the
 * first cache write — unref'd so it never holds a script or a test open.
 */
function armSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => { sweepCache(); }, SWEEP_INTERVAL_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

async function sweepCache() {
  try {
    const res = await db.query(SQL_CACHE_EVICT);
    if (res.rowCount) debug({ removed: res.rowCount }, 'Geocode cache swept');
  } catch (err) {
    warn({ err: err && err.message }, 'Geocode cache sweep failed');
  }
}

// ── Upstream (Nominatim) ──────────────────────────────────

/**
 * @returns {Promise<{ ok: boolean, body?: any, reason?: string }>} never rejects
 */
async function fetchProvider(path, params) {
  if (typeof globalThis.fetch !== 'function') return { ok: false, reason: 'no_fetch' };

  const base = (process.env.GEOCODER_URL || DEFAULT_URL).trim() || DEFAULT_URL;
  let url;
  try {
    // Always build with the URL API — never template concatenation.
    url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  } catch {
    warn({ base }, 'Invalid GEOCODER_URL');
    return { ok: false, reason: 'bad_url' };
  }

  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', ACCEPT_LANGUAGE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const email = (process.env.GEOCODER_EMAIL || '').trim();
  if (email) url.searchParams.set('email', email);   // Nominatim identification

  const headers = {
    // Nominatim rejects anonymous clients: the UA must identify this deployment.
    'User-Agent': (process.env.GEOCODER_USER_AGENT || '').trim() || DEFAULT_USER_AGENT,
    'Accept':     'application/json',
  };

  counters.upstream++;
  try {
    const res = await globalThis.fetch(url, {
      method:   'GET',
      headers,
      redirect: 'follow',
      signal:   AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) {
      warn({ status: res.status, path }, 'Geocoder returned a non-2xx response');
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    warn({ err: err && err.message, path }, aborted ? 'Geocoder request timed out' : 'Geocoder request failed');
    return { ok: false, reason: aborted ? 'timeout' : 'transport' };
  }
}

/**
 * @returns {Promise<{ cacheable: boolean, status: string, value: object[]|null }>}
 *          `cacheable:false` = upstream failure, write nothing;
 *          `value:null`      = the provider answered with no match.
 */
async function upstreamSearch(q, limit) {
  const res = await fetchProvider('search', { q, limit: String(limit) });
  if (!res.ok) return { cacheable: false, status: OUTCOME.FAILED, value: [] };

  if (!Array.isArray(res.body)) {
    warn({ provider: providerName() }, 'Geocoder search returned an unexpected body');
    return { cacheable: false, status: OUTCOME.FAILED, value: [] };
  }

  const mapped = res.body.map(mapResult).filter(Boolean).slice(0, limit);
  return mapped.length
    ? { cacheable: true, status: OUTCOME.OK,       value: mapped }
    : { cacheable: true, status: OUTCOME.NO_MATCH, value: null };
}

async function upstreamReverse(lat, lon) {
  const res = await fetchProvider('reverse', {
    lat:  lat.toFixed(6),
    lon:  lon.toFixed(6),
    zoom: '18',        // building level — the finest Nominatim resolves
  });
  if (!res.ok) return { cacheable: false, status: OUTCOME.FAILED, value: [] };

  const body = res.body;
  // Nominatim answers a genuine miss with HTTP 200 + { error: 'Unable to geocode' }.
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.error) {
    return { cacheable: true, status: OUTCOME.NO_MATCH, value: null };
  }

  const one = mapResult(body);
  return one
    ? { cacheable: true, status: OUTCOME.OK,       value: [one] }
    : { cacheable: true, status: OUTCOME.NO_MATCH, value: null };
}

// ── Mapping ───────────────────────────────────────────────

function str(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * Nominatim address components → the `sites` columns.
 * For Ukraine: state = «Київська область», city/town/village = населений пункт,
 * road + house_number = «вулиця Незалежності, 12».
 */
function mapAddress(a) {
  const cc = typeof a.country_code === 'string' ? a.country_code.trim().toUpperCase() : null;
  return {
    country_code: cc && cc.length === 2 ? cc : null,
    country:      str(a.country),
    // state first — that is the Ukrainian «область». The rest cover countries
    // that use a different top-level division name.
    region:       str(a.state) || str(a.region) || str(a.province)
                  || str(a.state_district) || str(a.county),
    city:         str(a.city) || str(a.town) || str(a.village)
                  || str(a.municipality) || str(a.hamlet),
    address_line: buildAddressLine(a),
    postal_code:  str(a.postcode),
  };
}

function roadOf(a) {
  return str(a.road) || str(a.pedestrian) || str(a.footway) || str(a.residential) || str(a.path);
}

function buildAddressLine(a) {
  const road  = roadOf(a);
  const house = str(a.house_number);
  if (!road) return null;
  return house ? `${road}, ${house}` : road;   // UA convention: street, then number
}

/** Finest-to-coarsest cascade; the values match sites.geo_precision. */
function precisionOf(a) {
  if (str(a.house_number)) return 'house';
  if (roadOf(a))           return 'street';
  if (str(a.city) || str(a.town) || str(a.village) || str(a.municipality) || str(a.hamlet)) return 'city';
  if (str(a.state) || str(a.region) || str(a.province) || str(a.state_district) || str(a.county)) return 'region';
  if (str(a.country))      return 'country';
  return null;
}

function mapResult(item) {
  if (!item || typeof item !== 'object') return null;

  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!inRange(lat, lon)) return null;

  const a = (item.address && typeof item.address === 'object') ? item.address : {};
  const osmId = Number(item.osm_id);

  return {
    display_name: str(item.display_name),
    latitude:     lat,
    longitude:    lon,
    precision:    precisionOf(a),
    osm_type:     (str(item.osm_type) || '').slice(0, 16) || null,   // sites.osm_type is VARCHAR(16)
    osm_id:       Number.isFinite(osmId) ? osmId : null,
    address:      mapAddress(a),
  };
}

// ── Input hygiene ─────────────────────────────────────────

function inRange(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function normalizeText(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function clampQuery(query) {
  return String(query == null ? '' : query).trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS);
}

function clampLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return DEFAULT_LIMIT;
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * Structured address → one free-form query. Nominatim resolves partial
 * Ukrainian addresses better free-form than through its structured parameters,
 * and one query shape means one cache key for both call paths.
 */
function buildQuery(address) {
  if (typeof address === 'string') return clampQuery(address);
  if (!address || typeof address !== 'object') return '';

  const country = str(address.country) || str(address.country_code);
  const parts = [
    str(address.address_line),
    str(address.city),
    str(address.region),
    str(address.postal_code),
    country,
  ].filter(Boolean);

  // A site with nothing but a name ("АТБ №142") is still worth one attempt.
  if (parts.length === 0) {
    const name = str(address.name);
    if (name) parts.push(name);
  }
  return clampQuery(parts.join(', '));
}

module.exports = {
  isEnabled,
  isBulkEnabled,
  search,
  geocode,
  resolveAddress,
  reverse,
  init,
  start,
  shutdown,
  stats,
  OUTCOME,
};
