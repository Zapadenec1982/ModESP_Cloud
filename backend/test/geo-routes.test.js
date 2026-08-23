'use strict';

// Env vars + DB service init (no query is issued by this file — the geocoder is
// stubbed on the singleton, so nothing here needs a live Postgres).
const { shutdownDb } = require('./helpers/setup');

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

const { authenticate } = require('../src/middleware/auth');
const geocodeSvc = require('../src/services/geocode');

// ── Test app ─────────────────────────────────────────────
// Mirrors the index.js chain for /api/geo: JWT gate, then the router.
// (helpers/app.js hand-builds its own app and is owned by another agent, so the
// geo mount lives here.)
function createGeoApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', authenticate);
  app.use('/api/geo', require('../src/routes/geo'));
  app.use((_err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong', status: 500 });
  });
  return app;
}

const app = createGeoApp();

function tokenFor(role = 'viewer') {
  return jwt.sign(
    {
      sub:      '00000000-0000-0000-0000-0000000000aa',
      email:    `${role}@geo.test`,
      role,
      tenantId: '00000000-0000-0000-0000-0000000000bb',
    },
    process.env.JWT_SECRET,
    { expiresIn: 900 }
  );
}

const auth = (role = 'viewer') => ({ Authorization: `Bearer ${tokenFor(role)}` });

// ── Geocoder stub ────────────────────────────────────────
// The real service is exercised by geocode.test.js; here we only care that the
// route validates, forwards exactly what it should, and degrades gracefully.

const SAMPLE = {
  display_name: 'Хрещатик, 22, Київ, Україна',
  latitude: 50.4498,
  longitude: 30.5231,
  precision: 'house',
  osm_type: 'way',
  osm_id: 123,
  address: {
    country_code: 'UA',
    country: 'Україна',
    region: 'Київ',
    city: 'Київ',
    address_line: 'Хрещатик, 22',
    postal_code: '01001',
  },
};

let calls;
const original = {
  isEnabled: geocodeSvc.isEnabled,
  search:    geocodeSvc.search,
  reverse:   geocodeSvc.reverse,
};

beforeEach(() => {
  calls = { search: [], reverse: [] };
  geocodeSvc.isEnabled = () => true;
  geocodeSvc.search  = async (...args) => { calls.search.push(args); return [SAMPLE]; };
  geocodeSvc.reverse = async (...args) => { calls.reverse.push(args); return SAMPLE; };
});

afterAll(async () => {
  Object.assign(geocodeSvc, original);
  await shutdownDb();
});

// ── Auth ─────────────────────────────────────────────────

describe('GET /api/geo — authentication', () => {
  it('rejects an unauthenticated search', async () => {
    const res = await request(app).get('/api/geo/search?q=Kyiv');
    expect(res.status).toBe(401);
    expect(calls.search).toHaveLength(0);
  });

  it('rejects an unauthenticated reverse lookup', async () => {
    const res = await request(app).get('/api/geo/reverse?lat=50&lon=30');
    expect(res.status).toBe(401);
  });

  it('allows any authenticated role — the address box is not admin-only', async () => {
    for (const role of ['viewer', 'technician', 'admin', 'superadmin']) {
      const res = await request(app).get('/api/geo/search?q=Kyiv').set(auth(role));
      expect(res.status).toBe(200);
    }
  });
});

// ── /api/geo/search ──────────────────────────────────────

describe('GET /api/geo/search', () => {
  it('returns the provider rows under data', async () => {
    const res = await request(app).get('/api/geo/search?q=Хрещатик 22, Київ').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].latitude).toBeCloseTo(50.4498, 4);
    expect(res.body.meta.enabled).toBe(true);
    expect(calls.search[0][0]).toBe('Хрещатик 22, Київ');
  });

  it('defaults limit to 5 and uses the interactive lane', async () => {
    await request(app).get('/api/geo/search?q=Kyiv').set(auth());
    expect(calls.search[0][1]).toMatchObject({ limit: 5, lane: 'interactive' });
  });

  it('forwards an explicit limit', async () => {
    await request(app).get('/api/geo/search?q=Kyiv&limit=10').set(auth());
    expect(calls.search[0][1].limit).toBe(10);
  });

  it('400s on a missing q', async () => {
    const res = await request(app).get('/api/geo/search').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.status).toBe(400);
    expect(calls.search).toHaveLength(0);
  });

  it('400s on an empty q', async () => {
    const res = await request(app).get('/api/geo/search?q=%20%20').set(auth());
    expect(res.status).toBe(400);
    expect(calls.search).toHaveLength(0);
  });

  it('400s on a q longer than 200 characters', async () => {
    const res = await request(app).get(`/api/geo/search?q=${'a'.repeat(201)}`).set(auth());
    expect(res.status).toBe(400);
    expect(calls.search).toHaveLength(0);
  });

  it('400s on a limit outside 1..10', async () => {
    for (const limit of ['0', '11', 'abc', '-1', '2.5']) {
      const res = await request(app).get(`/api/geo/search?q=Kyiv&limit=${limit}`).set(auth());
      expect(res.status, `limit=${limit}`).toBe(400);
    }
    expect(calls.search).toHaveLength(0);
  });

  it('never proxies an arbitrary URL — extra params are ignored', async () => {
    const res = await request(app)
      .get('/api/geo/search?q=Kyiv&url=http://169.254.169.254/latest/meta-data&provider=evil')
      .set(auth());
    expect(res.status).toBe(200);
    // The service receives the query and options only; nothing caller-supplied
    // can influence the upstream host.
    expect(calls.search[0][0]).toBe('Kyiv');
    expect(Object.keys(calls.search[0][1]).sort()).toEqual(['lane', 'limit']);
  });

  it('degrades to an empty list with 200 when the geocoder is disabled', async () => {
    geocodeSvc.isEnabled = () => false;
    geocodeSvc.search = async () => [];

    const res = await request(app).get('/api/geo/search?q=Kyiv').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.enabled).toBe(false);
  });

  it('degrades to an empty list when the provider fails upstream', async () => {
    // search() is contractually non-rejecting: a timeout/5xx surfaces as [].
    geocodeSvc.search = async () => [];
    const res = await request(app).get('/api/geo/search?q=Kyiv').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ── /api/geo/reverse ─────────────────────────────────────

describe('GET /api/geo/reverse', () => {
  it('returns a single object under data', async () => {
    const res = await request(app).get('/api/geo/reverse?lat=50.4498&lon=30.5231').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.address.city).toBe('Київ');
    expect(calls.reverse[0].slice(0, 2)).toEqual([50.4498, 30.5231]);
  });

  it('400s on missing coordinates', async () => {
    for (const qs of ['', '?lat=50', '?lon=30']) {
      const res = await request(app).get(`/api/geo/reverse${qs}`).set(auth());
      expect(res.status, qs).toBe(400);
    }
    expect(calls.reverse).toHaveLength(0);
  });

  it('400s on empty coordinates instead of geocoding Null Island', async () => {
    const res = await request(app).get('/api/geo/reverse?lat=&lon=').set(auth());
    expect(res.status).toBe(400);
    expect(calls.reverse).toHaveLength(0);
  });

  it('400s on non-numeric coordinates', async () => {
    const res = await request(app).get('/api/geo/reverse?lat=abc&lon=30').set(auth());
    expect(res.status).toBe(400);
    expect(calls.reverse).toHaveLength(0);
  });

  it('400s on out-of-range coordinates', async () => {
    for (const qs of ['?lat=91&lon=30', '?lat=-91&lon=30', '?lat=50&lon=181', '?lat=50&lon=-181']) {
      const res = await request(app).get(`/api/geo/reverse${qs}`).set(auth());
      expect(res.status, qs).toBe(400);
    }
    expect(calls.reverse).toHaveLength(0);
  });

  it('returns data:null with 200 when nothing matches', async () => {
    geocodeSvc.reverse = async () => null;
    const res = await request(app).get('/api/geo/reverse?lat=0&lon=0').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns data:null with 200 when the geocoder is disabled', async () => {
    geocodeSvc.isEnabled = () => false;
    geocodeSvc.reverse = async () => null;

    const res = await request(app).get('/api/geo/reverse?lat=50&lon=30').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.meta.enabled).toBe(false);
  });
});
