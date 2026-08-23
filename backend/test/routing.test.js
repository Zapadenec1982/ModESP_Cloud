'use strict';

// globals: true in vitest.config.js
//
// Pure unit test: `fetch` is replaced, so this file touches neither the network
// nor Postgres. It deliberately does NOT require helpers/setup.js.

const pino    = require('pino');
const routing = require('../src/services/routing');

const silent = pino({ level: 'silent' });

const ENV_KEYS = ['OSRM_URL', 'OSRM_TIMEOUT_MS', 'ORS_URL', 'ORS_API_KEY', 'ORS_TIMEOUT_MS'];

// Deliberately NOT in ENV_KEYS: beforeEach deletes every key listed there, which
// would restore the pacer's default mid-run.
// The ORS pacer keeps us under the account-wide 20 req/min ceiling in production.
// Tests exercise the same code path repeatedly, so leaving it at its default would
// add ~3.5s of real sleeping per upstream call and push this file past testTimeout
// on a slow runner. The pacer's serialisation is what the tests care about; its
// spacing is not.
process.env.ORS_MIN_INTERVAL_MS = '0';

const KYIV     = { lat: 50.4501, lon: 30.5234 };
const LVIV     = { lat: 49.8397, lon: 24.0297 };
const ZHYTOMYR = { lat: 50.2547, lon: 28.6587 };
const RIVNE    = { lat: 50.6199, lon: 26.2516 };

let envBackup;
let realFetch;

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function enableOsrm() {
  process.env.OSRM_URL = 'https://osrm.test';
}

function lastUrl() {
  const calls = global.fetch.mock.calls;
  return new URL(String(calls[calls.length - 1][0]));
}

function lastInit() {
  const calls = global.fetch.mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }

  realFetch = global.fetch;
  global.fetch = vi.fn(async () => okJson({}));

  routing.init(silent);
});

afterEach(() => {
  global.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('routing: disabled by default', () => {
  it('OSRM is off for an empty or "none" URL', () => {
    expect(routing.isEnabled()).toBe(false);          // OSRM_URL deleted
    process.env.OSRM_URL = '  ';
    expect(routing.isEnabled()).toBe(false);
    process.env.OSRM_URL = 'None';
    expect(routing.isEnabled()).toBe(false);
    process.env.OSRM_URL = 'https://osrm.test';
    expect(routing.isEnabled()).toBe(true);
  });

  it('route() and trip() answer null without touching the network', async () => {
    expect(await routing.route([KYIV, LVIV])).toBeNull();
    expect(await routing.trip([KYIV, LVIV, ZHYTOMYR])).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('isochrones are gated on the ORS KEY, not the URL', () => {
    // The demo posture ships ORS_URL populated and ORS_API_KEY empty; a URL-based
    // gate would advertise isochrones and then 403 on every call.
    process.env.ORS_URL = 'https://api.openrouteservice.org';
    expect(routing.isochronesEnabled()).toBe(false);
    process.env.ORS_API_KEY = 'none';
    expect(routing.isochronesEnabled()).toBe(false);
    process.env.ORS_API_KEY = 'real-key';
    expect(routing.isochronesEnabled()).toBe(true);
  });
});

describe('routing: route()', () => {
  beforeEach(enableOsrm);

  const OSRM_ROUTE = {
    code: 'Ok',
    routes: [{
      distance: 468123.4,
      duration: 21600.7,
      geometry: { type: 'LineString', coordinates: [[30.5234, 50.4501], [24.0297, 49.8397]] },
      legs: [{ distance: 468123.4, duration: 21600.7 }],
    }],
    waypoints: [{ location: [30.5234, 50.4501] }, { location: [24.0297, 49.8397] }],
  };

  it('sends lon,lat pairs in the path and parses the answer', async () => {
    global.fetch = vi.fn(async () => okJson(OSRM_ROUTE));

    const r = await routing.route([KYIV, LVIV]);

    const url = lastUrl();
    expect(url.pathname).toBe('/route/v1/driving/30.523400,50.450100;24.029700,49.839700');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('overview')).toBe('full');

    expect(r).toEqual({
      order: [0, 1],
      legs: [{ from: 0, to: 1, distance_m: 468123, duration_s: 21601 }],
      geometry: OSRM_ROUTE.routes[0].geometry,
      total_distance_m: 468123,
      total_duration_s: 21601,
      provider: 'osrm',
      optimized: false,
    });
  });

  it('returns null on a non-Ok code, a non-2xx and a transport error', async () => {
    global.fetch = vi.fn(async () => okJson({ code: 'NoRoute', routes: [] }));
    expect(await routing.route([KYIV, LVIV])).toBeNull();

    global.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await routing.route([KYIV, LVIV])).toBeNull();

    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(routing.route([KYIV, LVIV])).resolves.toBeNull();
  });

  it('refuses unusable input before building a URL', async () => {
    expect(await routing.route([KYIV])).toBeNull();                       // needs 2+
    expect(await routing.route([KYIV, { lat: 91, lon: 30 }])).toBeNull();
    expect(await routing.route([KYIV, { lat: 50, lon: 'east' }])).toBeNull();
    expect(await routing.route(Array(26).fill(KYIV))).toBeNull();         // cap is 25
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('routing: trip() TSP order', () => {
  beforeEach(enableOsrm);

  // Input order: [KYIV, LVIV, ZHYTOMYR, RIVNE]
  // waypoint_index = position of that INPUT point in the optimised tour, so the
  // visiting order here is 0 → 3 → 1 → 2.
  const OSRM_TRIP = {
    code: 'Ok',
    trips: [{
      distance: 900000.5,
      duration: 43200.4,
      geometry: { type: 'LineString', coordinates: [[30.5234, 50.4501], [26.2516, 50.6199]] },
      legs: [
        { distance: 100000, duration: 3600 },
        { distance: 200000, duration: 7200 },
        { distance: 300000, duration: 10800 },
        { distance: 300000, duration: 21600 },
      ],
    }],
    waypoints: [
      { waypoint_index: 0, trips_index: 0 },   // KYIV     → 1st stop
      { waypoint_index: 2, trips_index: 0 },   // LVIV     → 3rd stop
      { waypoint_index: 3, trips_index: 0 },   // ZHYTOMYR → 4th stop
      { waypoint_index: 1, trips_index: 0 },   // RIVNE    → 2nd stop
    ],
  };

  it('reorders the input indices by waypoint_index', async () => {
    global.fetch = vi.fn(async () => okJson(OSRM_TRIP));

    const t = await routing.trip([KYIV, LVIV, ZHYTOMYR, RIVNE], { roundtrip: true });

    expect(t.order).toEqual([0, 3, 1, 2]);
    expect(t.optimized).toBe(true);
    expect(t.total_distance_m).toBe(900001);
    expect(t.total_duration_s).toBe(43200);
    expect(t.geometry).toEqual(OSRM_TRIP.trips[0].geometry);

    // Legs follow the optimised tour; the last one closes the loop.
    expect(t.legs.map(l => [l.from, l.to])).toEqual([[0, 3], [3, 1], [1, 2], [2, 0]]);
    expect(t.legs[0]).toEqual({ from: 0, to: 3, distance_m: 100000, duration_s: 3600 });

    expect(lastUrl().searchParams.get('roundtrip')).toBe('true');
    expect(lastUrl().searchParams.get('source')).toBe('first');
  });

  it('pins start and end for an open tour', async () => {
    global.fetch = vi.fn(async () => okJson(OSRM_TRIP));
    await routing.trip([KYIV, LVIV, ZHYTOMYR, RIVNE], { roundtrip: false });

    const url = lastUrl();
    expect(url.pathname.startsWith('/trip/v1/driving/')).toBe(true);
    expect(url.searchParams.get('roundtrip')).toBe('false');
    expect(url.searchParams.get('source')).toBe('first');
    expect(url.searchParams.get('destination')).toBe('last');
  });

  it('returns null when the waypoint set is incomplete', async () => {
    global.fetch = vi.fn(async () => okJson({
      ...OSRM_TRIP,
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
    }));
    expect(await routing.trip([KYIV, LVIV, ZHYTOMYR, RIVNE])).toBeNull();
  });
});

describe('routing: haversine helpers', () => {
  it('measures Kyiv → Lviv to within a few kilometres', () => {
    const km = routing.haversineKm(KYIV.lat, KYIV.lon, LVIV.lat, LVIV.lon);
    expect(km).toBeGreaterThan(460);
    expect(km).toBeLessThan(475);
    expect(routing.haversineKm(KYIV.lat, KYIV.lon, KYIV.lat, KYIV.lon)).toBe(0);
    expect(Number.isNaN(routing.haversineKm(KYIV.lat, KYIV.lon, null, 30))).toBe(true);
  });

  it('orders stops greedily and sums the straight-line distance', () => {
    // Kyiv → Zhytomyr (~134 km) → Rivne (~176 km) → Lviv (~181 km)
    const { order, total_distance_m } =
      routing.nearestNeighbourOrder([KYIV, LVIV, ZHYTOMYR, RIVNE]);

    expect(order).toEqual([0, 2, 3, 1]);
    expect(total_distance_m).toBeGreaterThan(400000);
    expect(total_distance_m).toBeLessThan(600000);
  });

  it('handles the degenerate inputs the fallback path can hit', () => {
    expect(routing.nearestNeighbourOrder([])).toEqual({ order: [], total_distance_m: 0 });
    expect(routing.nearestNeighbourOrder([KYIV])).toEqual({ order: [0], total_distance_m: 0 });
    expect(routing.nearestNeighbourOrder([KYIV, LVIV], 1).order).toEqual([1, 0]);
  });
});

describe('routing: isochrones', () => {
  it('falls back to straight-line rings with no key configured', async () => {
    const res = await routing.isochrones(50.45, 30.52, [15, 30, 60]);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.meta).toEqual({
      approximate: true, provider: null,
      assumed_speed_kmh: routing.ASSUMED_SPEED_KMH, minutes: [15, 30, 60],
    });
    expect(res.collection.type).toBe('FeatureCollection');
    expect(res.collection.features).toHaveLength(3);

    // Largest band first so the smaller rings stay visible on top of it.
    expect(res.collection.features.map(f => f.properties.minutes)).toEqual([60, 30, 15]);

    // The flag must travel with the geometry, not only in meta.
    for (const f of res.collection.features) {
      expect(f.properties.approximate).toBe(true);
      expect(f.properties.provider).toBeNull();
      expect(f.properties.assumed_speed_kmh).toBe(routing.ASSUMED_SPEED_KMH);
      expect(f.properties.value).toBe(f.properties.minutes * 60);
      expect(f.geometry.type).toBe('Polygon');
    }
  });

  it('divides the longitude delta by cos(latitude)', async () => {
    const lat = 50.45;
    const lon = 30.52;
    const res = await routing.isochrones(lat, lon, [30]);
    const ring = res.collection.features[0].geometry.coordinates[0];

    // A closed ring: first and last vertex are identical.
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    const dLon = Math.max(...ring.map(p => Math.abs(p[0] - lon)));
    const dLat = Math.max(...ring.map(p => Math.abs(p[1] - lat)));

    // Equal-degree offsets would draw an ellipse ~1.55x too wide at 50 degrees N.
    expect(dLon / dLat).toBeCloseTo(1 / Math.cos((lat * Math.PI) / 180), 2);

    // 30 min at the assumed speed — a 15 km radius, i.e. ~0.135 degrees of latitude.
    expect(dLat * 111.32).toBeCloseTo((routing.ASSUMED_SPEED_KMH / 60) * 30, 1);
  });

  it('uses OpenRouteService when a key is set', async () => {
    process.env.ORS_URL     = 'https://ors.test';
    process.env.ORS_API_KEY = 'secret-key';
    global.fetch = vi.fn(async () => okJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { value: 900 },  geometry: { type: 'Polygon', coordinates: [[[30.4, 50.4], [30.6, 50.4], [30.6, 50.5], [30.4, 50.4]]] } },
        { type: 'Feature', properties: { value: 1800 }, geometry: { type: 'Polygon', coordinates: [[[30.3, 50.3], [30.7, 50.3], [30.7, 50.6], [30.3, 50.3]]] } },
      ],
    }));

    const res = await routing.isochrones(50.45, 30.52, [15, 30]);

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe('https://ors.test/v2/isochrones/driving-car');

    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('secret-key');
    expect(JSON.parse(init.body)).toEqual({
      locations: [[30.52, 50.45]],          // GeoJSON order: lon, lat
      range: [900, 1800],                   // minutes converted to seconds
      range_type: 'time',
    });

    expect(res.meta).toEqual({
      approximate: false, provider: 'openrouteservice',
      assumed_speed_kmh: null, minutes: [15, 30],
    });
    expect(res.collection.features.map(f => f.properties.minutes)).toEqual([30, 15]);
    expect(res.collection.features[0].properties.approximate).toBe(false);
  });

  it('falls back to approximate rings when OpenRouteService fails', async () => {
    process.env.ORS_URL     = 'https://ors.test';
    process.env.ORS_API_KEY = 'secret-key';

    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    let res = await routing.isochrones(50.45, 30.52, [15]);
    expect(res.meta.approximate).toBe(true);
    expect(res.collection.features[0].properties.approximate).toBe(true);

    global.fetch = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    res = await routing.isochrones(50.45, 30.52, [15]);
    expect(res.meta.approximate).toBe(true);

    global.fetch = vi.fn(async () => okJson({ type: 'FeatureCollection', features: [] }));
    res = await routing.isochrones(50.45, 30.52, [15]);
    expect(res.meta.approximate).toBe(true);
  });

  it('rejects unusable centres and ranges', async () => {
    expect(await routing.isochrones(91, 30.52, [15])).toBeNull();
    expect(await routing.isochrones(50.45, 181, [15])).toBeNull();
    expect(await routing.isochrones('north', 30.52, [15])).toBeNull();
    expect(await routing.isochrones(50.45, 30.52, [])).toBeNull();
    expect(await routing.isochrones(50.45, 30.52, [0, 121, 'x'])).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('caps the request at three distinct bands', async () => {
    const res = await routing.isochrones(50.45, 30.52, [10, 10, 20, 30, 40]);
    expect(res.meta.minutes).toEqual([10, 20, 30]);
    expect(res.collection.features).toHaveLength(3);
  });
});
