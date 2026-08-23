'use strict';

// GET /api/public/site — the only unauthenticated data endpoint in the API.
//
// What this suite guards, in order of how badly it would hurt to get wrong:
//   1. the response leaks NOTHING beyond site name/city/region/country and
//      per device { name, online, air_temp, alarm_active };
//   2. unknown, revoked and expired tokens are indistinguishable 404s;
//   3. the router answers without an Authorization header, i.e. it stays mounted
//      above `app.use('/api', authenticate)`;
//   4. it has a strict rate limiter of its own.
//
// globals: true in vitest.config.js

const request = require('supertest');
const express = require('express');
const crypto  = require('crypto');
const pino    = require('pino');

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

// ── Service stubs ─────────────────────────────────────────
// Live MQTT state is injected per test through `live`; nothing here reaches a
// broker. routes/sites.js (used for the end-to-end mint case) also pulls the
// three third-party services, so those are switched off too.
const mqttSvc = require('../src/services/mqtt');
const live = new Map();                 // mqtt_device_id → { state, meta }
mqttSvc.getDeviceState = id => live.get(id)?.state ?? null;
mqttSvc.getDeviceMeta  = id => live.get(id)?.meta  ?? null;

const geocodeSvc = require('../src/services/geocode');
geocodeSvc.isEnabled      = () => false;
geocodeSvc.isBulkEnabled  = () => false;
geocodeSvc.geocode        = async () => null;
geocodeSvc.search         = async () => [];
geocodeSvc.resolveAddress = async () => ({ status: geocodeSvc.OUTCOME.DISABLED, result: null });
const weatherSvc = require('../src/services/weather');
weatherSvc.isEnabled   = () => false;
weatherSvc.siteWeather = async () => null;
weatherSvc.timezoneFor = async () => null;
const routingSvc = require('../src/services/routing');
routingSvc.isEnabled = () => false;
routingSvc.route     = async () => null;

const publicRouter = require('../src/routes/public');

const { authenticate } = require('../src/middleware/auth');
const createAuditMiddleware = require('../src/middleware/audit');

const silentLogger = pino({ level: 'silent' });

// ── App ───────────────────────────────────────────────────
// The mount ORDER below is the thing under test, and it mirrors index.js:
// /api/public sits above the JWT gate. helpers/app.js hand-builds its own list,
// so this suite assembles the chain itself and cannot be affected by edits there.
function createPublicApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', createAuditMiddleware(silentLogger));
  app.use('/api/public', publicRouter);          // MUST stay above authenticate
  app.use('/api', authenticate);
  app.use('/api/sites', require('../src/routes/sites'));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });
  return app;
}

const app = createPublicApp();

const PUBLIC_PATH = '/api/public/site';
const get = token => {
  const req = request(app).get(PUBLIC_PATH);
  return token === undefined ? req : req.set('X-Site-Token', token);
};

// ── Local fixtures ────────────────────────────────────────

function rnd(n = 8) {
  return crypto.randomBytes(8).toString('hex').slice(0, n);
}

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city,
                        address_line, postal_code, latitude, longitude, geo_source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      tenantId,
      overrides.name ?? `Site ${rnd()}`,
      overrides.country_code ?? 'UA',
      overrides.country ?? 'Україна',
      overrides.region ?? 'Київська область',
      overrides.city ?? 'Київ',
      overrides.address_line ?? 'Хрещатик, 22',
      overrides.postal_code ?? '01001',
      overrides.latitude ?? 50.4498,
      overrides.longitude ?? 30.5231,
      overrides.geo_source ?? 'manual',
      overrides.notes ?? 'internal note — must never be public',
    ]
  );
  return rows[0];
}

async function createLink(site, opts = {}) {
  const raw = opts.token || crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO site_public_links (tenant_id, site_id, token_hash, label, expires_at, revoked_at, created_by)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 second'), $6, $7)
     RETURNING id, expires_at, revoked_at, view_count, last_viewed`,
    [
      site.tenant_id, site.id, tokenHash,
      opts.label ?? null,
      opts.expiresInSec ?? 3600,
      opts.revoked ? new Date() : null,
      opts.createdBy ?? null,
    ]
  );
  return { raw, tokenHash, row: rows[0] };
}

async function linkState(linkId) {
  const { rows } = await db.query(
    'SELECT view_count, last_viewed FROM site_public_links WHERE id = $1', [linkId]
  );
  return rows[0];
}

async function attach(deviceId, siteId) {
  await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteId, deviceId]);
}

const DEVICE_KEYS = ['air_temp', 'alarm_active', 'name', 'online'];
const SITE_KEYS = [
  'alarm_count', 'city', 'country', 'device_count', 'devices',
  'generated_at', 'name', 'online_count', 'region',
];

describe('GET /api/public/site', () => {
  let tenant, otherTenant, admin;
  let site, otherSite;
  let devA, devB, devUnnamed, devDeleted, devPending, devOtherSite, devOtherTenant;
  let link;

  beforeAll(async () => {
    await cleanDatabase();

    tenant      = await createTenant({ slug: 'public-site-a' });
    otherTenant = await createTenant({ slug: 'public-site-b' });
    admin       = await createUser(tenant.id, { role: 'admin', email: 'admin@public-site.test' });

    site      = await createSite(tenant.id, { name: 'АТБ №142' });
    otherSite = await createSite(tenant.id, { name: 'Сільпо №7', city: 'Львів' });

    devA       = await createDevice(tenant.id, { name: 'Вітрина 1' });
    devB       = await createDevice(tenant.id, { name: 'Вітрина 2' });
    devUnnamed = await createDevice(tenant.id, { name: 'temporary' });
    devDeleted = await createDevice(tenant.id, { name: 'Списана вітрина' });
    devPending = await createDevice(tenant.id, { name: 'Нова вітрина' });
    devOtherSite   = await createDevice(tenant.id,      { name: 'Львівська вітрина' });
    devOtherTenant = await createDevice(otherTenant.id, { name: 'Чужа вітрина' });

    for (const d of [devA, devB, devUnnamed, devDeleted, devPending]) {
      await attach(d.id, site.id);
    }
    await attach(devOtherSite.id, otherSite.id);
    // A device of ANOTHER tenant pointing at this site. There is deliberately no
    // composite FK on devices (five code paths move a device between tenants
    // without touching site_id), so this state is reachable in production — the
    // handler's `d.tenant_id = <link tenant>` predicate is what excludes it.
    await attach(devOtherTenant.id, site.id);

    await db.query('UPDATE devices SET name = NULL WHERE id = $1', [devUnnamed.id]);
    await db.query(
      `UPDATE devices SET status = 'deleted', deleted_at = NOW() WHERE id = $1`, [devDeleted.id]
    );
    await db.query(`UPDATE devices SET status = 'pending' WHERE id = $1`, [devPending.id]);

    link = await createLink(site, { label: 'Lobby screen' });
  });

  afterAll(async () => {
    await shutdownDb();
  });

  beforeEach(async () => {
    live.clear();
    await publicRouter.resetRateLimit();
  });

  // ── Mount order ─────────────────────────────────────────
  it('answers WITHOUT an Authorization header (guards the mount order)', async () => {
    const res = await get(link.raw);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('АТБ №142');
  });

  // The case above proves the ROUTER needs no Authorization header, but it runs
  // against createPublicApp() — a mirror of index.js, not index.js itself. Only a
  // check on the real file can catch someone moving the mount below the JWT gate
  // (which would 401 every customer status page). Reading the source is enough:
  // requiring src/index.js would start the HTTP server, MQTT client and pollers.
  it('keeps /api/public above the JWT gate in src/index.js itself', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8'
    );

    // Line-anchored: the same two calls are quoted in the comments around them,
    // and a comment must not be able to satisfy — or break — this assertion.
    const lines = source.split(/\r?\n/);
    const lineOf = re => lines.findIndex(l => re.test(l));

    const publicMount = lineOf(/^\s*app\.use\('\/api\/public'/);
    const authGate    = lineOf(/^\s*app\.use\('\/api',\s*authenticate\)/);

    expect(publicMount).toBeGreaterThan(-1);
    expect(authGate).toBeGreaterThan(-1);
    expect(publicMount).toBeLessThan(authGate);
  });

  // ── The payload ─────────────────────────────────────────
  describe('payload', () => {
    it('returns exactly the allowed site fields', async () => {
      const res = await get(link.raw);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(SITE_KEYS.slice().sort());
      expect(res.body.data.city).toBe('Київ');
      expect(res.body.data.region).toBe('Київська область');
      expect(res.body.data.country).toBe('Україна');
    });

    it('returns exactly the allowed device fields', async () => {
      const res = await get(link.raw);

      expect(res.body.data.devices.length).toBeGreaterThan(0);
      for (const d of res.body.data.devices) {
        expect(Object.keys(d).sort()).toEqual(DEVICE_KEYS.slice().sort());
      }
    });

    it('leaks no identifier, no address and no coordinate', async () => {
      const res = await get(link.raw);
      const body = JSON.stringify(res.body);

      const forbiddenValues = [
        site.id, site.tenant_id, tenant.id, tenant.slug, link.row.id, link.tokenHash, link.raw,
        devA.id, devB.id, devUnnamed.id, devA.mqtt_device_id, devB.mqtt_device_id,
        devUnnamed.mqtt_device_id, admin.id, admin.email,
        'Хрещатик, 22', '01001', '50.4498', '30.5231',
        'internal note — must never be public',
      ];
      for (const value of forbiddenValues) {
        expect(body).not.toContain(String(value));
      }

      const forbiddenKeys = [
        '"id"', 'mqtt_device_id', 'tenant', 'site_id', 'latitude', 'longitude',
        'address_line', 'postal_code', 'firmware', 'serial', 'password', 'email',
        'token', 'notes', 'geo_source',
      ];
      for (const key of forbiddenKeys) {
        expect(body).not.toContain(key);
      }
    });

    it('excludes soft-deleted, pending, other-site and other-tenant devices', async () => {
      const res = await get(link.raw);
      const names = res.body.data.devices.map(d => d.name);

      expect(names).toContain('Вітрина 1');
      expect(names).toContain('Вітрина 2');
      expect(names).not.toContain('Списана вітрина');
      expect(names).not.toContain('Нова вітрина');
      expect(names).not.toContain('Львівська вітрина');
      expect(names).not.toContain('Чужа вітрина');
      expect(res.body.data.device_count).toBe(3);   // two named + one unnamed
    });

    it('labels an unnamed device positionally, never with its mqtt id', async () => {
      const res = await get(link.raw);
      const labels = res.body.data.devices.map(d => d.name);

      // ORDER BY name NULLS LAST puts the unnamed device last
      expect(labels[labels.length - 1]).toBe(`#${labels.length}`);
      expect(labels).not.toContain(devUnnamed.mqtt_device_id);
    });

    it('reports air_temp, online and alarm_active from live MQTT state', async () => {
      live.set(devA.mqtt_device_id, {
        state: { 'equipment.air_temp': -18.4, 'protection.alarm_active': true },
        meta:  { online: true },
      });
      live.set(devB.mqtt_device_id, {
        state: { 'equipment.air_temp': 'n/a' },     // non-numeric → hidden
        meta:  { online: false },
      });

      const res = await get(link.raw);
      const byName = Object.fromEntries(res.body.data.devices.map(d => [d.name, d]));

      expect(byName['Вітрина 1'].air_temp).toBe(-18.4);
      expect(byName['Вітрина 1'].online).toBe(true);
      expect(byName['Вітрина 1'].alarm_active).toBe(true);
      expect(byName['Вітрина 2'].air_temp).toBeNull();
      expect(byName['Вітрина 2'].online).toBe(false);
      expect(byName['Вітрина 2'].alarm_active).toBe(false);
      expect(res.body.data.online_count).toBe(1);
      expect(res.body.data.alarm_count).toBe(1);
    });

    it('reports alarm_active from the alarms table when there is no live state', async () => {
      await db.query(
        `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active)
         VALUES ($1, $2, 'HIGH_TEMP', 'critical', true)`,
        [tenant.id, devB.mqtt_device_id]
      );

      const res = await get(link.raw);
      const byName = Object.fromEntries(res.body.data.devices.map(d => [d.name, d]));

      expect(byName['Вітрина 2'].alarm_active).toBe(true);
      expect(byName['Вітрина 1'].alarm_active).toBe(false);
      expect(res.body.data.alarm_count).toBe(1);

      await db.query('DELETE FROM alarms WHERE device_id = $1', [devB.mqtt_device_id]);
    });

    it('is served no-store and noindex', async () => {
      const res = await get(link.raw);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toContain('noindex');
    });
  });

  // ── Rejections ──────────────────────────────────────────
  describe('rejections', () => {
    it('returns an IDENTICAL 404 for unknown, revoked, expired and missing tokens', async () => {
      const revoked = await createLink(site, { revoked: true });
      const expired = await createLink(site, { expiresInSec: -60 });
      const unknown = crypto.randomBytes(32).toString('base64url');

      const responses = [
        await get(unknown),
        await get(revoked.raw),
        await get(expired.raw),
        await get(),                              // no header at all
        await get(''),                            // empty header
        await get('   '),                         // whitespace only
        await get('x'.repeat(300)),               // over the length cap
        await get('not a base64url token'),
      ];

      const bodies = new Set();
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.headers['www-authenticate']).toBeUndefined();
        bodies.add(JSON.stringify(res.body));
      }
      expect(bodies.size).toBe(1);
      expect(JSON.parse([...bodies][0])).toEqual({
        error: 'not_found', message: 'Not found', status: 404,
      });
    });

    it('does not count a view for a revoked or an expired token', async () => {
      const revoked = await createLink(site, { revoked: true });
      const expired = await createLink(site, { expiresInSec: -60 });

      await get(revoked.raw);
      await get(expired.raw);

      expect((await linkState(revoked.row.id)).view_count).toBe(0);
      expect((await linkState(expired.row.id)).view_count).toBe(0);
      expect((await linkState(revoked.row.id)).last_viewed).toBeNull();
    });

    it('stops working when the site itself is deleted', async () => {
      const doomed = await createSite(tenant.id, { name: `Doomed ${rnd()}` });
      const doomedLink = await createLink(doomed);

      expect((await get(doomedLink.raw)).status).toBe(200);

      await db.query('DELETE FROM sites WHERE id = $1', [doomed.id]);

      const res = await get(doomedLink.raw);
      expect(res.status).toBe(404);
    });
  });

  // ── View accounting ─────────────────────────────────────
  describe('view accounting', () => {
    it('increments view_count and stamps last_viewed', async () => {
      const counted = await createLink(site);

      expect((await linkState(counted.row.id)).view_count).toBe(0);

      await get(counted.raw);
      const first = await linkState(counted.row.id);
      expect(first.view_count).toBe(1);
      expect(first.last_viewed).not.toBeNull();

      await get(counted.raw);
      expect((await linkState(counted.row.id)).view_count).toBe(2);
    });
  });

  // ── End-to-end with the minting endpoint ────────────────
  describe('tokens minted by POST /api/sites/:id/public-links', () => {
    it('round-trips, and stops working the moment the link is revoked', async () => {
      const created = await request(app)
        .post(`/api/sites/${site.id}/public-links`)
        .set(authHeader(admin, tenant.id))
        .send({ label: 'Reception screen' });

      expect(created.status).toBe(201);
      const raw = created.body.data.token;
      expect(typeof raw).toBe('string');
      expect(raw.length).toBeGreaterThanOrEqual(40);

      const page = await get(raw);
      expect(page.status).toBe(200);
      expect(page.body.data.name).toBe('АТБ №142');

      const revoked = await request(app)
        .delete(`/api/sites/${site.id}/public-links/${created.body.data.id}`)
        .set(authHeader(admin, tenant.id));
      expect(revoked.status).toBe(200);

      const after = await get(raw);
      expect(after.status).toBe(404);
    });
  });

  // ── Rate limiting ───────────────────────────────────────
  // Last, because it deliberately exhausts the window for this IP.
  describe('rate limiting', () => {
    it('429s past the window limit and keeps the house error shape', async () => {
      const unknown = crypto.randomBytes(32).toString('base64url');

      let last;
      for (let i = 0; i < 30; i++) {
        last = await get(unknown);
        expect(last.status).toBe(404);
      }

      const limited = await get(link.raw);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        error: 'too_many_requests',
        message: 'Too many requests, try again later',
        status: 429,
      });

      // The limiter must not be the reason a later suite fails.
      await publicRouter.resetRateLimit();
      expect((await get(link.raw)).status).toBe(200);
    });
  });
});
