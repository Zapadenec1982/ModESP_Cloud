'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const express = require('express');
const crypto  = require('crypto');
const pino    = require('pino');

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

// ── Service stubs ─────────────────────────────────────────
// routes/sites.js reads live MQTT state and calls three third-party services.
// All four are replaced here so no test can reach a broker or the network, and
// so every geocoder/weather/routing outcome is reproducible.
const mqttSvc = require('../src/services/mqtt');
mqttSvc.getDeviceState = () => null;
mqttSvc.getDeviceMeta  = () => null;

const geocodeSvc = require('../src/services/geocode');
const weatherSvc = require('../src/services/weather');
const routingSvc = require('../src/services/routing');

/** Everything off — the shipped default, and the state every test starts from. */
function disableExternalServices() {
  geocodeSvc.isEnabled       = () => false;
  geocodeSvc.isBulkEnabled   = () => false;
  geocodeSvc.resolveAddress  = async () => ({ status: geocodeSvc.OUTCOME.DISABLED, result: null });
  geocodeSvc.geocode         = async () => null;
  geocodeSvc.search          = async () => [];
  weatherSvc.isEnabled       = () => false;
  weatherSvc.siteWeather     = async () => null;
  weatherSvc.timezoneFor     = async () => null;
  routingSvc.isEnabled       = () => false;
  routingSvc.route           = async () => null;
}
disableExternalServices();

const KYIV_RESULT = {
  display_name: 'Хрещатик, 22, Київ, 01001, Україна',
  latitude: 50.4498,
  longitude: 30.5231,
  precision: 'house',
  osm_type: 'way',
  osm_id: 123456,
  address: {
    country_code: 'UA',
    country: 'Україна',
    region: null,             // Kyiv has special status and returns no `state`
    city: 'Київ',
    address_line: 'Хрещатик, 22',
    postal_code: '01001',
  },
};

function enableGeocoder(result = KYIV_RESULT) {
  geocodeSvc.isEnabled      = () => true;
  geocodeSvc.resolveAddress = async () => ({ status: geocodeSvc.OUTCOME.OK, result });
}

function failGeocoder(status = geocodeSvc.OUTCOME.NO_MATCH) {
  geocodeSvc.isEnabled      = () => true;
  geocodeSvc.resolveAddress = async () => ({ status, result: null });
}

// ── App ───────────────────────────────────────────────────
// helpers/app.js hand-builds its own mount list and does not carry /api/sites,
// so this suite assembles the same chain around the sites router only.
const { authenticate } = require('../src/middleware/auth');
const createAuditMiddleware = require('../src/middleware/audit');

const silentLogger = pino({ level: 'silent' });

function createSitesApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', createAuditMiddleware(silentLogger));
  app.use('/api', authenticate);
  app.use('/api/sites', require('../src/routes/sites'));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });
  return app;
}

const app = createSitesApp();

// ── Local fixtures ────────────────────────────────────────
// sites / user_sites / weather_observations / site_public_links arrive with
// migration 021; helpers/factories.js is shared with every other suite, so the
// geo fixtures live here.

function rnd(n = 8) {
  return crypto.randomBytes(8).toString('hex').slice(0, n);
}

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city,
                        address_line, postal_code, latitude, longitude, geo_source, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      tenantId,
      overrides.name ?? `Site ${rnd()}`,
      overrides.country_code ?? null,
      overrides.country ?? null,
      overrides.region ?? null,
      overrides.city ?? null,
      overrides.address_line ?? null,
      overrides.postal_code ?? null,
      overrides.latitude ?? null,
      overrides.longitude ?? null,
      overrides.geo_source ?? (overrides.latitude != null ? 'manual' : 'none'),
      overrides.timezone ?? null,
    ]
  );
  return rows[0];
}

async function attachDevice(deviceId, siteId) {
  await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteId, deviceId]);
}

async function grantSite(userId, site, grantedBy) {
  await db.query(
    `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, site.id, site.tenant_id, grantedBy || null]
  );
}

async function grantDevice(userId, deviceId, grantedBy) {
  await db.query(
    `INSERT INTO user_devices (user_id, device_id, granted_by)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [userId, deviceId, grantedBy || null]
  );
}

async function createPublicLink(site, overrides = {}) {
  const raw  = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO site_public_links (tenant_id, site_id, token_hash, label, expires_at, revoked_at)
     VALUES ($1,$2,$3,$4, NOW() + ($5::int * INTERVAL '1 day'), $6) RETURNING *`,
    [site.tenant_id, site.id, hash, overrides.label ?? null, overrides.days ?? 30, overrides.revoked_at ?? null]
  );
  return { link: rows[0], token: raw };
}

async function setBase(user, latitude, longitude, address) {
  await db.query(
    'UPDATE users SET base_latitude = $1, base_longitude = $2, base_address = $3 WHERE id = $4',
    [latitude, longitude, address, user.id]
  );
}

/** The audit insert is fire-and-forget — give it a moment, then read it back. */
async function latestAudit(action) {
  await new Promise(r => setTimeout(r, 150));
  const { rows } = await db.query(
    `SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1`,
    [action]
  );
  return rows[0] || null;
}

async function siteRow(id) {
  const { rows } = await db.query('SELECT * FROM sites WHERE id = $1', [id]);
  return rows[0] || null;
}

// ══════════════════════════════════════════════════════════

describe('Sites API', () => {
  let tenantA, tenantB;
  let adminA, techA, viewerA, superadmin;
  let adminB;

  beforeAll(async () => {
    await cleanDatabase();

    tenantA = await createTenant({ slug: 'sites-a' });
    tenantB = await createTenant({ slug: 'sites-b' });

    adminA     = await createUser(tenantA.id, { role: 'admin',      email: 'admin@sites-a.test' });
    techA      = await createUser(tenantA.id, { role: 'technician', email: 'tech@sites-a.test' });
    viewerA    = await createUser(tenantA.id, { role: 'viewer',     email: 'viewer@sites-a.test' });
    superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'sa@sites-a.test' });
    adminB     = await createUser(tenantB.id, { role: 'admin',      email: 'admin@sites-b.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  beforeEach(async () => {
    disableExternalServices();
    // RBAC grants are per-test: no test may inherit visibility from the one before.
    await db.query('DELETE FROM user_devices WHERE user_id = $1', [techA.id]);
    await db.query('DELETE FROM user_sites   WHERE user_id = $1', [techA.id]);
  });

  // ── GET /api/sites ──────────────────────────────────────
  describe('GET /api/sites', () => {
    it('lists the tenant sites with device / online / alarm counts', async () => {
      const site = await createSite(tenantA.id, { name: `АТБ ${rnd()}`, city: 'Київ' });
      const d1 = await createDevice(tenantA.id, { name: 'Cabinet 1' });
      const d2 = await createDevice(tenantA.id, { name: 'Cabinet 2' });
      await attachDevice(d1.id, site.id);
      await attachDevice(d2.id, site.id);
      await db.query('UPDATE devices SET online = true WHERE id = $1', [d1.id]);
      await db.query(
        `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active)
         VALUES ($1, $2, 'temp_high', 'critical', true)`,
        [tenantA.id, d2.mqtt_device_id]
      );

      const res = await request(app).get('/api/sites').set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      const found = res.body.data.find(s => s.id === site.id);
      expect(found).toBeDefined();
      expect(found.device_count).toBe(2);
      expect(found.online_count).toBe(1);
      expect(found.alarm_count).toBe(1);
      expect(found.city).toBe('Київ');
    });

    it('filters by search, city and country_code', async () => {
      const marker = rnd(6);
      await createSite(tenantA.id, { name: `Сільпо ${marker}`, city: 'Львів', country_code: 'UA' });
      await createSite(tenantA.id, { name: `Other ${rnd()}`, city: 'Одеса', country_code: 'PL' });

      const bySearch = await request(app)
        .get(`/api/sites?search=${marker}`).set(authHeader(adminA, tenantA.id));
      expect(bySearch.status).toBe(200);
      expect(bySearch.body.data).toHaveLength(1);
      expect(bySearch.body.data[0].name).toContain(marker);

      const byCity = await request(app)
        .get('/api/sites?city=Львів').set(authHeader(adminA, tenantA.id));
      expect(byCity.status).toBe(200);
      expect(byCity.body.data.every(s => s.city === 'Львів')).toBe(true);

      const byCountry = await request(app)
        .get('/api/sites?country_code=pl').set(authHeader(adminA, tenantA.id));
      expect(byCountry.status).toBe(200);
      expect(byCountry.body.data.length).toBeGreaterThan(0);
      expect(byCountry.body.data.every(s => s.country_code === 'PL')).toBe(true);
    });

    it('LIKE wildcards in ?search= are escaped, not interpreted', async () => {
      await createSite(tenantA.id, { name: `Percent ${rnd()}` });
      const res = await request(app).get('/api/sites?search=%25').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('CROSS-TENANT: never returns another tenant\'s sites', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign ${rnd()}` });

      const res = await request(app).get('/api/sites').set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.some(s => s.id === foreign.id)).toBe(false);
      expect(res.body.data.every(s => s.tenant_id === tenantA.id)).toBe(true);
    });

    it('superadmin sees every tenant and can scope with ?tenant_id', async () => {
      const foreign = await createSite(tenantB.id, { name: `SA visible ${rnd()}` });

      const all = await request(app).get('/api/sites').set(authHeader(superadmin, tenantA.id));
      expect(all.status).toBe(200);
      expect(all.body.data.some(s => s.id === foreign.id)).toBe(true);

      const scoped = await request(app)
        .get(`/api/sites?tenant_id=${tenantB.id}`).set(authHeader(superadmin, tenantA.id));
      expect(scoped.status).toBe(200);
      expect(scoped.body.data.every(s => s.tenant_id === tenantB.id)).toBe(true);
    });

    it('rejects a malformed ?tenant_id with 400, never 500', async () => {
      const res = await request(app)
        .get('/api/sites?tenant_id=notauuid').set(authHeader(superadmin, tenantA.id));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('RBAC: a technician sees only sites where a granted device lives', async () => {
      const visible = await createSite(tenantA.id, { name: `Visible ${rnd()}` });
      const hidden  = await createSite(tenantA.id, { name: `Hidden ${rnd()}` });
      const dv = await createDevice(tenantA.id);
      const dh = await createDevice(tenantA.id);
      await attachDevice(dv.id, visible.id);
      await attachDevice(dh.id, hidden.id);
      await grantDevice(techA.id, dv.id, adminA.id);

      const res = await request(app).get('/api/sites').set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(200);
      const ids = res.body.data.map(s => s.id);
      expect(ids).toContain(visible.id);
      expect(ids).not.toContain(hidden.id);

      const shown = res.body.data.find(s => s.id === visible.id);
      expect(shown.device_count).toBe(1);   // counted over the visible subset only

      await db.query('DELETE FROM user_devices WHERE user_id = $1', [techA.id]);
    });

    it('RBAC: a bare user_sites grant makes a device-less site visible', async () => {
      const granted = await createSite(tenantA.id, { name: `Granted ${rnd()}` });
      await grantSite(techA.id, granted, adminA.id);

      const res = await request(app).get('/api/sites').set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.map(s => s.id)).toContain(granted.id);

      await db.query('DELETE FROM user_sites WHERE user_id = $1', [techA.id]);
    });

    it('RBAC: a user with no grants at all sees nothing', async () => {
      await createSite(tenantA.id, { name: `Unreachable ${rnd()}` });
      const res = await request(app).get('/api/sites').set(authHeader(viewerA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  // ── POST /api/sites ─────────────────────────────────────
  describe('POST /api/sites', () => {
    it('creates a site and writes an audit row', async () => {
      const name = `Новий ${rnd()}`;
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name, city: 'Київ', country_code: 'ua', address_line: 'Хрещатик, 22' });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe(name);
      expect(res.body.data.tenant_id).toBe(tenantA.id);
      expect(res.body.data.country_code).toBe('UA');
      expect(res.body.data.geo_source).toBe('none');   // geocoder disabled

      const audit = await latestAudit('site.create');
      expect(audit).not.toBeNull();
      expect(audit.entity_id).toBe(res.body.data.id);
      expect(audit.changes.after.name).toBe(name);
    });

    it('accepts an explicit pin and marks it geo_source=manual', async () => {
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Pinned ${rnd()}`, latitude: 49.8397, longitude: 24.0297 });

      expect(res.status).toBe(201);
      expect(res.body.data.latitude).toBe(49.8397);
      expect(res.body.data.geo_source).toBe('manual');
    });

    it('rejects half a pin', async () => {
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Half ${rnd()}`, latitude: 50.4 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('rejects out-of-range coordinates and a missing name', async () => {
      const bad = await request(app)
        .post('/api/sites').set(authHeader(adminA, tenantA.id))
        .send({ name: `Bad ${rnd()}`, latitude: 91, longitude: 30 });
      expect(bad.status).toBe(400);

      const noName = await request(app)
        .post('/api/sites').set(authHeader(adminA, tenantA.id)).send({ city: 'Київ' });
      expect(noName.status).toBe(400);
    });

    it('geocodes inline when an address is given and no pin', async () => {
      enableGeocoder();
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Geo ${rnd()}`, address_line: 'Хрещатик, 22', city: 'Київ', country_code: 'UA' });

      expect(res.status).toBe(201);
      expect(res.body.meta.geocoder).toBe('ok');
      expect(res.body.data.latitude).toBe(50.4498);
      expect(res.body.data.longitude).toBe(30.5231);
      expect(res.body.data.geo_source).toBe('geocoded');
      expect(res.body.data.geo_precision).toBe('house');
      // Kyiv returns no `state`: it groups under its own name instead of NULL.
      expect(res.body.data.region).toBe('Київ');
    });

    it('never stores coordinates that contradict the requested country', async () => {
      enableGeocoder({ ...KYIV_RESULT, address: { ...KYIV_RESULT.address, country_code: 'FR', country: 'France' } });

      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Mismatch ${rnd()}`, address_line: 'Хрещатик, 22', city: 'Київ', country_code: 'UA' });

      expect(res.status).toBe(201);
      expect(res.body.meta.geocoder).toBe('failed');
      expect(res.body.data.latitude).toBeNull();
      expect(res.body.data.geo_source).toBe('none');
      expect(res.body.data.geo_error).toContain('country_mismatch');
    });

    it('a geocoder failure never blocks the creation', async () => {
      failGeocoder(geocodeSvc.OUTCOME.FAILED);
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Outage ${rnd()}`, city: 'Львів' });

      expect(res.status).toBe(201);
      expect(res.body.data.latitude).toBeNull();
      expect(res.body.data.geo_attempts).toBe(1);
    });

    it('fills sites.timezone from the weather provider when it is enabled', async () => {
      weatherSvc.isEnabled   = () => true;
      weatherSvc.timezoneFor = async () => 'Europe/Kyiv';

      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `TZ ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });

      expect(res.status).toBe(201);
      expect(res.body.data.timezone).toBe('Europe/Kyiv');
    });

    it('duplicate name in the same tenant is a 409, case- and space-insensitive', async () => {
      // ASCII on purpose: uq_sites_tenant_name folds case with lower(), whose
      // behaviour for Cyrillic depends on the database collation.
      const name = `Duplicate ${rnd()}`;
      const first = await request(app)
        .post('/api/sites').set(authHeader(adminA, tenantA.id)).send({ name });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/api/sites').set(authHeader(adminA, tenantA.id)).send({ name: `  ${name.toUpperCase()}  ` });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('conflict');
    });

    it('the same name in another tenant is fine', async () => {
      const name = `Shared name ${rnd()}`;
      const a = await request(app).post('/api/sites').set(authHeader(adminA, tenantA.id)).send({ name });
      const b = await request(app).post('/api/sites').set(authHeader(adminB, tenantB.id)).send({ name });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('CROSS-TENANT: a tenant admin cannot create a site in another tenant', async () => {
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Injected ${rnd()}`, tenant_id: tenantB.id });

      expect(res.status).toBe(201);
      expect(res.body.data.tenant_id).toBe(tenantA.id);   // the field is ignored, not honoured
    });

    it('superadmin may create in another tenant with tenant_id', async () => {
      const res = await request(app)
        .post('/api/sites')
        .set(authHeader(superadmin, tenantA.id))
        .send({ name: `SA created ${rnd()}`, tenant_id: tenantB.id });

      expect(res.status).toBe(201);
      expect(res.body.data.tenant_id).toBe(tenantB.id);
    });

    it('technician and viewer cannot create sites', async () => {
      for (const user of [techA, viewerA]) {
        const res = await request(app)
          .post('/api/sites').set(authHeader(user, tenantA.id)).send({ name: `Nope ${rnd()}` });
        expect(res.status).toBe(403);
      }
    });
  });

  // ── GET /api/sites/:id ──────────────────────────────────
  describe('GET /api/sites/:id', () => {
    it('returns the site with its devices', async () => {
      const site = await createSite(tenantA.id, { name: `Detail ${rnd()}`, city: 'Одеса' });
      const dev  = await createDevice(tenantA.id, { name: 'Ларь 1' });
      await attachDevice(dev.id, site.id);

      const res = await request(app)
        .get(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(site.id);
      expect(res.body.data.devices).toHaveLength(1);
      expect(res.body.data.devices[0].mqtt_device_id).toBe(dev.mqtt_device_id);
      expect(res.body.data.device_count).toBe(1);
    });

    it('reports an active alarm on one of its devices', async () => {
      const site = await createSite(tenantA.id, { name: `Alarming ${rnd()}` });
      const dev  = await createDevice(tenantA.id);
      await attachDevice(dev.id, site.id);
      await db.query(
        `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active)
         VALUES ($1, $2, 'door_open', 'warning', true)`,
        [tenantA.id, dev.mqtt_device_id]
      );

      const res = await request(app)
        .get(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.devices[0].alarm_active).toBe(true);
      expect(res.body.data.alarm_count).toBe(1);
    });

    it('a malformed id is a 404, never a 500', async () => {
      const res = await request(app).get('/api/sites/notauuid').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('CROSS-TENANT: another tenant\'s site is a 404', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign detail ${rnd()}` });
      const res = await request(app)
        .get(`/api/sites/${foreign.id}`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('superadmin may read a site in any tenant', async () => {
      const foreign = await createSite(tenantB.id, { name: `SA detail ${rnd()}` });
      const res = await request(app)
        .get(`/api/sites/${foreign.id}`).set(authHeader(superadmin, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data.tenant_id).toBe(tenantB.id);
    });

    it('RBAC: a technician sees only the devices they were granted', async () => {
      const site = await createSite(tenantA.id, { name: `Partial ${rnd()}` });
      const mine  = await createDevice(tenantA.id, { name: 'Mine' });
      const other = await createDevice(tenantA.id, { name: 'Not mine' });
      await attachDevice(mine.id, site.id);
      await attachDevice(other.id, site.id);
      await grantDevice(techA.id, mine.id, adminA.id);

      const res = await request(app)
        .get(`/api/sites/${site.id}`).set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.devices).toHaveLength(1);
      expect(res.body.data.devices[0].id).toBe(mine.id);

      await db.query('DELETE FROM user_devices WHERE user_id = $1', [techA.id]);
    });

    it('RBAC: a site the caller has no relation to is a 404, not an empty list', async () => {
      const site = await createSite(tenantA.id, { name: `Opaque ${rnd()}` });
      const dev  = await createDevice(tenantA.id);
      await attachDevice(dev.id, site.id);

      const res = await request(app)
        .get(`/api/sites/${site.id}`).set(authHeader(viewerA, tenantA.id));

      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/sites/:id ────────────────────────────────
  describe('PATCH /api/sites/:id', () => {
    it('updates fields, bumps updated_at and writes an audit row', async () => {
      const site = await createSite(tenantA.id, { name: `Patch ${rnd()}`, city: 'Київ' });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ city: 'Львів', notes: 'Переїхали' });

      expect(res.status).toBe(200);
      expect(res.body.data.city).toBe('Львів');
      expect(res.body.data.notes).toBe('Переїхали');

      const after = await siteRow(site.id);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(site.updated_at).getTime());

      const audit = await latestAudit('site.update');
      expect(audit).not.toBeNull();
      expect(audit.entity_id).toBe(site.id);
      expect(audit.changes.before.city).toBe('Київ');
      expect(audit.changes.after.city).toBe('Львів');
    });

    it('an empty body is rejected', async () => {
      const site = await createSite(tenantA.id, { name: `Empty patch ${rnd()}` });
      const res = await request(app)
        .patch(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id)).send({});
      expect(res.status).toBe(400);
    });

    it('server-owned columns cannot be written through the body', async () => {
      const site = await createSite(tenantA.id, { name: `Immutable ${rnd()}` });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ name: `Renamed ${rnd()}`, tenant_id: tenantB.id, geo_source: 'geocoded', id: crypto.randomUUID() });

      expect(res.status).toBe(200);
      const after = await siteRow(site.id);
      expect(after.tenant_id).toBe(tenantA.id);
      expect(after.geo_source).toBe('none');
      expect(after.id).toBe(site.id);
    });

    it('a manual pin clears the OSM provenance it no longer describes', async () => {
      const site = await createSite(tenantA.id, { name: `Repin ${rnd()}` });
      await db.query(
        `UPDATE sites SET latitude = 50.0, longitude = 30.0, geo_source = 'geocoded',
                          geo_precision = 'house', osm_type = 'way', osm_id = 42, geocoded_at = NOW()
          WHERE id = $1`, [site.id]
      );

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ latitude: 49.8397, longitude: 24.0297 });

      expect(res.status).toBe(200);
      expect(res.body.data.geo_source).toBe('manual');
      expect(res.body.data.osm_id).toBeNull();
      expect(res.body.data.osm_type).toBeNull();
      expect(res.body.data.geo_precision).toBeNull();
    });

    it('clearing both coordinates resets geo_source to none', async () => {
      const site = await createSite(tenantA.id, { name: `Unpin ${rnd()}`, latitude: 50.0, longitude: 30.0 });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ latitude: null, longitude: null });

      expect(res.status).toBe(200);
      expect(res.body.data.latitude).toBeNull();
      expect(res.body.data.geo_source).toBe('none');
    });

    it('an address change with the geocoder DISABLED keeps the existing coordinates', async () => {
      const site = await createSite(tenantA.id, {
        name: `Typo fix ${rnd()}`, city: 'Київ', address_line: 'Хрещатик, 2',
        latitude: 50.4498, longitude: 30.5231, geo_source: 'geocoded',
      });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ address_line: 'Хрещатик, 22' });

      expect(res.status).toBe(200);
      expect(res.body.meta.geocoder).toBe('disabled');
      expect(res.body.data.latitude).toBe(50.4498);
      expect(res.body.data.longitude).toBe(30.5231);
      expect(res.body.data.geo_source).toBe('geocoded');
    });

    it('an address change with a FAILING geocoder keeps the coordinates and counts the attempt', async () => {
      failGeocoder(geocodeSvc.OUTCOME.FAILED);
      const site = await createSite(tenantA.id, {
        name: `Outage patch ${rnd()}`, city: 'Київ',
        latitude: 50.4498, longitude: 30.5231, geo_source: 'geocoded',
      });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ address_line: 'Хрещатик, 22' });

      expect(res.status).toBe(200);
      expect(res.body.data.latitude).toBe(50.4498);
      expect(res.body.data.geo_source).toBe('geocoded');   // never demoted to 'failed'
      expect(res.body.data.geo_attempts).toBe(1);
      expect(res.body.data.geo_error).toBe('provider_error');   // an outage, not a bad address
    });

    it('an address change with a WORKING geocoder repositions the site', async () => {
      enableGeocoder();
      const site = await createSite(tenantA.id, { name: `Move ${rnd()}`, city: 'Львів' });

      const res = await request(app)
        .patch(`/api/sites/${site.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ city: 'Київ', address_line: 'Хрещатик, 22' });

      expect(res.status).toBe(200);
      expect(res.body.meta.geocoder).toBe('ok');
      expect(res.body.data.latitude).toBe(50.4498);
      expect(res.body.data.geo_source).toBe('geocoded');
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app)
        .patch('/api/sites/notauuid').set(authHeader(adminA, tenantA.id)).send({ city: 'Київ' });
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: another tenant\'s site cannot be patched', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign patch ${rnd()}`, city: 'Brno' });

      const res = await request(app)
        .patch(`/api/sites/${foreign.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ city: 'Hijacked' });

      expect(res.status).toBe(404);
      const after = await siteRow(foreign.id);
      expect(after.city).toBe('Brno');
    });

    it('technician cannot patch a site', async () => {
      const site = await createSite(tenantA.id, { name: `Tech patch ${rnd()}` });
      const res = await request(app)
        .patch(`/api/sites/${site.id}`).set(authHeader(techA, tenantA.id)).send({ city: 'Київ' });
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /api/sites/:id ───────────────────────────────
  describe('DELETE /api/sites/:id', () => {
    it('deletes an empty site and audits it', async () => {
      const site = await createSite(tenantA.id, { name: `Doomed ${rnd()}` });

      const res = await request(app)
        .delete(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(await siteRow(site.id)).toBeNull();

      const audit = await latestAudit('site.delete');
      expect(audit).not.toBeNull();
      expect(audit.entity_id).toBe(site.id);
      expect(audit.changes.force).toBe(false);
    });

    it('409 site_has_devices while devices are attached', async () => {
      const site = await createSite(tenantA.id, { name: `Occupied ${rnd()}` });
      const dev  = await createDevice(tenantA.id);
      await attachDevice(dev.id, site.id);

      const res = await request(app)
        .delete(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('site_has_devices');
      expect(res.body.device_count).toBe(1);
      expect(await siteRow(site.id)).not.toBeNull();
    });

    it('?force=false is NOT truthy', async () => {
      const site = await createSite(tenantA.id, { name: `Force false ${rnd()}` });
      const dev  = await createDevice(tenantA.id);
      await attachDevice(dev.id, site.id);

      const res = await request(app)
        .delete(`/api/sites/${site.id}?force=false`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(409);
    });

    it('?force=true detaches the devices and records which ones', async () => {
      const site = await createSite(tenantA.id, { name: `Forced ${rnd()}` });
      const dev  = await createDevice(tenantA.id);
      await attachDevice(dev.id, site.id);

      const res = await request(app)
        .delete(`/api/sites/${site.id}?force=true`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.detached_devices).toBe(1);
      expect(await siteRow(site.id)).toBeNull();

      const { rows } = await db.query('SELECT site_id FROM devices WHERE id = $1', [dev.id]);
      expect(rows[0].site_id).toBeNull();

      const audit = await latestAudit('site.delete');
      expect(audit.changes.force).toBe(true);
      expect(audit.changes.detached_device_ids).toEqual([dev.id]);
    });

    it('deleting a site takes its public links and grants with it', async () => {
      const site = await createSite(tenantA.id, { name: `Cascade ${rnd()}` });
      await createPublicLink(site);
      await grantSite(techA.id, site, adminA.id);

      const res = await request(app)
        .delete(`/api/sites/${site.id}`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);

      const links  = await db.query('SELECT 1 FROM site_public_links WHERE site_id = $1', [site.id]);
      const grants = await db.query('SELECT 1 FROM user_sites WHERE site_id = $1', [site.id]);
      expect(links.rows).toHaveLength(0);
      expect(grants.rows).toHaveLength(0);
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app).delete('/api/sites/notauuid').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: another tenant\'s site cannot be deleted', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign delete ${rnd()}` });

      const res = await request(app)
        .delete(`/api/sites/${foreign.id}?force=true`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
      expect(await siteRow(foreign.id)).not.toBeNull();
    });

    it('technician cannot delete a site', async () => {
      const site = await createSite(tenantA.id, { name: `Tech delete ${rnd()}` });
      const res = await request(app)
        .delete(`/api/sites/${site.id}`).set(authHeader(techA, tenantA.id));
      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/sites/:id/geocode ─────────────────────────
  describe('POST /api/sites/:id/geocode', () => {
    it('reports meta.geocoder=disabled instead of no-oping', async () => {
      const site = await createSite(tenantA.id, { name: `Disabled geo ${rnd()}`, city: 'Київ' });

      const res = await request(app)
        .post(`/api/sites/${site.id}/geocode`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.meta.geocoder).toBe('disabled');
      expect(res.body.data.id).toBe(site.id);
    });

    it('geocodes and audits the move', async () => {
      enableGeocoder();
      const site = await createSite(tenantA.id, { name: `Force geo ${rnd()}`, city: 'Київ', address_line: 'Хрещатик, 22' });

      const res = await request(app)
        .post(`/api/sites/${site.id}/geocode`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.meta.geocoder).toBe('ok');
      expect(res.body.data.latitude).toBe(50.4498);
      expect(res.body.data.geo_source).toBe('geocoded');

      const audit = await latestAudit('site.geocode');
      expect(audit).not.toBeNull();
      expect(audit.entity_id).toBe(site.id);
    });

    it('a site with no address at all is reported, not attempted', async () => {
      enableGeocoder();
      const site = await createSite(tenantA.id, { name: `No address ${rnd()}` });

      const res = await request(app)
        .post(`/api/sites/${site.id}/geocode`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.meta.geocoder).toBe('failed');
      expect(res.body.meta.reason).toBe('no_address');
    });

    it('three failures park the site as geo_source=failed', async () => {
      failGeocoder(geocodeSvc.OUTCOME.NO_MATCH);
      const site = await createSite(tenantA.id, { name: `Hopeless ${rnd()}`, city: 'Нідевіль' });

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post(`/api/sites/${site.id}/geocode`).set(authHeader(adminA, tenantA.id));
        expect(res.status).toBe(200);
      }

      const after = await siteRow(site.id);
      expect(after.geo_attempts).toBe(3);
      expect(after.geo_source).toBe('failed');
      expect(after.latitude).toBeNull();
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app)
        .post('/api/sites/notauuid/geocode').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: another tenant\'s site cannot be geocoded', async () => {
      enableGeocoder();
      const foreign = await createSite(tenantB.id, { name: `Foreign geo ${rnd()}`, city: 'Brno' });

      const res = await request(app)
        .post(`/api/sites/${foreign.id}/geocode`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
      const after = await siteRow(foreign.id);
      expect(after.latitude).toBeNull();
    });

    it('technician cannot force a geocode', async () => {
      const site = await createSite(tenantA.id, { name: `Tech geo ${rnd()}` });
      const res = await request(app)
        .post(`/api/sites/${site.id}/geocode`).set(authHeader(techA, tenantA.id));
      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/sites/:id/weather ──────────────────────────
  describe('GET /api/sites/:id/weather', () => {
    it('degrades to { data: null } when the provider is disabled', async () => {
      const site = await createSite(tenantA.id, { name: `No weather ${rnd()}`, latitude: 50.4, longitude: 30.5 });

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(res.body.meta.weather).toBe('disabled');
    });

    it('reports no_coordinates for a site that was never located', async () => {
      weatherSvc.isEnabled = () => true;
      const site = await createSite(tenantA.id, { name: `Unlocated ${rnd()}` });

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(res.body.meta.weather).toBe('no_coordinates');
    });

    it('returns current + forecast + timezone', async () => {
      weatherSvc.isEnabled = () => true;
      weatherSvc.siteWeather = async () => ({
        current: { observed_at: '2026-08-23T10:00:00.000Z', temp_c: 27.4, humidity: 41 },
        forecast: [{ time: '2026-08-23T11:00:00.000Z', temp_c: 28.1 }],
        timezone: 'Europe/Kyiv',
      });
      const site = await createSite(tenantA.id, { name: `Weather ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.current.temp_c).toBe(27.4);
      expect(res.body.data.forecast).toHaveLength(1);
      expect(res.body.data.timezone).toBe('Europe/Kyiv');
    });

    it('rejects an out-of-range ?hours with 400, never 500', async () => {
      weatherSvc.isEnabled = () => true;
      const site = await createSite(tenantA.id, { name: `Hours ${rnd()}`, latitude: 50.4, longitude: 30.5 });

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather?hours=999`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app)
        .get('/api/sites/notauuid/weather').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: another tenant\'s site weather is a 404', async () => {
      weatherSvc.isEnabled = () => true;
      const foreign = await createSite(tenantB.id, { name: `Foreign weather ${rnd()}`, latitude: 49.2, longitude: 16.6 });

      const res = await request(app)
        .get(`/api/sites/${foreign.id}/weather`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/sites/:id/weather/history ──────────────────
  describe('GET /api/sites/:id/weather/history', () => {
    async function seedObservation(site, isoTime, temp) {
      await db.query(
        `INSERT INTO weather_observations (site_id, tenant_id, observed_at, temp_c, humidity)
         VALUES ($1, $2, $3::timestamptz, $4, $5) ON CONFLICT DO NOTHING`,
        [site.id, site.tenant_id, isoTime, temp, 55]
      );
    }

    it('returns observations in the range as numbers', async () => {
      const site = await createSite(tenantA.id, { name: `History ${rnd()}`, latitude: 50.4, longitude: 30.5 });
      const now  = new Date();
      await seedObservation(site, new Date(now.getTime() - 3600000).toISOString(), -2.5);
      await seedObservation(site, new Date(now.getTime() - 7200000).toISOString(), -3.5);

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather/history`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(typeof res.body.data[0].temp_c).toBe('number');
      expect(res.body.data[0].temp_c).toBe(-3.5);   // ordered oldest first
    });

    it('honours ?from / ?to', async () => {
      const site = await createSite(tenantA.id, { name: `Ranged ${rnd()}`, latitude: 50.4, longitude: 30.5 });
      const now  = new Date();
      const old  = new Date(now.getTime() - 30 * 86400000);
      await seedObservation(site, old.toISOString(), 10);
      await seedObservation(site, new Date(now.getTime() - 3600000).toISOString(), 20);

      const res = await request(app)
        .get(`/api/sites/${site.id}/weather/history?from=${new Date(now.getTime() - 86400000).toISOString()}`)
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].temp_c).toBe(20);
    });

    it('a bad date is a 400, never a 500', async () => {
      const site = await createSite(tenantA.id, { name: `Bad date ${rnd()}` });
      const res = await request(app)
        .get(`/api/sites/${site.id}/weather/history?from=notadate`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app)
        .get('/api/sites/notauuid/weather/history').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: another tenant\'s observations are never returned', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign history ${rnd()}` });
      await seedObservation(foreign, new Date().toISOString(), 15);

      const res = await request(app)
        .get(`/api/sites/${foreign.id}/weather/history`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/sites/:id/nearest-technicians ──────────────
  describe('GET /api/sites/:id/nearest-technicians', () => {
    let nearTech, farTech, inactiveTech, foreignTech;

    beforeAll(async () => {
      nearTech     = await createUser(tenantA.id, { role: 'technician', email: 'near@sites-a.test' });
      farTech      = await createUser(tenantA.id, { role: 'technician', email: 'far@sites-a.test' });
      inactiveTech = await createUser(tenantA.id, { role: 'technician', email: 'off@sites-a.test', active: false });
      foreignTech  = await createUser(tenantB.id, { role: 'technician', email: 'near@sites-b.test' });

      await setBase(nearTech, 50.45, 30.52, 'Київ, Хрещатик 1');
      await setBase(farTech, 49.84, 24.03, 'Львів, Свободи 28');
      await setBase(inactiveTech, 50.46, 30.53, 'Київ, поруч');
      await setBase(foreignTech, 50.44, 30.51, 'Київ, чужий тенант');
    });

    it('returns EXACTLY the five allowed fields, closest first', async () => {
      const site = await createSite(tenantA.id, {
        name: `Kyiv site ${rnd()}`, latitude: 50.4498, longitude: 30.5231,
      });

      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0].email).toBe(nearTech.email);
      expect(res.body.data[0].distance_km).toBeLessThan(5);

      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual(
          ['base_address', 'distance_km', 'duration_s', 'email', 'id'].sort()
        );
      }
      expect(res.body.data[0].duration_s).toBeNull();   // OSRM disabled
    });

    it('omits inactive staff and staff without a base', async () => {
      const site = await createSite(tenantA.id, { name: `Roster ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });

      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians?limit=50`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      const emails = res.body.data.map(r => r.email);
      expect(emails).not.toContain(inactiveTech.email);
      expect(emails).not.toContain(viewerA.email);
    });

    it('enriches the closest few with a real driving duration when OSRM is up', async () => {
      routingSvc.isEnabled = () => true;
      routingSvc.route     = async () => ({ total_distance_m: 4200, total_duration_s: 640 });

      const site = await createSite(tenantA.id, { name: `Routed ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data[0].duration_s).toBe(640);
      expect(res.body.meta.routing).toBe('osrm');
    });

    it('an OSRM outage degrades to distance-only, never a 500', async () => {
      routingSvc.isEnabled = () => true;
      routingSvc.route     = async () => { throw new Error('ECONNREFUSED'); };

      const site = await createSite(tenantA.id, { name: `Osrm down ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data[0].duration_s).toBeNull();
    });

    it('a technician caller gets a masked label, no home address and a coarse distance', async () => {
      const site = await createSite(tenantA.id, { name: `Masked ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });
      // The caller must be entitled to the site itself — see the 404 case below.
      await grantSite(techA.id, site, adminA.id);

      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data[0].email).not.toBe(nearTech.email);
      expect(res.body.data[0].email).toMatch(/^.\*\*\*@/);
      expect(res.body.data[0].base_address).toBeNull();
      // Whole kilometres, not 0.1: three 0.1 km readings from sites the caller
      // serves would trilaterate the colleague's home base to about 100 m.
      const km = res.body.data[0].distance_km;
      expect(typeof km).toBe('number');
      expect(Number.isInteger(km)).toBe(true);
    });

    it('a technician with no claim on the site gets a 404, not the roster', async () => {
      const site = await createSite(tenantA.id, { name: `Unclaimed ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });
      // No user_sites grant and no visible device on the site: the same 404
      // GET /api/sites/:id gives, so this endpoint is not a site-existence oracle
      // and cannot be used to triangulate a colleague's base from arbitrary pins.
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('a viewer cannot enumerate the roster', async () => {
      const site = await createSite(tenantA.id, { name: `Viewer roster ${rnd()}`, latitude: 50.4, longitude: 30.5 });
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(viewerA, tenantA.id));
      expect(res.status).toBe(403);
    });

    it('an unlocated site returns an empty list with a reason', async () => {
      const site = await createSite(tenantA.id, { name: `No pin roster ${rnd()}` });
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.reason).toBe('site_has_no_coordinates');
    });

    it('rejects an out-of-range ?limit with 400', async () => {
      const site = await createSite(tenantA.id, { name: `Limit ${rnd()}`, latitude: 50.4, longitude: 30.5 });
      const res = await request(app)
        .get(`/api/sites/${site.id}/nearest-technicians?limit=999`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(400);
    });

    it('a malformed id is a 404', async () => {
      const res = await request(app)
        .get('/api/sites/notauuid/nearest-technicians').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(404);
    });

    it('CROSS-TENANT: a site in another tenant is a 404, and its staff never leak', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign roster ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });

      const denied = await request(app)
        .get(`/api/sites/${foreign.id}/nearest-technicians`).set(authHeader(adminA, tenantA.id));
      expect(denied.status).toBe(404);

      // …and tenant B's technician never appears for a tenant A site, even though
      // their home base is the closest one to it.
      const own = await createSite(tenantA.id, { name: `Own roster ${rnd()}`, latitude: 50.4498, longitude: 30.5231 });
      const res = await request(app)
        .get(`/api/sites/${own.id}/nearest-technicians?limit=50`).set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data.map(r => r.email)).not.toContain(foreignTech.email);
    });
  });

  // ── Public links ────────────────────────────────────────
  describe('Public link management', () => {
    it('returns the raw token exactly once and stores only its sha256', async () => {
      const site = await createSite(tenantA.id, { name: `Shared ${rnd()}` });

      const created = await request(app)
        .post(`/api/sites/${site.id}/public-links`)
        .set(authHeader(adminA, tenantA.id))
        .send({ label: 'Вітрина' });

      expect(created.status).toBe(201);
      const token = created.body.data.token;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThanOrEqual(40);
      expect(created.body.data.label).toBe('Вітрина');

      const { rows } = await db.query(
        'SELECT token_hash FROM site_public_links WHERE id = $1', [created.body.data.id]
      );
      expect(rows[0].token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
      expect(rows[0].token_hash).not.toBe(token);

      // The token is never served again.
      const listed = await request(app)
        .get(`/api/sites/${site.id}/public-links`).set(authHeader(adminA, tenantA.id));
      expect(listed.status).toBe(200);
      const row = listed.body.data.find(l => l.id === created.body.data.id);
      expect(row).toBeDefined();
      expect(row.token).toBeUndefined();
      expect(row.token_hash).toBeUndefined();
      expect(row.active).toBe(true);
    });

    it('never writes the raw token to audit_log', async () => {
      const site = await createSite(tenantA.id, { name: `Audited link ${rnd()}` });

      const created = await request(app)
        .post(`/api/sites/${site.id}/public-links`)
        .set(authHeader(adminA, tenantA.id))
        .send({ label: 'Публічна' });
      expect(created.status).toBe(201);
      const token = created.body.data.token;

      const audit = await latestAudit('site.public_links');
      expect(audit).not.toBeNull();
      expect(audit.changes.site_id).toBe(site.id);
      expect(audit.changes.label).toBe('Публічна');

      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS c FROM audit_log
          WHERE strpos(COALESCE(changes::text, '') || COALESCE(endpoint, ''), $1) > 0`,
        [token]
      );
      expect(rows[0].c).toBe(0);
    });

    it('expires in 90 days by default and honours expires_in_days', async () => {
      const site = await createSite(tenantA.id, { name: `Expiry ${rnd()}` });

      const def = await request(app)
        .post(`/api/sites/${site.id}/public-links`).set(authHeader(adminA, tenantA.id)).send({});
      expect(def.status).toBe(201);
      const days = (new Date(def.body.data.expires_at) - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);

      const short = await request(app)
        .post(`/api/sites/${site.id}/public-links`)
        .set(authHeader(adminA, tenantA.id)).send({ expires_in_days: 1 });
      expect(short.status).toBe(201);
      const shortDays = (new Date(short.body.data.expires_at) - Date.now()) / 86400000;
      expect(shortDays).toBeLessThan(1.01);
    });

    it('rejects an absurd expiry', async () => {
      const site = await createSite(tenantA.id, { name: `Forever ${rnd()}` });
      const res = await request(app)
        .post(`/api/sites/${site.id}/public-links`)
        .set(authHeader(adminA, tenantA.id)).send({ expires_in_days: 100000 });
      expect(res.status).toBe(400);
    });

    it('DELETE revokes the link and is idempotent', async () => {
      const site = await createSite(tenantA.id, { name: `Revoke ${rnd()}` });
      const { link } = await createPublicLink(site);

      const res = await request(app)
        .delete(`/api/sites/${site.id}/public-links/${link.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(true);

      const { rows } = await db.query('SELECT revoked_at FROM site_public_links WHERE id = $1', [link.id]);
      expect(rows[0].revoked_at).not.toBeNull();
      const firstRevokedAt = rows[0].revoked_at;

      const again = await request(app)
        .delete(`/api/sites/${site.id}/public-links/${link.id}`).set(authHeader(adminA, tenantA.id));
      expect(again.status).toBe(200);

      const { rows: after } = await db.query('SELECT revoked_at FROM site_public_links WHERE id = $1', [link.id]);
      expect(new Date(after[0].revoked_at).getTime()).toBe(new Date(firstRevokedAt).getTime());
    });

    it('a revoked link is listed as inactive', async () => {
      const site = await createSite(tenantA.id, { name: `Inactive ${rnd()}` });
      const { link } = await createPublicLink(site, { revoked_at: new Date() });

      const res = await request(app)
        .get(`/api/sites/${site.id}/public-links`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.find(l => l.id === link.id).active).toBe(false);
    });

    it('a malformed id or linkId is a 404', async () => {
      const site = await createSite(tenantA.id, { name: `Bad link id ${rnd()}` });
      expect((await request(app)
        .get('/api/sites/notauuid/public-links').set(authHeader(adminA, tenantA.id))).status).toBe(404);
      expect((await request(app)
        .post('/api/sites/notauuid/public-links').set(authHeader(adminA, tenantA.id)).send({})).status).toBe(404);
      expect((await request(app)
        .delete(`/api/sites/${site.id}/public-links/notauuid`).set(authHeader(adminA, tenantA.id))).status).toBe(404);
    });

    it('technician and viewer cannot manage public links', async () => {
      const site = await createSite(tenantA.id, { name: `No share ${rnd()}` });
      for (const user of [techA, viewerA]) {
        expect((await request(app)
          .get(`/api/sites/${site.id}/public-links`).set(authHeader(user, tenantA.id))).status).toBe(403);
        expect((await request(app)
          .post(`/api/sites/${site.id}/public-links`).set(authHeader(user, tenantA.id)).send({})).status).toBe(403);
      }
    });

    it('CROSS-TENANT: links of another tenant\'s site are invisible and unmanageable', async () => {
      const foreign = await createSite(tenantB.id, { name: `Foreign link ${rnd()}` });
      const { link } = await createPublicLink(foreign);

      const listed = await request(app)
        .get(`/api/sites/${foreign.id}/public-links`).set(authHeader(adminA, tenantA.id));
      expect(listed.status).toBe(404);

      const created = await request(app)
        .post(`/api/sites/${foreign.id}/public-links`).set(authHeader(adminA, tenantA.id)).send({});
      expect(created.status).toBe(404);

      const revoked = await request(app)
        .delete(`/api/sites/${foreign.id}/public-links/${link.id}`).set(authHeader(adminA, tenantA.id));
      expect(revoked.status).toBe(404);

      const { rows } = await db.query('SELECT revoked_at FROM site_public_links WHERE id = $1', [link.id]);
      expect(rows[0].revoked_at).toBeNull();
    });

    it('CROSS-TENANT: a link id from another site cannot be revoked through this one', async () => {
      const mine    = await createSite(tenantA.id, { name: `Mine link ${rnd()}` });
      const foreign = await createSite(tenantB.id, { name: `Their link ${rnd()}` });
      const { link } = await createPublicLink(foreign);

      const res = await request(app)
        .delete(`/api/sites/${mine.id}/public-links/${link.id}`).set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
      const { rows } = await db.query('SELECT revoked_at FROM site_public_links WHERE id = $1', [link.id]);
      expect(rows[0].revoked_at).toBeNull();
    });
  });

  // ── Geocode sweep + status ──────────────────────────────
  describe('Geocode pending / status', () => {
    it('GET /geocode-status counts pending, geocoded and failed', async () => {
      const tenant = await createTenant({ slug: `geo-status-${rnd(6)}` });
      const admin  = await createUser(tenant.id, { role: 'admin', email: `admin@${rnd(6)}.test` });

      await createSite(tenant.id, { name: 'Pending 1' });
      await createSite(tenant.id, { name: 'Pending 2' });
      const located = await createSite(tenant.id, { name: 'Located', latitude: 50.4, longitude: 30.5 });
      const broken  = await createSite(tenant.id, { name: 'Broken' });
      await db.query(`UPDATE sites SET geo_source = 'failed' WHERE id = $1`, [broken.id]);
      expect(located.geo_source).toBe('manual');

      const res = await request(app)
        .get('/api/sites/geocode-status').set(authHeader(admin, tenant.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ pending: 2, geocoded: 1, failed: 1 });
      expect(res.body.meta.geocoder_enabled).toBe(false);
      expect(res.body.meta.bulk_enabled).toBe(false);
    });

    it('CROSS-TENANT: geocode-status counts only the caller\'s tenant', async () => {
      const tenant = await createTenant({ slug: `geo-status-iso-${rnd(6)}` });
      const admin  = await createUser(tenant.id, { role: 'admin', email: `iso@${rnd(6)}.test` });
      await createSite(tenantB.id, { name: `Foreign pending ${rnd()}` });

      const res = await request(app)
        .get('/api/sites/geocode-status').set(authHeader(admin, tenant.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ pending: 0, geocoded: 0, failed: 0 });
    });

    it('POST /geocode-pending is a no-op while bulk geocoding is disabled', async () => {
      await createSite(tenantA.id, { name: `Bulk off ${rnd()}`, city: 'Київ' });

      const res = await request(app)
        .post('/api/sites/geocode-pending').set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ queued: 0, reason: 'bulk_disabled' });
    });

    it('queues and geocodes the tenant\'s pending sites when bulk is enabled', async () => {
      const tenant = await createTenant({ slug: `bulk-${rnd(6)}` });
      const admin  = await createUser(tenant.id, { role: 'admin', email: `bulk@${rnd(6)}.test` });
      const site   = await createSite(tenant.id, { name: 'Bulk target', city: 'Київ', address_line: 'Хрещатик, 22' });
      await createSite(tenant.id, { name: 'No address at all' });   // not geocodable — skipped

      enableGeocoder();
      geocodeSvc.isBulkEnabled = () => true;

      const res = await request(app)
        .post('/api/sites/geocode-pending').set(authHeader(admin, tenant.id));

      expect(res.status).toBe(200);
      expect(res.body.data.queued).toBe(1);

      // The sweep runs after the response; poll for its write.
      let updated = null;
      for (let i = 0; i < 40 && (!updated || updated.geo_source !== 'geocoded'); i++) {
        await new Promise(r => setTimeout(r, 50));
        updated = await siteRow(site.id);
      }
      expect(updated.geo_source).toBe('geocoded');
      expect(updated.latitude).toBe(50.4498);

      const audit = await latestAudit('site.geocode_pending');
      expect(audit).not.toBeNull();
      expect(audit.changes.queued).toBe(1);
    });

    it('CROSS-TENANT: a sweep never touches another tenant\'s sites', async () => {
      const tenant = await createTenant({ slug: `bulk-iso-${rnd(6)}` });
      const admin  = await createUser(tenant.id, { role: 'admin', email: `bulkiso@${rnd(6)}.test` });
      const foreign = await createSite(tenantB.id, { name: `Foreign bulk ${rnd()}`, city: 'Brno' });

      enableGeocoder();
      geocodeSvc.isBulkEnabled = () => true;

      const res = await request(app)
        .post('/api/sites/geocode-pending').set(authHeader(admin, tenant.id));

      expect(res.status).toBe(200);
      expect(res.body.data.queued).toBe(0);

      await new Promise(r => setTimeout(r, 200));
      const after = await siteRow(foreign.id);
      expect(after.geo_source).toBe('none');
      expect(after.latitude).toBeNull();
    });

    it('technician and viewer cannot reach the sweep or its status', async () => {
      for (const user of [techA, viewerA]) {
        expect((await request(app)
          .get('/api/sites/geocode-status').set(authHeader(user, tenantA.id))).status).toBe(403);
        expect((await request(app)
          .post('/api/sites/geocode-pending').set(authHeader(user, tenantA.id))).status).toBe(403);
      }
    });
  });

  // ── Auth ────────────────────────────────────────────────
  describe('Authentication', () => {
    it('every endpoint refuses an unauthenticated caller', async () => {
      const site = await createSite(tenantA.id, { name: `Anon ${rnd()}` });
      const calls = [
        request(app).get('/api/sites'),
        request(app).post('/api/sites').send({ name: 'x' }),
        request(app).get(`/api/sites/${site.id}`),
        request(app).patch(`/api/sites/${site.id}`).send({ city: 'x' }),
        request(app).delete(`/api/sites/${site.id}`),
        request(app).post(`/api/sites/${site.id}/geocode`),
        request(app).get(`/api/sites/${site.id}/weather`),
        request(app).get(`/api/sites/${site.id}/weather/history`),
        request(app).get(`/api/sites/${site.id}/nearest-technicians`),
        request(app).get(`/api/sites/${site.id}/public-links`),
        request(app).post(`/api/sites/${site.id}/public-links`).send({}),
        request(app).delete(`/api/sites/${site.id}/public-links/${crypto.randomUUID()}`),
        request(app).get('/api/sites/geocode-status'),
        request(app).post('/api/sites/geocode-pending'),
      ];

      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(401);
      }
    });
  });
});
