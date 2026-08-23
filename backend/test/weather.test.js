'use strict';

// globals: true in vitest.config.js
//
// Pure unit test: `fetch` and `db.query` are both replaced, so this file touches
// neither the network nor Postgres. It deliberately does NOT require
// helpers/setup.js — nothing here needs a database.

const pino    = require('pino');
const db      = require('../src/services/db');
const weather = require('../src/services/weather');

const silent = pino({ level: 'silent' });

const ENV_KEYS = [
  'WEATHER_PROVIDER', 'WEATHER_URL', 'WEATHER_CACHE_TTL_MIN',
  'WEATHER_POLL_INTERVAL_MIN', 'WEATHER_TIMEOUT_MS',
];

// Open-Meteo is queried with timeformat=unixtime, so `time` is epoch seconds.
const T        = 1700000000;                  // 2023-11-14T22:13:20Z
const HOUR_ISO = '2023-11-14T22:00:00.000Z';  // ...floored to the top of the hour

let envBackup;
let realFetch;
let realQuery;

/** One Open-Meteo location entry with a `current` block. */
function omEntry(overrides = {}) {
  return {
    latitude: 50.45,
    longitude: 30.52,
    timezone: 'Europe/Kyiv',
    utc_offset_seconds: 7200,
    current: {
      time: T,
      temperature_2m: -3.5,
      relative_humidity_2m: 81.4,
      surface_pressure: 1004.6,
      wind_speed_10m: 3.2,
      weather_code: 3,
    },
    ...overrides,
  };
}

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function enableWeather() {
  process.env.WEATHER_PROVIDER = 'open-meteo';
  process.env.WEATHER_URL      = 'https://weather.test/v1';
}

/** All fetch calls, as URL objects. */
function fetchedUrls() {
  return global.fetch.mock.calls.map(c => new URL(String(c[0])));
}

/** The db.query calls whose SQL matches. */
function queriesMatching(re) {
  return db.query.mock.calls.filter(c => re.test(c[0]));
}

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }

  realFetch  = global.fetch;
  realQuery  = db.query;
  global.fetch = vi.fn(async () => okJson(omEntry()));
  db.query     = vi.fn(async () => ({ rows: [] }));

  weather.clearCache();
  weather.init(silent);
});

afterEach(() => {
  weather.shutdown();
  vi.useRealTimers();
  global.fetch = realFetch;
  db.query     = realQuery;
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('weather: disabled by default', () => {
  it('is disabled for an empty or "none" provider', () => {
    expect(weather.isEnabled()).toBe(false);          // WEATHER_PROVIDER deleted
    process.env.WEATHER_PROVIDER = '   ';
    expect(weather.isEnabled()).toBe(false);
    process.env.WEATHER_PROVIDER = 'None';
    expect(weather.isEnabled()).toBe(false);
    process.env.WEATHER_PROVIDER = 'open-meteo';
    expect(weather.isEnabled()).toBe(true);
  });

  it('answers null without touching the network', async () => {
    expect(await weather.current(50.45, 30.52)).toBeNull();
    expect(await weather.forecast(50.45, 30.52, 24)).toBeNull();
    expect(await weather.siteWeather(50.45, 30.52)).toBeNull();
    expect(await weather.timezoneFor(50.45, 30.52)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('start() schedules no poller', () => {
    vi.useFakeTimers();
    weather.start(silent);
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);       // three hours
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pollOnce() is a no-op', async () => {
    const res = await weather.pollOnce();
    expect(res.skipped).toBe('disabled');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('weather: current()', () => {
  beforeEach(enableWeather);

  it('maps the Open-Meteo payload and floors observed_at to the hour', async () => {
    const cur = await weather.current(50.4501, 30.5234);

    expect(cur).toEqual({
      observed_at:  HOUR_ISO,
      temp_c:       -3.5,
      humidity:     81,
      pressure_hpa: 1004.6,
      wind_ms:      3.2,
      weather_code: 3,
      timezone:     'Europe/Kyiv',
    });

    const url = fetchedUrls()[0];
    expect(url.origin + url.pathname).toBe('https://weather.test/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('50.45');    // rounded to the grid
    expect(url.searchParams.get('longitude')).toBe('30.52');
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
  });

  it('serves nearby coordinates from one cached request', async () => {
    const a = await weather.current(50.4501, 30.5234);
    const b = await weather.current(50.4499, 30.5236);        // same rounded cell

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('still fetches for a different rounded cell', async () => {
    await weather.current(50.45, 30.52);
    await weather.current(49.84, 24.03);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches once the TTL has passed', async () => {
    process.env.WEATHER_CACHE_TTL_MIN = '30';
    vi.useFakeTimers();

    await weather.current(50.45, 30.52);
    vi.advanceTimersByTime(29 * 60 * 1000);
    await weather.current(50.45, 30.52);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 1000);                    // now 31 min old
    await weather.current(50.45, 30.52);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns null instead of throwing when the provider fails', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    await expect(weather.current(50.45, 30.52)).resolves.toBeNull();

    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(weather.current(50.45, 30.52)).resolves.toBeNull();

    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    await expect(weather.current(50.45, 30.52)).resolves.toBeNull();
  });

  it('rejects impossible coordinates without calling out', async () => {
    expect(await weather.current(91, 30.52)).toBeNull();
    expect(await weather.current(50.45, 181)).toBeNull();
    expect(await weather.current('north', 30.52)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('weather: forecast()', () => {
  beforeEach(enableWeather);

  it('maps the hourly arrays and clamps the horizon', async () => {
    global.fetch = vi.fn(async () => okJson({
      latitude: 50.45, longitude: 30.52, timezone: 'Europe/Kyiv',
      hourly: {
        time: [T, T + 3600],
        temperature_2m: [-3.5, -2.0],
        relative_humidity_2m: [81.4, 79.8],
        surface_pressure: [1004.6, 1005.1],
        wind_speed_10m: [3.2, 2.9],
        weather_code: [3, 61],
      },
    }));

    const fc = await weather.forecast(50.45, 30.52, 500);     // over the 168 h ceiling

    expect(fc.timezone).toBe('Europe/Kyiv');
    expect(fc.hourly).toHaveLength(2);
    expect(fc.hourly[0]).toEqual({
      observed_at: HOUR_ISO, temp_c: -3.5, humidity: 81,
      pressure_hpa: 1004.6, wind_ms: 3.2, weather_code: 3,
    });
    expect(fetchedUrls()[0].searchParams.get('forecast_hours')).toBe('168');
  });

  it('siteWeather() bundles current + forecast + timezone in ONE request', async () => {
    global.fetch = vi.fn(async () => okJson({
      ...omEntry(),
      hourly: { time: [T, T + 3600], temperature_2m: [-3.5, -2.0], relative_humidity_2m: [81, 80],
                surface_pressure: [1004.6, 1005.1], wind_speed_10m: [3.2, 2.9], weather_code: [3, 61] },
    }));

    const w = await weather.siteWeather(50.45, 30.52, 6);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = fetchedUrls()[0];
    expect(url.searchParams.get('current')).toContain('temperature_2m');
    expect(url.searchParams.get('forecast_hours')).toBe('6');

    expect(w.timezone).toBe('Europe/Kyiv');
    expect(w.current.temp_c).toBe(-3.5);
    expect(w.forecast).toHaveLength(2);

    // Both halves were seeded into the shared cache.
    await weather.current(50.45, 30.52);
    await weather.forecast(50.45, 30.52, 6);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('weather: timezone extraction', () => {
  beforeEach(enableWeather);

  it('returns the IANA zone carried by the response', async () => {
    global.fetch = vi.fn(async () => okJson(omEntry({ timezone: 'Europe/Warsaw' })));
    expect(await weather.timezoneFor(52.23, 21.01)).toBe('Europe/Warsaw');
  });

  it('returns null when the provider omits the zone', async () => {
    global.fetch = vi.fn(async () => okJson(omEntry({ timezone: undefined })));
    expect(await weather.timezoneFor(50.45, 30.52)).toBeNull();
  });
});

describe('weather: poller', () => {
  const SITES = [
    { id: 's1', tenant_id: 't1', latitude: 50.4501, longitude: 30.5234, timezone: null },
    { id: 's2', tenant_id: 't1', latitude: 50.4499, longitude: 30.5236, timezone: 'Europe/Kyiv' },
    { id: 's3', tenant_id: 't2', latitude: 49.8397, longitude: 24.0297, timezone: null },
  ];

  beforeEach(() => {
    enableWeather();
    db.query = vi.fn(async (sql) => (/FROM sites/i.test(sql) ? { rows: SITES } : { rows: [] }));
    global.fetch = vi.fn(async () => okJson([
      omEntry(),                                                     // 50.45 / 30.52
      omEntry({ latitude: 49.84, longitude: 24.03 }),                // 49.84 / 24.03
    ]));
  });

  it('issues one request per DISTINCT rounded coordinate', async () => {
    const res = await weather.pollOnce();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = fetchedUrls()[0];
    expect(url.searchParams.get('latitude')).toBe('50.45,49.84');
    expect(url.searchParams.get('longitude')).toBe('30.52,24.03');
    expect(res).toMatchObject({ coordinates: 2, requests: 1, inserted: 3 });
  });

  it('writes one observation per site, with its own tenant_id', async () => {
    await weather.pollOnce();

    const inserts = queriesMatching(/INSERT INTO weather_observations/i);
    expect(inserts).toHaveLength(1);

    const [sql, params] = inserts[0];
    expect(sql).toMatch(/ON CONFLICT \(site_id, observed_at\) DO NOTHING/);
    expect(params).toHaveLength(24);                                  // 3 rows x 8 columns
    expect(params.filter((_, i) => i % 8 === 0)).toEqual(['s1', 's2', 's3']);
    expect(params.filter((_, i) => i % 8 === 1)).toEqual(['t1', 't1', 't2']);
    expect(params.filter((_, i) => i % 8 === 2)).toEqual([HOUR_ISO, HOUR_ISO, HOUR_ISO]);
  });

  it('fills sites.timezone only where it is still NULL', async () => {
    await weather.pollOnce();

    const updates = queriesMatching(/UPDATE sites/i);
    expect(updates).toHaveLength(1);

    const [sql, params] = updates[0];
    expect(sql).toMatch(/timezone IS NULL/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);                      // no trigger on sites by design
    expect(params[0]).toBe('Europe/Kyiv');
    expect(params[1]).toEqual(['s1', 's3']);                          // s2 already had a zone
  });

  it('warms the in-process cache, so current() needs no extra request', async () => {
    await weather.pollOnce();
    const cur = await weather.current(50.4501, 30.5234);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(cur.timezone).toBe('Europe/Kyiv');
  });

  it('does not run two sweeps at once', async () => {
    const [first, second] = await Promise.all([weather.pollOnce(), weather.pollOnce()]);
    expect(first.requests).toBe(1);
    expect(second.skipped).toBe('in_progress');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the database is unavailable', async () => {
    db.query = vi.fn(async () => { throw new Error('connection refused'); });
    await expect(weather.pollOnce()).resolves.toMatchObject({ requests: 0 });
  });

  it('skips the write when the provider is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    const res = await weather.pollOnce();
    expect(res.inserted).toBe(0);
    expect(queriesMatching(/INSERT INTO weather_observations/i)).toHaveLength(0);
  });
});

describe('weather: lifecycle', () => {
  beforeEach(() => {
    enableWeather();
    db.query = vi.fn(async () => ({ rows: [] }));
  });

  it('sweeps after the boot delay and stops on shutdown', () => {
    vi.useFakeTimers();
    weather.start(silent);

    expect(db.query).not.toHaveBeenCalled();               // 60 s + jitter, never immediately
    vi.advanceTimersByTime(121 * 1000);
    expect(db.query).toHaveBeenCalledTimes(1);

    weather.shutdown();
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(db.query).toHaveBeenCalledTimes(1);             // every timer cleared
  });
});
