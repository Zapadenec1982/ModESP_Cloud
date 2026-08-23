'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const {
  createTenant, createUser, createDevice, grantDeviceAccess, authHeader,
} = require('./helpers/factories');

const app = createTestApp();

// ── Local factories ───────────────────────────────────────
// sites arrives with migration 021 and helpers/factories.js is shared with every
// other suite, so the fixtures for this file live here.

let mqttSeq = 0;
function nextMqttId() {
  // 6 hex chars, unique per test run — devices.mqtt_device_id is globally UNIQUE
  return `DE${(mqttSeq++).toString(16).toUpperCase().padStart(4, '0')}`;
}

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city, address_line,
                        latitude, longitude, geo_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      tenantId,
      overrides.name || `Site ${Math.random().toString(16).slice(2, 10)}`,
      overrides.country_code ?? null,
      overrides.country ?? null,
      overrides.region ?? null,
      overrides.city ?? null,
      overrides.address_line ?? null,
      overrides.latitude ?? null,
      overrides.longitude ?? null,
      overrides.geo_source || 'none',
    ]
  );
  return rows[0];
}

async function createPendingDevice(mqttId) {
  const { rows } = await db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online)
     VALUES ($1, $2, 'pending', false) RETURNING *`,
    [db.SYSTEM_TENANT_ID, mqttId]
  );
  return rows[0];
}

async function attachToSite(deviceId, siteId) {
  await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteId, deviceId]);
}

async function readDevice(deviceId) {
  const { rows } = await db.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
  return rows[0];
}

async function readSite(siteId) {
  const { rows } = await db.query('SELECT * FROM sites WHERE id = $1', [siteId]);
  return rows[0];
}

/** Build a CSV upload buffer from header + row arrays (RFC 4180 quoting). */
function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvBuffer(header, ...rows) {
  const lines = [header, ...rows].map(cols => cols.map(csvCell).join(','));
  return Buffer.from(lines.join('\n'), 'utf-8');
}

const SITE_KEYS = [
  'site_id', 'site_name', 'site_city', 'site_region',
  'site_country', 'site_latitude', 'site_longitude',
];

describe('Devices ↔ sites', () => {
  let tenantA, tenantB, admin, adminB, tech, siteKyiv, siteLviv, siteOther;

  beforeAll(async () => {
    await cleanDatabase();

    tenantA = await createTenant({ slug: 'dev-site-a' });
    tenantB = await createTenant({ slug: 'dev-site-b' });

    admin  = await createUser(tenantA.id, { role: 'admin', email: 'admin@dev-site.test' });
    adminB = await createUser(tenantB.id, { role: 'admin', email: 'admin-b@dev-site.test' });
    tech   = await createUser(tenantA.id, { role: 'technician', email: 'tech@dev-site.test' });

    siteKyiv = await createSite(tenantA.id, {
      name: 'АТБ №142', country_code: 'UA', country: 'Україна',
      region: 'Київ', city: 'Київ', address_line: 'вулиця Хрещатик, 22',
      latitude: 50.4498, longitude: 30.5231, geo_source: 'geocoded',
    });
    siteLviv = await createSite(tenantA.id, {
      name: 'Сільпо Львів', country_code: 'UA', country: 'Україна',
      region: 'Львівська область', city: 'Львів',
      latitude: 49.8440, longitude: 24.0262, geo_source: 'geocoded',
    });
    // Tenant B's site — must never be reachable from tenant A
    siteOther = await createSite(tenantB.id, { name: 'Foreign Site', city: 'Brno' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Read paths ──────────────────────────────────────────

  describe('GET /api/devices', () => {
    it('exposes site_id and the joined site columns', async () => {
      const device = await createDevice(tenantA.id, { name: 'Kyiv cabinet', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .get('/api/devices')
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      const found = res.body.data.find(d => d.id === device.id);
      expect(found).toBeDefined();
      expect(found.site_id).toBe(siteKyiv.id);
      expect(found.site_name).toBe('АТБ №142');
      expect(found.site_city).toBe('Київ');
      expect(found.site_region).toBe('Київ');
      expect(found.site_country).toBe('Україна');
      expect(found.site_latitude).toBe(50.4498);
      expect(found.site_longitude).toBe(30.5231);
    });

    it('returns the site keys as null for a device without a site', async () => {
      const device = await createDevice(tenantA.id, { name: 'Loose', mqttId: nextMqttId() });

      const res = await request(app)
        .get('/api/devices')
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      const found = res.body.data.find(d => d.id === device.id);
      expect(found).toBeDefined();
      for (const key of SITE_KEYS) {
        expect(found).toHaveProperty(key);
        expect(found[key]).toBeNull();
      }
    });

    // Regression for the "без координат" list on the fleet map: the device
    // coordinates must stay RAW, never COALESCE'd with the site's.
    it('does NOT fall back to the site coordinates for latitude/longitude', async () => {
      const device = await createDevice(tenantA.id, { name: 'No own coords', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .get('/api/devices')
        .set(authHeader(admin, tenantA.id));

      const found = res.body.data.find(d => d.id === device.id);
      expect(found.latitude).toBeNull();
      expect(found.longitude).toBeNull();
      expect(found.site_latitude).toBe(50.4498);
    });

    it('keeps the existing list fields intact', async () => {
      const device = await createDevice(tenantA.id, { name: 'Shape check', mqttId: nextMqttId() });

      const res = await request(app)
        .get('/api/devices')
        .set(authHeader(admin, tenantA.id));

      const found = res.body.data.find(d => d.id === device.id);
      for (const key of ['id', 'mqtt_device_id', 'name', 'location', 'serial_number', 'model',
        'comment', 'manufactured_at', 'firmware_version', 'online', 'status', 'last_seen',
        'created_at', 'latitude', 'longitude', 'alarm_active', 'air_temp']) {
        expect(found).toHaveProperty(key);
      }
    });

    it('never leaks another tenant site through a stale site_id', async () => {
      const device = await createDevice(tenantA.id, { name: 'Stale link', mqttId: nextMqttId() });
      // Simulates a device that kept its site_id across a tenant move: the join
      // predicate s.tenant_id = d.tenant_id must blank the whole block out, and
      // site_id itself comes from s.id so it goes NULL with the rest.
      await attachToSite(device.id, siteOther.id);

      const res = await request(app)
        .get('/api/devices')
        .set(authHeader(admin, tenantA.id));

      const found = res.body.data.find(d => d.id === device.id);
      for (const key of SITE_KEYS) expect(found[key]).toBeNull();
      // The row itself still carries the stale link — only the API view hides it
      expect((await readDevice(device.id)).site_id).toBe(siteOther.id);

      await attachToSite(device.id, null);
    });
  });

  describe('GET /api/devices/:id', () => {
    it('exposes site_id and the joined site columns', async () => {
      const device = await createDevice(tenantA.id, { name: 'Detail', mqttId: nextMqttId() });
      await attachToSite(device.id, siteLviv.id);

      const res = await request(app)
        .get(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data.site_id).toBe(siteLviv.id);
      expect(res.body.data.site_name).toBe('Сільпо Львів');
      expect(res.body.data.site_city).toBe('Львів');
      expect(res.body.data.site_region).toBe('Львівська область');
      expect(res.body.data.site_latitude).toBe(49.8440);
      expect(res.body.data.site_longitude).toBe(24.0262);
    });

    it('keeps the existing detail fields intact', async () => {
      const device = await createDevice(tenantA.id, { name: 'Detail shape', mqttId: nextMqttId() });

      const res = await request(app)
        .get(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      for (const key of ['id', 'mqtt_device_id', 'name', 'location', 'proto_version',
        'last_state', 'has_mqtt_credentials', 'tenant_id', 'tenant_slug', 'model_id',
        'model_name', 'latitude', 'longitude', 'users']) {
        expect(res.body.data).toHaveProperty(key);
      }
    });
  });

  describe('GET /api/devices/pending', () => {
    it('carries the site keys (always null — pending lives in the system tenant)', async () => {
      const pending = await createPendingDevice(nextMqttId());

      const res = await request(app)
        .get('/api/devices/pending')
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      const found = res.body.data.find(d => d.id === pending.id);
      expect(found).toBeDefined();
      for (const key of SITE_KEYS) {
        expect(found).toHaveProperty(key);
        expect(found[key]).toBeNull();
      }
    });
  });

  // ── PATCH /api/devices/:id ──────────────────────────────

  describe('PATCH /api/devices/:id — site_id', () => {
    it('admin can assign a site of their own tenant', async () => {
      const device = await createDevice(tenantA.id, { name: 'Assignable', mqttId: nextMqttId() });

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: siteKyiv.id });

      expect(res.status).toBe(200);
      expect(res.body.data.site_id).toBe(siteKyiv.id);
      expect((await readDevice(device.id)).site_id).toBe(siteKyiv.id);
    });

    it('the assignment shows up in the joined detail payload', async () => {
      const device = await createDevice(tenantA.id, { name: 'Round trip', mqttId: nextMqttId() });

      await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: siteLviv.id })
        .expect(200);

      const res = await request(app)
        .get(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id));

      expect(res.body.data.site_name).toBe('Сільпо Львів');
    });

    it('null detaches the device from its site', async () => {
      const device = await createDevice(tenantA.id, { name: 'Detachable', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: null });

      expect(res.status).toBe(200);
      expect(res.body.data.site_id).toBeNull();
      expect((await readDevice(device.id)).site_id).toBeNull();
    });

    // site_id decides WHO CAN SEE the device: middleware/device-access.js grants
    // a device to everyone holding a user_sites row for its site. A technician
    // who may otherwise edit the device must not be able to detach it and strip
    // it from colleagues, nor attach it and widen a third party's access.
    it('a technician cannot change site_id, even on a device they may edit', async () => {
      const device = await createDevice(tenantA.id, { name: 'Tech editable', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);
      await grantDeviceAccess(tech.id, device.id, admin.id);

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(tech, tenantA.id))
        .send({ site_id: null });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect((await readDevice(device.id)).site_id).toBe(siteKyiv.id);
    });

    it('a technician may still edit the other device fields', async () => {
      const device = await createDevice(tenantA.id, { name: 'Tech rename', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);
      await grantDeviceAccess(tech.id, device.id, admin.id);

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(tech, tenantA.id))
        .send({ name: 'Renamed by tech' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed by tech');
      expect((await readDevice(device.id)).site_id).toBe(siteKyiv.id);
    });

    it('rejects a site belonging to another tenant with 400 invalid_site', async () => {
      const device = await createDevice(tenantA.id, { name: 'Cross tenant', mqttId: nextMqttId() });

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: siteOther.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_site');
      expect((await readDevice(device.id)).site_id).toBeNull();
    });

    it('rejects an unknown site id with 400 invalid_site', async () => {
      const device = await createDevice(tenantA.id, { name: 'Unknown site', mqttId: nextMqttId() });

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: '00000000-0000-0000-0000-0000000000ff' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_site');
    });

    it('rejects a non-uuid site_id with 400 validation_failed', async () => {
      const device = await createDevice(tenantA.id, { name: 'Bad uuid', mqttId: nextMqttId() });

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ site_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it("tenant B's admin cannot reach a tenant A device at all", async () => {
      const device = await createDevice(tenantA.id, { name: 'Foreign patch', mqttId: nextMqttId() });

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(adminB, tenantB.id))
        .send({ site_id: siteOther.id });

      expect([403, 404]).toContain(res.status);
      expect((await readDevice(device.id)).site_id).toBeNull();
    });

    it('leaves site_id alone when the PATCH does not mention it', async () => {
      const device = await createDevice(tenantA.id, { name: 'Untouched', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .patch(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id))
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.data.site_id).toBe(siteKyiv.id);
    });
  });

  // ── Tenant moves must drop the site link ────────────────

  describe('site_id is cleared whenever the device changes tenant', () => {
    it('soft delete clears site_id', async () => {
      const device = await createDevice(tenantA.id, { name: 'Delete me', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .delete(`/api/devices/${device.id}`)
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      const after = await readDevice(device.id);
      expect(after.status).toBe('deleted');
      expect(after.site_id).toBeNull();
    });

    // NOTE: DELETE /api/devices/bulk cannot be exercised over HTTP — router.delete('/:id')
    // is registered before router.delete('/bulk'), so Express matches 'bulk' as an :id and
    // the request 404s before the bulk handler runs. That shadowing is a pre-existing
    // defect, not something this change introduced; the bulk handler's UPDATE does clear
    // site_id, exactly like the single delete above.

    it('reset-pending clears site_id', async () => {
      const device = await createDevice(tenantA.id, { name: 'Reset me', mqttId: nextMqttId() });
      await attachToSite(device.id, siteKyiv.id);

      const res = await request(app)
        .post(`/api/devices/${device.id}/reset-pending`)
        .set(authHeader(admin, tenantA.id));

      expect(res.status).toBe(200);
      const after = await readDevice(device.id);
      expect(after.status).toBe('pending');
      expect(after.site_id).toBeNull();
    });
  });

  // ── CSV batch import ────────────────────────────────────

  describe('POST /api/devices/pending/batch — site columns', () => {
    it('creates an unknown site, links the device and geocodes nothing when bulk is off', async () => {
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name', 'country', 'region', 'city', 'address_line'],
          [mqttId, 'Import 1', 'Новий Магазин', 'UA', 'Одеська область', 'Одеса', 'Дерибасівська 12'],
        ), 'devices.csv');

      expect(res.status).toBe(200);
      expect(res.body.data.summary.assigned).toBe(1);
      expect(res.body.data.summary.sites_created).toBe(1);
      expect(res.body.data.summary.devices_with_site).toBe(1);
      expect(res.body.data.results[0].site_name).toBe('Новий Магазин');

      const { rows } = await db.query(
        `SELECT * FROM sites WHERE tenant_id = $1 AND name = $2`,
        [tenantA.id, 'Новий Магазин']
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].country_code).toBe('UA');
      expect(rows[0].country).toBeNull();
      expect(rows[0].region).toBe('Одеська область');
      expect(rows[0].city).toBe('Одеса');
      expect(rows[0].address_line).toBe('Дерибасівська 12');
      // GEOCODER_BULK_ENABLED is off in tests: the site waits for a manual geocode
      expect(rows[0].geo_source).toBe('none');
      expect(rows[0].latitude).toBeNull();

      const device = await db.query(
        `SELECT site_id, tenant_id FROM devices WHERE mqtt_device_id = $1`, [mqttId]
      );
      expect(device.rows[0].site_id).toBe(rows[0].id);
      expect(device.rows[0].tenant_id).toBe(tenantA.id);
    });

    it('stores a multi-letter country as the country name, not the ISO code', async () => {
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name', 'country'],
          [mqttId, 'Import country', 'Точка Країна', 'Україна'],
        ), 'devices.csv')
        .expect(200);

      const { rows } = await db.query(
        `SELECT country_code, country FROM sites WHERE tenant_id = $1 AND name = $2`,
        [tenantA.id, 'Точка Країна']
      );
      expect(rows[0].country).toBe('Україна');
      expect(rows[0].country_code).toBeNull();
    });

    it('reuses one site for several rows, case- and whitespace-insensitively', async () => {
      const idA = nextMqttId();
      const idB = nextMqttId();
      await createPendingDevice(idA);
      await createPendingDevice(idB);

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name', 'city'],
          [idA, 'Shared 1', 'Spar Central', 'Kyiv'],
          [idB, 'Shared 2', '  spar CENTRAL ', 'Kyiv'],
        ), 'devices.csv');

      expect(res.status).toBe(200);
      expect(res.body.data.summary.assigned).toBe(2);
      expect(res.body.data.summary.sites_created).toBe(1);
      expect(res.body.data.summary.devices_with_site).toBe(2);

      const { rows } = await db.query(
        `SELECT id FROM sites WHERE tenant_id = $1 AND lower(btrim(name)) = 'spar central'`,
        [tenantA.id]
      );
      expect(rows).toHaveLength(1);

      const devices = await db.query(
        `SELECT site_id FROM devices WHERE mqtt_device_id = ANY($1)`, [[idA, idB]]
      );
      expect(devices.rows.map(r => r.site_id)).toEqual([rows[0].id, rows[0].id]);
    });

    // Also covers the DB-side match: the lookup is lower(btrim(name)), matching the
    // uq_sites_tenant_name functional index, so a differently-cased CSV name must not
    // create a second site (which would violate that index anyway).
    it('links an existing site by normalized name without overwriting its curated address', async () => {
      // ASCII name on purpose: this is the one assertion that leans on Postgres
      // lower(), and the test container's ctype must not decide whether it passes.
      const site = await createSite(tenantA.id, {
        name: 'Auchan Prospekt', city: 'Київ', address_line: 'проспект Перемоги, 1',
        latitude: 50.4501, longitude: 30.5234, geo_source: 'manual',
      });
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name', 'city', 'address_line'],
          [mqttId, 'Existing site', 'AUCHAN prospekt', 'Львів', 'зовсім інша вулиця'],
        ), 'devices.csv');

      expect(res.status).toBe(200);
      expect(res.body.data.summary.sites_created).toBe(0);
      expect(res.body.data.summary.devices_with_site).toBe(1);
      // the stored spelling wins over the CSV's
      expect(res.body.data.results[0].site_name).toBe('Auchan Prospekt');
      expect(res.body.data.results[0].site_id).toBe(site.id);

      const after = await readSite(site.id);
      expect(after.city).toBe('Київ');
      expect(after.address_line).toBe('проспект Перемоги, 1');
      expect(after.geo_source).toBe('manual');
      expect(Number(after.latitude)).toBe(50.4501);

      const { rows } = await db.query(
        `SELECT id FROM sites WHERE tenant_id = $1 AND lower(btrim(name)) = 'auchan prospekt'`,
        [tenantA.id]
      );
      expect(rows).toHaveLength(1);
    });

    it('never gives a pre-registered device a site (it stays in the system tenant)', async () => {
      const mqttId = nextMqttId();   // deliberately NOT created — forces pre_register

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name', 'city'],
          [mqttId, 'Pre reg', 'Точка Пререг', 'Харків'],
        ), 'devices.csv');

      expect(res.status).toBe(200);
      expect(res.body.data.summary.pre_registered).toBe(1);
      expect(res.body.data.summary.sites_created).toBe(0);
      expect(res.body.data.summary.devices_with_site).toBe(0);

      const { rows } = await db.query(
        `SELECT tenant_id, site_id FROM devices WHERE mqtt_device_id = $1`, [mqttId]
      );
      expect(rows[0].tenant_id).toBe(db.SYSTEM_TENANT_ID);
      expect(rows[0].site_id).toBeNull();

      const sites = await db.query(
        `SELECT id FROM sites WHERE name = $1`, ['Точка Пререг']
      );
      expect(sites.rows).toHaveLength(0);
    });

    it('creates the site under the target tenant, never the caller tenant', async () => {
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(adminB, tenantB.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name'],
          [mqttId, 'Tenant B import', 'Tenant B Store'],
        ), 'devices.csv')
        .expect(200);

      const { rows } = await db.query(
        `SELECT tenant_id FROM sites WHERE name = $1`, ['Tenant B Store']
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantB.id);
    });

    it('rejects a site_name longer than the sites.name column', async () => {
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'site_name'],
          [mqttId, 'Too long', 'x'.repeat(257)],
        ), 'devices.csv');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.errors.some(e => e.field === 'site_name')).toBe(true);
    });

    it('imports normally when the site columns are absent (existing CSVs keep working)', async () => {
      const mqttId = nextMqttId();
      await createPendingDevice(mqttId);

      const res = await request(app)
        .post('/api/devices/pending/batch')
        .set(authHeader(admin, tenantA.id))
        .attach('file', csvBuffer(
          ['mqtt_device_id', 'name', 'location'],
          [mqttId, 'Plain import', 'Зал, ряд 3'],
        ), 'devices.csv');

      expect(res.status).toBe(200);
      expect(res.body.data.summary.assigned).toBe(1);
      expect(res.body.data.summary.sites_created).toBe(0);
      expect(res.body.data.results[0].site_id).toBeNull();

      const { rows } = await db.query(
        `SELECT location, site_id FROM devices WHERE mqtt_device_id = $1`, [mqttId]
      );
      expect(rows[0].location).toBe('Зал, ряд 3');
      expect(rows[0].site_id).toBeNull();
    });
  });
});
