'use strict';

// globals: true in vitest.config.js
//
// Pure unit test for services/geocode.js: no network and no database.
//   - global.fetch is replaced with a recorder, so nothing ever reaches
//     Nominatim (the OSM policy forbids automated hammering, and a test that
//     depends on a third party is a flaky test);
//   - db.query is replaced on the shared service singleton with an in-memory
//     geocode_cache. That is the same property-swap convention the repo uses
//     to stub services in test/helpers/app.js, and it keeps this file
//     independent of migration 021 having been applied.

const db      = require('../src/services/db');
const geocode = require('../src/services/geocode');

const realFetch = global.fetch;
const realQuery = db.query;

// ── In-memory geocode_cache ───────────────────────────────

/** @type {Map<string, { text: string, provider: string, result: object[]|null, expiresAt: number, ttlSeconds: number }>} */
const cache = new Map();
/** @type {{ sql: string, params: any[] }[]} */
const dbCalls = [];

function installFakeDb() {
  db.query = async (sql, params = []) => {
    dbCalls.push({ sql, params });

    if (/INSERT INTO geocode_cache/.test(sql)) {
      const [hash, text, provider, result, seconds] = params;
      cache.set(hash, {
        text,
        provider,
        result: result === null ? null : JSON.parse(result),
        expiresAt: Date.now() + Number(seconds) * 1000,
        ttlSeconds: Number(seconds),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM geocode_cache/.test(sql)) {
      const row = cache.get(params[0]);
      if (!row || row.expiresAt <= Date.now()) return { rows: [], rowCount: 0 };
      return { rows: [{ result: row.result }], rowCount: 1 };
    }
    if (/DELETE FROM geocode_cache/.test(sql)) {
      let n = 0;
      for (const [k, v] of cache) if (v.expiresAt <= Date.now()) { cache.delete(k); n++; }
      return { rows: [], rowCount: n };
    }
    throw new Error(`unexpected SQL in geocode test: ${sql}`);
  };
}

const cacheWrites = () => dbCalls.filter(c => /INSERT INTO geocode_cache/.test(c.sql));

// ── Fetch recorder ────────────────────────────────────────

/** @type {{ url: URL, init: object, at: number }[]} */
let fetchCalls = [];
let fetchImpl = () => { throw new Error('no fetch stub installed'); };

function installFetch(impl) { fetchImpl = impl; }

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

global.fetch = async (url, init) => {
  fetchCalls.push({ url: new URL(url), init, at: Date.now() });
  return fetchImpl(new URL(url), init);
};

// ── Fixtures (real Nominatim jsonv2 shapes) ───────────────

const BROVARY = {
  place_id: 101,
  osm_type: 'way',
  osm_id: 123456789,
  lat: '50.5109',
  lon: '30.7900',
  display_name: 'вулиця Незалежності, 12, Бровари, Броварський район, Київська область, 07400, Україна',
  address: {
    house_number: '12',
    road:         'вулиця Незалежності',
    city:         'Бровари',
    county:       'Броварський район',
    state:        'Київська область',
    postcode:     '07400',
    country:      'Україна',
    country_code: 'ua',
  },
};

const TOWN_ONLY = {
  osm_type: 'node', osm_id: 22, lat: '49.2331', lon: '28.4682',
  display_name: 'Немирів, Вінницька область, Україна',
  address: { road: 'вулиця Соборна', town: 'Немирів', state: 'Вінницька область', country: 'Україна', country_code: 'ua' },
};

const VILLAGE_ONLY = {
  osm_type: 'node', osm_id: 33, lat: '48.9226', lon: '24.7111',
  display_name: 'Ямниця, Івано-Франківська область, Україна',
  address: { village: 'Ямниця', state: 'Івано-Франківська область', country: 'Україна', country_code: 'ua' },
};

const REGION_ONLY = {
  osm_type: 'relation', osm_id: 44, lat: '49.8397', lon: '24.0297',
  display_name: 'Львівська область, Україна',
  address: { state: 'Львівська область', country: 'Україна', country_code: 'ua' },
};

const COUNTRY_ONLY = {
  osm_type: 'relation', osm_id: 55, lat: '49.0', lon: '32.0',
  display_name: 'Україна',
  address: { country: 'Україна', country_code: 'ua' },
};

// ── Suite ─────────────────────────────────────────────────

describe('Geocoding service', () => {
  beforeAll(() => {
    installFakeDb();
  });

  afterAll(() => {
    geocode.shutdown();
    global.fetch = realFetch;
    db.query = realQuery;
  });

  beforeEach(() => {
    process.env.GEOCODER_PROVIDER         = 'nominatim';
    process.env.GEOCODER_URL              = 'https://nominatim.example.test';
    process.env.GEOCODER_USER_AGENT       = 'ModESP-Cloud/1.0 (test@example.test)';
    process.env.GEOCODER_EMAIL            = 'test@example.test';
    process.env.GEOCODER_RATE_LIMIT_MS    = '40';
    process.env.GEOCODER_CACHE_TTL_DAYS   = '180';
    process.env.GEOCODER_NEGATIVE_TTL_MIN = '360';
    process.env.GEOCODER_TIMEOUT_MS       = '8000';
    process.env.GEOCODER_BULK_ENABLED     = 'false';

    cache.clear();
    dbCalls.length = 0;
    fetchCalls = [];
    installFakeDb();
    installFetch(() => jsonResponse([BROVARY]));
    geocode.start(null);           // clears the `stopping` flag between tests
  });

  afterEach(() => {
    geocode.shutdown();
  });

  // ── Disabled provider ───────────────────────────────────

  it('short-circuits entirely when GEOCODER_PROVIDER=none', async () => {
    process.env.GEOCODER_PROVIDER = 'none';

    expect(geocode.isEnabled()).toBe(false);
    await expect(geocode.search('Бровари')).resolves.toEqual([]);
    await expect(geocode.geocode({ city: 'Бровари', country: 'Україна' })).resolves.toBeNull();
    await expect(geocode.reverse(50.5109, 30.79)).resolves.toBeNull();

    expect(fetchCalls).toHaveLength(0);
    expect(dbCalls).toHaveLength(0);
  });

  it('treats an empty or unsupported provider as disabled', async () => {
    process.env.GEOCODER_PROVIDER = '';
    expect(geocode.isEnabled()).toBe(false);

    process.env.GEOCODER_PROVIDER = '   ';
    expect(geocode.isEnabled()).toBe(false);

    process.env.GEOCODER_PROVIDER = 'some-provider-we-do-not-speak';
    expect(geocode.isEnabled()).toBe(false);
    await expect(geocode.search('Бровари')).resolves.toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('gates bulk sweeps behind GEOCODER_BULK_ENABLED', () => {
    expect(geocode.isBulkEnabled()).toBe(false);

    process.env.GEOCODER_BULK_ENABLED = 'true';
    expect(geocode.isBulkEnabled()).toBe(true);

    // Disabling the provider disables bulk too, whatever the flag says.
    process.env.GEOCODER_PROVIDER = 'none';
    expect(geocode.isBulkEnabled()).toBe(false);
  });

  // ── Address mapping ─────────────────────────────────────

  it('maps Nominatim components onto the site address fields', async () => {
    const hit = await geocode.geocode({
      address_line: 'вулиця Незалежності, 12',
      city:         'Бровари',
      region:       'Київська область',
      postal_code:  '07400',
      country:      'Україна',
    });

    expect(hit).not.toBeNull();
    expect(hit.latitude).toBe(50.5109);
    expect(hit.longitude).toBe(30.79);
    expect(hit.precision).toBe('house');
    expect(hit.osm_type).toBe('way');
    expect(hit.osm_id).toBe(123456789);
    expect(hit.display_name).toBe(BROVARY.display_name);
    expect(hit.address).toEqual({
      country_code: 'UA',                    // uppercased ISO 3166-1 alpha-2
      country:      'Україна',
      region:       'Київська область',      // state → region, not county
      city:         'Бровари',
      address_line: 'вулиця Незалежності, 12',
      postal_code:  '07400',
    });
  });

  it('falls back city → town → village and derives geo_precision', async () => {
    installFetch(() => jsonResponse([TOWN_ONLY]));
    const town = await geocode.geocode('Немирів');
    expect(town.address.city).toBe('Немирів');
    expect(town.address.address_line).toBe('вулиця Соборна');   // road without house_number
    expect(town.precision).toBe('street');

    installFetch(() => jsonResponse([VILLAGE_ONLY]));
    const village = await geocode.geocode('Ямниця');
    expect(village.address.city).toBe('Ямниця');
    expect(village.address.address_line).toBeNull();
    expect(village.precision).toBe('city');

    installFetch(() => jsonResponse([REGION_ONLY]));
    const region = await geocode.geocode('Львівська область');
    expect(region.address.city).toBeNull();
    expect(region.address.region).toBe('Львівська область');
    expect(region.precision).toBe('region');

    installFetch(() => jsonResponse([COUNTRY_ONLY]));
    const country = await geocode.geocode('Україна');
    expect(country.address.region).toBeNull();
    expect(country.precision).toBe('country');
  });

  it('drops results with unusable coordinates instead of storing NaN', async () => {
    installFetch(() => jsonResponse([
      { osm_type: 'node', osm_id: 1, lat: 'not-a-number', lon: '30.0', address: { country: 'Україна' } },
      { osm_type: 'node', osm_id: 2, lat: '91.5', lon: '30.0', address: { country: 'Україна' } },
      BROVARY,
    ]));

    const rows = await geocode.search('змішана відповідь');
    expect(rows).toHaveLength(1);
    expect(rows[0].osm_id).toBe(123456789);
  });

  it('builds the upstream query from the structured address fields', async () => {
    await geocode.geocode({
      address_line: 'вулиця Незалежності, 12',
      city:         'Бровари',
      region:       'Київська область',
      postal_code:  '07400',
      country_code: 'UA',                    // used when `country` is absent
    });

    expect(fetchCalls[0].url.searchParams.get('q'))
      .toBe('вулиця Незалежності, 12, Бровари, Київська область, 07400, UA');
    expect(fetchCalls[0].url.searchParams.get('limit')).toBe('1');
  });

  // ── Outcome reporting (POST /api/sites/:id/geocode meta) ──

  it('reports why a site geocode produced nothing', async () => {
    const { OUTCOME } = geocode;

    process.env.GEOCODER_PROVIDER = 'none';
    expect(await geocode.resolveAddress('Бровари')).toEqual({ status: OUTCOME.DISABLED, result: null });

    process.env.GEOCODER_PROVIDER = 'nominatim';
    installFetch(() => jsonResponse([BROVARY]));
    const ok = await geocode.resolveAddress('Бровари');
    expect(ok.status).toBe(OUTCOME.OK);
    expect(ok.result.address.city).toBe('Бровари');

    installFetch(() => jsonResponse([]));
    expect(await geocode.resolveAddress('вулиця Неіснуюча 42'))
      .toEqual({ status: OUTCOME.NO_MATCH, result: null });

    installFetch(() => jsonResponse({ error: 'boom' }, 500));
    expect(await geocode.resolveAddress('Тернопіль'))
      .toEqual({ status: OUTCOME.FAILED, result: null });

    // A negative cache entry still reads back as "no match", not as a failure —
    // routes/sites.js must not bump geo_attempts for a settled answer.
    installFetch(() => { throw new Error('must not be called'); });
    expect(await geocode.resolveAddress('вулиця Неіснуюча 42'))
      .toEqual({ status: OUTCOME.NO_MATCH, result: null });
  });

  it('reports a refused queue as busy, not as a failure', async () => {
    process.env.GEOCODER_RATE_LIMIT_MS = '5000';
    installFetch(() => jsonResponse([BROVARY]));

    const pending = [];
    for (let i = 0; i < 215; i++) pending.push(geocode.resolveAddress(`вулиця ${i}`, { budgetMs: 0 }));
    await new Promise(r => setTimeout(r, 30));

    geocode.shutdown();
    const settled = await Promise.all(pending);
    expect(settled.every(s => s.status === geocode.OUTCOME.BUSY || s.status === geocode.OUTCOME.OK)).toBe(true);
    expect(settled.some(s => s.status === geocode.OUTCOME.BUSY)).toBe(true);
    expect(settled.every(s => s.result === null || typeof s.result === 'object')).toBe(true);
  });

  it('returns null for an address with nothing to search on', async () => {
    await expect(geocode.geocode({})).resolves.toBeNull();
    await expect(geocode.geocode('   ')).resolves.toBeNull();
    await expect(geocode.geocode(null)).resolves.toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  // ── Upstream request hygiene ────────────────────────────

  it('sends an identifying User-Agent and a URL built with the URL API', async () => {
    await geocode.search('Бровари');

    const { url, init } = fetchCalls[0];
    expect(`${url.origin}${url.pathname}`).toBe('https://nominatim.example.test/search');
    expect(url.searchParams.get('q')).toBe('Бровари');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('addressdetails')).toBe('1');
    expect(url.searchParams.get('accept-language')).toBe('uk,en');
    expect(url.searchParams.get('email')).toBe('test@example.test');

    expect(init.headers['User-Agent']).toBe('ModESP-Cloud/1.0 (test@example.test)');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.signal).toBeDefined();
    expect(typeof init.signal.aborted).toBe('boolean');   // AbortSignal.timeout(GEOCODER_TIMEOUT_MS)
  });

  it('clamps the query to 200 chars and the limit to 1..10', async () => {
    await geocode.search('д'.repeat(500), { limit: 999 });
    expect(fetchCalls[0].url.searchParams.get('q')).toHaveLength(200);
    expect(fetchCalls[0].url.searchParams.get('limit')).toBe('10');

    await geocode.search('інша адреса', { limit: 0 });
    expect(fetchCalls[1].url.searchParams.get('limit')).toBe('1');

    await geocode.search('ще одна адреса');
    expect(fetchCalls[2].url.searchParams.get('limit')).toBe('5');   // default
  });

  // ── Cache ───────────────────────────────────────────────

  it('serves a repeated query from the cache without a second upstream call', async () => {
    const first  = await geocode.search('Бровари, Київська область');
    const second = await geocode.search('  бровари,   КИЇВСЬКА    область  ');   // same normalized key

    expect(fetchCalls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second[0].address.city).toBe('Бровари');

    const put = cacheWrites();
    expect(put).toHaveLength(1);
    expect(Number(put[0].params[4])).toBe(180 * 86400);   // GEOCODER_CACHE_TTL_DAYS
  });

  it('keys the cache per limit so a wider search is not served a narrow result', async () => {
    await geocode.search('Київ', { limit: 1 });
    await geocode.search('Київ', { limit: 5 });
    expect(fetchCalls).toHaveLength(2);
  });

  it('caches a genuine no-match negatively, with a short TTL', async () => {
    installFetch(() => jsonResponse([]));

    await expect(geocode.geocode('вулиця Неіснуюча 999, Бровари')).resolves.toBeNull();

    const put = cacheWrites();
    expect(put).toHaveLength(1);
    expect(put[0].params[3]).toBeNull();                       // result = SQL NULL
    expect(Number(put[0].params[4])).toBe(360 * 60);           // GEOCODER_NEGATIVE_TTL_MIN, not 180 days

    await expect(geocode.geocode('вулиця Неіснуюча 999, Бровари')).resolves.toBeNull();
    expect(fetchCalls).toHaveLength(1);                        // the negative entry was reused
  });

  it('never caches an upstream failure', async () => {
    installFetch(() => jsonResponse({ error: 'rate limited' }, 429));
    await expect(geocode.search('Львів')).resolves.toEqual([]);

    installFetch(() => jsonResponse('service unavailable', 503));
    await expect(geocode.search('Одеса')).resolves.toEqual([]);

    installFetch(() => { throw new Error('ECONNRESET'); });
    await expect(geocode.search('Харків')).resolves.toEqual([]);

    installFetch(() => jsonResponse({ unexpected: 'shape' }));   // 200 but not an array
    await expect(geocode.search('Дніпро')).resolves.toEqual([]);

    expect(fetchCalls).toHaveLength(4);
    expect(cacheWrites()).toHaveLength(0);

    // A later success for the same address must still be possible.
    installFetch(() => jsonResponse([BROVARY]));
    const retry = await geocode.search('Львів');
    expect(retry).toHaveLength(1);
  });

  it('keeps geocoding when the cache table is unavailable', async () => {
    db.query = async () => { throw new Error('relation "geocode_cache" does not exist'); };

    const hit = await geocode.geocode('Бровари');
    expect(hit).not.toBeNull();
    expect(hit.address.city).toBe('Бровари');
  });

  it('collapses concurrent identical lookups into one upstream call', async () => {
    installFetch(async () => {
      await new Promise(r => setTimeout(r, 10));
      return jsonResponse([BROVARY]);
    });

    const [a, b, c] = await Promise.all([
      geocode.search('Бровари'),
      geocode.search('бровари'),
      geocode.search('Бровари '),
    ]);

    expect(fetchCalls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  // ── Queue ───────────────────────────────────────────────

  it('serializes upstream calls at >= GEOCODER_RATE_LIMIT_MS', async () => {
    process.env.GEOCODER_RATE_LIMIT_MS = '60';

    let concurrent = 0;
    let maxConcurrent = 0;
    const starts = [];

    installFetch(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      starts.push(Date.now());
      await new Promise(r => setTimeout(r, 5));
      concurrent--;
      return jsonResponse([BROVARY]);
    });

    await Promise.all([
      geocode.search('перша адреса'),
      geocode.search('друга адреса'),
      geocode.search('третя адреса'),
    ]);

    expect(fetchCalls).toHaveLength(3);
    expect(maxConcurrent).toBe(1);                       // never two requests in flight
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(50);
    }
  });

  it('serves the interactive lane before the bulk lane', async () => {
    process.env.GEOCODER_RATE_LIMIT_MS = '30';
    const seen = [];
    installFetch(async (url) => {
      seen.push(url.searchParams.get('q'));
      return jsonResponse([BROVARY]);
    });

    // The first job is dequeued immediately; everything after it queues up.
    const jobs = [
      geocode.search('нульова', { lane: 'bulk' }),
      geocode.search('масова-1', { lane: 'bulk' }),
      geocode.search('масова-2', { lane: 'bulk' }),
      geocode.search('інтерактивна', { lane: 'interactive' }),
    ];
    await Promise.all(jobs);

    expect(seen[0]).toBe('нульова');
    expect(seen[1]).toBe('інтерактивна');               // overtook both bulk jobs
    expect(seen.slice(2).sort()).toEqual(['масова-1', 'масова-2']);
  });

  it('refuses new work when the queue is full instead of growing unbounded', async () => {
    process.env.GEOCODER_RATE_LIMIT_MS = '5000';        // stall the pacer
    const before = geocode.stats().refused;

    // budgetMs: 0 — these resolve only when the queue drains or shutdown runs.
    const pending = [];
    for (let i = 0; i < 215; i++) pending.push(geocode.search(`адреса-${i}`, { budgetMs: 0 }));

    await new Promise(r => setTimeout(r, 30));

    const s = geocode.stats();
    expect(s.queued.total).toBeLessThanOrEqual(s.max_depth);
    expect(s.refused - before).toBeGreaterThanOrEqual(10);
    expect(fetchCalls.length).toBeLessThanOrEqual(2);   // the pacer let at most one through

    geocode.shutdown();                                 // releases everything still queued
    const results = await Promise.all(pending);
    expect(results.every(Array.isArray)).toBe(true);
  });

  it('gives up on the queue after the budget and lets the job warm the cache', async () => {
    process.env.GEOCODER_RATE_LIMIT_MS = '120';

    installFetch(async () => jsonResponse([BROVARY]));

    // First job occupies the pacer; the second waits ~120 ms for its turn but
    // is only allowed a 20 ms budget, so it answers empty straight away.
    const first  = geocode.search('перша');
    const second = geocode.search('друга', { budgetMs: 20 });

    await expect(second).resolves.toEqual([]);
    await first;

    // The abandoned job still ran and cached its answer, so the retry is free.
    await new Promise(r => setTimeout(r, 200));
    const before = fetchCalls.length;
    const retry = await geocode.search('друга');
    expect(retry).toHaveLength(1);
    expect(fetchCalls).toHaveLength(before);
  });

  // ── Reverse ─────────────────────────────────────────────

  it('reverse-geocodes and caches by rounded coordinates', async () => {
    installFetch(() => jsonResponse(BROVARY));          // /reverse answers a single object

    const hit = await geocode.reverse(50.51089, 30.79004);
    expect(hit.address.city).toBe('Бровари');
    expect(hit.address.region).toBe('Київська область');
    expect(hit.precision).toBe('house');

    expect(fetchCalls[0].url.pathname).toBe('/reverse');
    expect(fetchCalls[0].url.searchParams.get('lat')).toBe('50.510890');
    expect(fetchCalls[0].url.searchParams.get('lon')).toBe('30.790040');

    // A sub-metre nudge lands on the same cache key.
    const again = await geocode.reverse(50.5108903, 30.7900412);
    expect(again.address.city).toBe('Бровари');
    expect(fetchCalls).toHaveLength(1);
  });

  it('treats a Nominatim reverse error body as a cacheable no-match', async () => {
    installFetch(() => jsonResponse({ error: 'Unable to geocode' }));

    await expect(geocode.reverse(0, 0)).resolves.toBeNull();

    const put = cacheWrites();
    expect(put).toHaveLength(1);
    expect(put[0].params[3]).toBeNull();
    expect(Number(put[0].params[4])).toBe(360 * 60);

    await expect(geocode.reverse(0, 0)).resolves.toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });

  it('rejects out-of-range coordinates without touching the provider', async () => {
    await expect(geocode.reverse(91, 0)).resolves.toBeNull();
    await expect(geocode.reverse(-91, 0)).resolves.toBeNull();
    await expect(geocode.reverse(0, 181)).resolves.toBeNull();
    await expect(geocode.reverse(0, -181)).resolves.toBeNull();
    await expect(geocode.reverse('не число', 0)).resolves.toBeNull();
    await expect(geocode.reverse(undefined, undefined)).resolves.toBeNull();

    expect(fetchCalls).toHaveLength(0);
    expect(dbCalls).toHaveLength(0);
  });
});
