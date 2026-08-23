'use strict';

// helpers/app.js is required for its side effects only: it sets the env vars and
// stubs services/mqtt before routes/map.js pulls it in. The map/geo mounts do not
// exist in createTestApp(), so this suite builds its own app below.
require('./helpers/app');

const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const { authenticate } = require('../src/middleware/auth');

// ── Test app ─────────────────────────────────────────────
// Mirrors the index.js chain for /api/map: JWT gate, then the router.
function createMapApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', authenticate);
  app.use('/api/map', require('../src/routes/map'));
  app.use((_err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong', status: 500 });
  });
  return app;
}

const app = createMapApp();

// ── Local factories ──────────────────────────────────────
// sites / user_sites arrive with migration 021; helpers/factories.js is shared
// with every other suite, so the geo fixtures live here.

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city,
                        address_line, latitude, longitude, geo_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      tenantId,
      overrides.name,
      overrides.country_code ?? null,
      overrides.country ?? null,
      overrides.region ?? null,
      overrides.city ?? null,
      overrides.address_line ?? null,
      overrides.latitude ?? null,
      overrides.longitude ?? null,
      overrides.latitude != null ? 'manual' : 'none',
    ]
  );
  return rows[0];
}

async function grantSiteAccess(userId, site, grantedBy) {
  await db.query(
    `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [userId, site.id, site.tenant_id, grantedBy]
  );
}

async function updateDevice(deviceId, patch) {
  const keys = Object.keys(patch);
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await db.query(`UPDATE devices SET ${set} WHERE id = $${keys.length + 1}`,
    [...keys.map(k => patch[k]), deviceId]);
}

async function createAlarm(tenantId, mqttId, overrides = {}) {
  await db.query(
    `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId, mqttId,
      overrides.alarm_code || 'HIGH_TEMP',
      overrides.severity || 'warning',
      overrides.active !== undefined ? overrides.active : true,
      overrides.triggered_at || new Date(Date.now() - 3600 * 1000),
    ]
  );
}

/** Features keyed by site name (synthetic device features key on `null`). */
const bySiteName = res =>
  new Map(res.body.data.features.map(f => [f.properties.site_name, f]));

// ── Fixtures ─────────────────────────────────────────────

let tenantA, tenantB;
let admin, superadmin, techDevice, techSite, techNone, viewer, adminB;
let siteKyiv, siteLviv, siteOdesaNoCoords, siteBrno;
let devKyiv1, devKyiv2, devLviv, devOwnCoords, devNowhere, devWarehouse, devBrno;

const KYIV  = { lat: 50.4498, lon: 30.5231 };
const LVIV  = { lat: 49.8440, lon: 24.0262 };
const ODESA = { lat: 46.4843, lon: 30.7406 };

beforeAll(async () => {
  await cleanDatabase();

  tenantA = await createTenant({ slug: 'map-a' });
  tenantB = await createTenant({ slug: 'map-b' });

  admin      = await createUser(tenantA.id, { role: 'admin',      email: 'admin@map.test' });
  superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'root@map.test' });
  techDevice = await createUser(tenantA.id, { role: 'technician', email: 'dev-tech@map.test' });
  techSite   = await createUser(tenantA.id, { role: 'technician', email: 'site-tech@map.test' });
  techNone   = await createUser(tenantA.id, { role: 'technician', email: 'none-tech@map.test' });
  viewer     = await createUser(tenantA.id, { role: 'viewer',     email: 'viewer@map.test' });
  adminB     = await createUser(tenantB.id, { role: 'admin',      email: 'admin@map-b.test' });

  siteKyiv = await createSite(tenantA.id, {
    name: 'АТБ №142', city: 'Київ', region: 'Київ',
    country: 'Україна', country_code: 'UA',
    latitude: KYIV.lat, longitude: KYIV.lon,
  });
  siteLviv = await createSite(tenantA.id, {
    name: 'Сільпо №7', city: 'Львів', region: 'Львівська область',
    country: 'Україна', country_code: 'UA',
    latitude: LVIV.lat, longitude: LVIV.lon,
  });
  siteOdesaNoCoords = await createSite(tenantA.id, {
    name: 'Склад Одеса', city: 'Одеса', region: 'Одеська область',
    country: 'Україна', country_code: 'UA',
  });
  siteBrno = await createSite(tenantB.id, {
    name: 'Foreign Site', city: 'Brno', region: 'Jihomoravský',
    country: 'Česko', country_code: 'CZ',
    latitude: 49.1951, longitude: 16.6068,
  });

  devKyiv1 = await createDevice(tenantA.id, { name: 'Kyiv cabinet 1' });
  devKyiv2 = await createDevice(tenantA.id, { name: 'Kyiv cabinet 2' });
  devLviv  = await createDevice(tenantA.id, { name: 'Lviv cabinet' });
  devOwnCoords = await createDevice(tenantA.id, {
    name: 'Odesa van', latitude: ODESA.lat, longitude: ODESA.lon,
  });
  devNowhere   = await createDevice(tenantA.id, { name: 'Unplaced cabinet' });
  devWarehouse = await createDevice(tenantA.id, { name: 'Warehouse cabinet' });
  devBrno      = await createDevice(tenantB.id, { name: 'Brno cabinet' });

  await updateDevice(devKyiv1.id, { site_id: siteKyiv.id, online: true, model: 'MX-1', firmware_version: '1.2.3' });
  await updateDevice(devKyiv2.id, { site_id: siteKyiv.id, online: false, model: 'MX-1', firmware_version: '1.2.3' });
  await updateDevice(devLviv.id,  { site_id: siteLviv.id, online: true, model: 'MX-2', firmware_version: '2.0.0' });
  await updateDevice(devWarehouse.id, { site_id: siteOdesaNoCoords.id });
  await updateDevice(devBrno.id, { site_id: siteBrno.id, online: true });

  await grantDeviceAccess(techDevice.id, devKyiv1.id, admin.id);
  await grantDeviceAccess(techSite.id,   devKyiv1.id, admin.id);   // plus a site grant below
  await grantSiteAccess(techSite.id, siteLviv, admin.id);

  // Alarm history for the heatmap: 3 on the Kyiv site, 1 on Lviv, 1 far in the past.
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { alarm_code: 'HIGH_TEMP' });
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { alarm_code: 'DOOR_OPEN', active: false });
  await createAlarm(tenantA.id, devKyiv2.mqtt_device_id, { alarm_code: 'SENSOR_FAIL' });
  await createAlarm(tenantA.id, devLviv.mqtt_device_id,  { alarm_code: 'HIGH_TEMP' });
  await createAlarm(tenantA.id, devLviv.mqtt_device_id,  {
    alarm_code: 'OLD', triggered_at: new Date(Date.now() - 400 * 86400 * 1000),
  });
  await createAlarm(tenantB.id, devBrno.mqtt_device_id, { alarm_code: 'HIGH_TEMP' });
});

afterAll(async () => {
  await cleanDatabase();
  await shutdownDb();
});

// ── GET /api/map/devices ─────────────────────────────────

describe('GET /api/map/devices', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/map/devices');
    expect(res.status).toBe(401);
  });

  it('wraps the FeatureCollection in { data, meta }', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('FeatureCollection');
    expect(Array.isArray(res.body.data.features)).toBe(true);
    expect(res.body.meta).toMatchObject({ total_sites: 2, total_devices: 4, ungeocoded_devices: 2 });
  });

  it('groups devices by site and aggregates the counts', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const kyiv = bySiteName(res).get('АТБ №142');

    expect(kyiv.geometry).toEqual({ type: 'Point', coordinates: [KYIV.lon, KYIV.lat] });
    expect(kyiv.properties).toMatchObject({
      site_id: siteKyiv.id,
      city: 'Київ',
      region: 'Київ',
      country: 'Україна',
      country_code: 'UA',
      tenant_slug: 'map-a',
      device_count: 2,
      online_count: 1,
      offline_count: 1,
    });
    expect(kyiv.properties.devices.map(d => d.id).sort())
      .toEqual([devKyiv1.id, devKyiv2.id].sort());
  });

  it('keeps the device payload thin — no serial numbers, comments or coordinates', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const device = bySiteName(res).get('АТБ №142').properties.devices[0];
    expect(Object.keys(device).sort())
      .toEqual(['air_temp', 'alarm_active', 'id', 'mqtt_device_id', 'name', 'online']);
  });

  it('makes a device with its own coordinates and no site a single-device feature', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const loose = res.body.data.features.filter(f => f.properties.site_id === null);

    expect(loose).toHaveLength(1);
    expect(loose[0].geometry.coordinates).toEqual([ODESA.lon, ODESA.lat]);
    expect(loose[0].properties.device_count).toBe(1);
    expect(loose[0].properties.devices[0].id).toBe(devOwnCoords.id);
    // Synthetic features are not sites.
    expect(res.body.meta.total_features).toBe(3);
  });

  // MapCanvas reads a site-less feature's identity and live values at the
  // PROPERTIES level (popup title, temperature, the "open device" link), and
  // lib/geo.js featureKey() keys the marker map on properties.device_id. Without
  // them the popup renders "—" and two devices pinned at the same rounded
  // coordinates collapse onto one marker.
  it('mirrors the device fields onto a site-less feature\'s properties', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const loose = res.body.data.features.find(f => f.properties.site_id === null);

    expect(loose.properties.device_id).toBe(devOwnCoords.id);
    expect(loose.properties.mqtt_device_id).toBe(devOwnCoords.mqtt_device_id);
    expect(loose.properties.name).toBe('Odesa van');
    expect(loose.properties).toHaveProperty('online');
    expect(loose.properties).toHaveProperty('alarm_active');
    expect(loose.properties).toHaveProperty('air_temp');

    // Site features must NOT carry them — site_name is their title.
    const kyiv = bySiteName(res).get('АТБ №142');
    expect(kyiv.properties.device_id).toBeUndefined();
    expect(kyiv.properties.mqtt_device_id).toBeUndefined();
  });

  it('counts devices without effective coordinates as ungeocoded, not as features', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const ids = res.body.data.features.flatMap(f => f.properties.devices.map(d => d.id));

    expect(ids).not.toContain(devNowhere.id);      // no site, no own coordinates
    expect(ids).not.toContain(devWarehouse.id);    // site has no coordinates either
    expect(res.body.meta.ungeocoded_devices).toBe(2);
  });

  // ── tenant isolation ──
  it('never leaks another tenant into the collection', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(admin, tenantA.id));
    const names = res.body.data.features.map(f => f.properties.site_name);

    expect(names).not.toContain('Foreign Site');
    const ids = res.body.data.features.flatMap(f => f.properties.devices.map(d => d.id));
    expect(ids).not.toContain(devBrno.id);
  });

  it('shows tenant B only its own site', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(adminB, tenantB.id));
    expect(res.status).toBe(200);
    expect(res.body.data.features).toHaveLength(1);
    expect(res.body.data.features[0].properties.site_name).toBe('Foreign Site');
  });

  it('ignores a forged tenant_id from a non-superadmin', async () => {
    const res = await request(app)
      .get(`/api/map/devices?tenant_id=${tenantB.id}`)
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    const names = res.body.data.features.map(f => f.properties.site_name);
    expect(names).not.toContain('Foreign Site');
    expect(names).toContain('АТБ №142');
  });

  it('lets a superadmin see across tenants and scope with ?tenant_id=', async () => {
    const all = await request(app).get('/api/map/devices').set(authHeader(superadmin, tenantA.id));
    expect(all.body.data.features.map(f => f.properties.site_name)).toContain('Foreign Site');

    const scoped = await request(app)
      .get(`/api/map/devices?tenant_id=${tenantB.id}`)
      .set(authHeader(superadmin, tenantA.id));
    expect(scoped.body.data.features).toHaveLength(1);
    expect(scoped.body.data.features[0].properties.site_name).toBe('Foreign Site');
  });

  // ── RBAC ──
  it('limits a technician to their per-device grants', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(techDevice, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.features).toHaveLength(1);

    const kyiv = res.body.data.features[0];
    expect(kyiv.properties.site_name).toBe('АТБ №142');
    expect(kyiv.properties.device_count).toBe(1);
    expect(kyiv.properties.devices[0].id).toBe(devKyiv1.id);
    expect(res.body.meta.ungeocoded_devices).toBe(0);
  });

  it('honours the user_devices ∪ user_sites union', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(techSite, tenantA.id));
    const names = res.body.data.features.map(f => f.properties.site_name).sort();

    expect(names).toEqual(['АТБ №142', 'Сільпо №7']);
    expect(bySiteName(res).get('Сільпо №7').properties.devices[0].id).toBe(devLviv.id);
  });

  it('returns an empty collection for a technician with no grants', async () => {
    const res = await request(app).get('/api/map/devices').set(authHeader(techNone, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual([]);
    expect(res.body.meta).toMatchObject({ total_sites: 0, total_devices: 0, ungeocoded_devices: 0 });
  });

  it('403s a technician using ?user_id= to enumerate another user', async () => {
    const res = await request(app)
      .get(`/api/map/devices?user_id=${techDevice.id}`)
      .set(authHeader(techSite, tenantA.id));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('lets an admin filter by user_id', async () => {
    const res = await request(app)
      .get(`/api/map/devices?user_id=${techDevice.id}`)
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data.features).toHaveLength(1);
    expect(res.body.data.features[0].properties.devices[0].id).toBe(devKyiv1.id);
  });

  // ── filters ──
  it('filters by bbox on the effective coordinates', async () => {
    const res = await request(app)
      .get('/api/map/devices?bbox=30,50,31,51')
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.data.features.map(f => f.properties.site_name)).toEqual(['АТБ №142']);
    // The viewport must not change the ungeocoded counter.
    expect(res.body.meta.ungeocoded_devices).toBe(2);
  });

  it('returns an empty collection for a bbox with nothing in it', async () => {
    const res = await request(app)
      .get('/api/map/devices?bbox=-10,-10,-9,-9')
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual([]);
  });

  it('400s on a malformed bbox instead of 500ing', async () => {
    const cases = ['a,b,c,d', '1,2,3', '1,2,3,4,5', '30,50,29,51', '30,95,31,96', ',,,', '181,0,182,1'];
    for (const bbox of cases) {
      const res = await request(app)
        .get(`/api/map/devices?bbox=${encodeURIComponent(bbox)}`)
        .set(authHeader(admin, tenantA.id));
      expect(res.status, `bbox=${bbox}`).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    }
  });

  it('filters by site, city, region, country, model and firmware', async () => {
    const header = authHeader(admin, tenantA.id);
    const cases = [
      [`site_id=${siteLviv.id}`, ['Сільпо №7']],
      ['city=Львів',             ['Сільпо №7']],
      ['region=Київ',            ['АТБ №142']],
      ['country_code=ua',        ['АТБ №142', 'Сільпо №7']],
      ['model=MX-2',             ['Сільпо №7']],
      ['firmware_version=1.2.3', ['АТБ №142']],
    ];

    for (const [qs, expected] of cases) {
      const res = await request(app).get(`/api/map/devices?${encodeURI(qs)}`).set(header);
      expect(res.status, qs).toBe(200);
      expect(res.body.data.features.map(f => f.properties.site_name).sort(), qs).toEqual(expected);
    }
  });

  it('filters by status', async () => {
    const header = authHeader(admin, tenantA.id);

    const online = await request(app).get('/api/map/devices?status=online').set(header);
    const onlineIds = online.body.data.features.flatMap(f => f.properties.devices.map(d => d.id));
    expect(onlineIds).toContain(devKyiv1.id);
    expect(onlineIds).not.toContain(devKyiv2.id);

    const offline = await request(app).get('/api/map/devices?status=offline').set(header);
    const offlineIds = offline.body.data.features.flatMap(f => f.properties.devices.map(d => d.id));
    expect(offlineIds).toContain(devKyiv2.id);
    expect(offlineIds).not.toContain(devKyiv1.id);

    const alarm = await request(app).get('/api/map/devices?status=alarm').set(header);
    const alarmIds = alarm.body.data.features.flatMap(f => f.properties.devices.map(d => d.id));
    expect(alarmIds.sort()).toEqual([devKyiv1.id, devKyiv2.id, devLviv.id].sort());
  });

  it('searches name, mqtt id, location and site name with ?q=', async () => {
    const header = authHeader(admin, tenantA.id);

    const byDevice = await request(app).get('/api/map/devices?q=Lviv%20cabinet').set(header);
    expect(byDevice.body.data.features.map(f => f.properties.site_name)).toEqual(['Сільпо №7']);

    const bySite = await request(app).get(`/api/map/devices?q=${encodeURIComponent('АТБ')}`).set(header);
    expect(bySite.body.data.features.map(f => f.properties.site_name)).toEqual(['АТБ №142']);

    const byMqtt = await request(app)
      .get(`/api/map/devices?q=${encodeURIComponent(devLviv.mqtt_device_id)}`).set(header);
    expect(byMqtt.body.data.features).toHaveLength(1);

    // A LIKE wildcard is data, not a pattern.
    const wildcard = await request(app).get('/api/map/devices?q=%25').set(header);
    expect(wildcard.body.data.features).toEqual([]);
  });

  it('400s on invalid filter values instead of 500ing', async () => {
    const header = authHeader(admin, tenantA.id);
    const cases = [
      'site_id=notauuid',
      'user_id=notauuid',
      'tenant_id=notauuid',
      'status=bogus',
      'country_code=UKR',
      `city=${'x'.repeat(129)}`,
    ];
    for (const qs of cases) {
      const res = await request(app).get(`/api/map/devices?${qs}`).set(header);
      expect(res.status, qs).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_failed', status: 400 });
    }
  });
});

// ── GET /api/map/filters ─────────────────────────────────

describe('GET /api/map/filters', () => {
  it('returns the option lists with device counts', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);

    const { countries, regions, cities, models, firmware_versions } = res.body.data;
    expect(countries).toEqual([{ code: 'UA', name: 'Україна', count: 4 }]);
    expect(cities.find(c => c.name === 'Київ').count).toBe(2);
    expect(regions.find(r => r.name === 'Львівська область').count).toBe(1);
    expect(models.find(m => m.name === 'MX-1').count).toBe(2);
    expect(firmware_versions.find(f => f.version === '2.0.0').count).toBe(1);
  });

  it('never lists another tenant’s cities', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(admin, tenantA.id));
    expect(res.body.data.cities.map(c => c.name)).not.toContain('Brno');
  });

  it('exposes the user list to admins only', async () => {
    const asAdmin = await request(app).get('/api/map/filters').set(authHeader(admin, tenantA.id));
    expect(Array.isArray(asAdmin.body.data.users)).toBe(true);
    expect(asAdmin.body.data.users.map(u => u.email)).toContain('dev-tech@map.test');
    expect(asAdmin.body.data.users.find(u => u.email === 'dev-tech@map.test').count).toBe(1);
    expect(asAdmin.body.data.tenants).toBeUndefined();

    const asTech = await request(app).get('/api/map/filters').set(authHeader(techSite, tenantA.id));
    expect(asTech.status).toBe(200);
    expect(asTech.body.data.users).toBeUndefined();
    expect(asTech.body.data.tenants).toBeUndefined();
  });

  it('counts a site grant towards the user device count', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(admin, tenantA.id));
    // techSite has one device grant (Kyiv 1) + one site grant (Lviv, 1 device).
    expect(res.body.data.users.find(u => u.email === 'site-tech@map.test').count).toBe(2);
  });

  it('exposes the tenant list to superadmins only', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(superadmin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.tenants.map(t => t.slug).sort()).toEqual(['map-a', 'map-b']);
  });

  it('narrows the options to the technician’s accessible devices', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(techDevice, tenantA.id));
    expect(res.body.data.cities.map(c => c.name)).toEqual(['Київ']);
    expect(res.body.data.models).toEqual([{ name: 'MX-1', count: 1 }]);
  });

  it('returns empty option lists for a technician with no grants', async () => {
    const res = await request(app).get('/api/map/filters').set(authHeader(techNone, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data.cities).toEqual([]);
    expect(res.body.data.countries).toEqual([]);
  });
});

// ── GET /api/map/alarm-heatmap ───────────────────────────

describe('GET /api/map/alarm-heatmap', () => {
  it('aggregates weights per effective coordinate with meta.max_weight', async () => {
    const res = await request(app).get('/api/map/alarm-heatmap').set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);

    // Kyiv site: 2 alarms on cabinet 1 + 1 on cabinet 2. Lviv: 1 in range, 1 too old.
    expect(res.body.data).toEqual([
      [KYIV.lat, KYIV.lon, 3],
      [LVIV.lat, LVIV.lon, 1],
    ]);
    expect(res.body.meta.max_weight).toBe(3);
    expect(res.body.meta.total).toBe(4);
  });

  it('honours the from/to window', async () => {
    const res = await request(app)
      .get('/api/map/alarm-heatmap?from=2000-01-01T00:00:00Z')
      .set(authHeader(admin, tenantA.id));

    // The 400-day-old Lviv alarm is now inside the window.
    expect(res.body.meta.total).toBe(5);
    expect(res.body.data.find(p => p[0] === LVIV.lat)[2]).toBe(2);
  });

  it('never counts another tenant’s alarms', async () => {
    const res = await request(app).get('/api/map/alarm-heatmap').set(authHeader(admin, tenantA.id));
    expect(res.body.data.some(([lat]) => Math.abs(lat - 49.1951) < 0.001)).toBe(false);
  });

  it('applies the caller’s RBAC to alarm locations', async () => {
    const res = await request(app).get('/api/map/alarm-heatmap').set(authHeader(techSite, tenantA.id));
    // techSite sees Kyiv cabinet 1 (device grant) and all of Lviv (site grant),
    // but not Kyiv cabinet 2 — so Kyiv drops from 3 to 2.
    expect(res.body.data).toEqual([
      [KYIV.lat, KYIV.lon, 2],
      [LVIV.lat, LVIV.lon, 1],
    ]);
    expect(res.body.meta.max_weight).toBe(2);
  });

  it('returns an empty set with zeroed meta for a technician with no grants', async () => {
    const res = await request(app).get('/api/map/alarm-heatmap').set(authHeader(techNone, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ max_weight: 0, total: 0 });
  });

  it('accepts the standard map filters', async () => {
    const res = await request(app)
      .get(`/api/map/alarm-heatmap?city=${encodeURIComponent('Львів')}`)
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([[LVIV.lat, LVIV.lon, 1]]);
  });

  it('400s on a bad date instead of 500ing', async () => {
    const header = authHeader(admin, tenantA.id);
    for (const qs of ['from=notadate', 'to=notadate', 'from=2026-01-02&to=2026-01-01']) {
      const res = await request(app).get(`/api/map/alarm-heatmap?${qs}`).set(header);
      expect(res.status, qs).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    }
  });
});

// ── GET /api/map/isochrones ──────────────────────────────

describe('GET /api/map/isochrones', () => {
  it('reports approximate=true on every feature when no ORS key is configured', async () => {
    expect(process.env.ORS_API_KEY || '').toBe('');

    const res = await request(app)
      .get('/api/map/isochrones?lat=50.4498&lon=30.5231&minutes=15,30,60')
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ approximate: true, provider: null, assumed_speed_kmh: 30 });
    expect(res.body.data.type).toBe('FeatureCollection');
    expect(res.body.data.features).toHaveLength(3);

    for (const feature of res.body.data.features) {
      // The flag must travel with the geometry that gets drawn/cached/exported,
      // not only in the header meta.
      expect(feature.properties.approximate).toBe(true);
      expect(feature.properties.provider).toBeNull();
      expect(feature.properties.assumed_speed_kmh).toBe(30);
      expect(feature.geometry.type).toBe('Polygon');
      const ring = feature.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);   // closed ring
    }

    // Largest band first so the smaller ones stay visible on top.
    expect(res.body.data.features.map(f => f.properties.minutes)).toEqual([60, 30, 15]);
  });

  it('defaults to 15/30/60 minutes, and treats an empty ?minutes= as absent', async () => {
    for (const qs of ['lat=50&lon=30', 'lat=50&lon=30&minutes=']) {
      const res = await request(app).get(`/api/map/isochrones?${qs}`).set(authHeader(admin, tenantA.id));
      expect(res.status, qs).toBe(200);
      expect(res.body.data.features.map(f => f.properties.minutes)).toEqual([60, 30, 15]);
    }
  });

  it('400s on bad coordinates or unusable minutes', async () => {
    const header = authHeader(admin, tenantA.id);
    const cases = [
      '',
      'lat=50',
      'lat=abc&lon=30',
      'lat=91&lon=30',
      'lat=50&lon=181',
      'lat=50&lon=30&minutes=15,30,60,90',   // more than 3 bands
      'lat=50&lon=30&minutes=0',
      'lat=50&lon=30&minutes=500',
      'lat=50&lon=30&minutes=abc',
      'lat=50&lon=30&minutes=15,',
      'lat=50&lon=30&minutes=15.5',
    ];
    for (const qs of cases) {
      const res = await request(app).get(`/api/map/isochrones?${qs}`).set(header);
      expect(res.status, qs).toBe(400);
    }
  });

  it('is closed to viewers', async () => {
    const res = await request(app)
      .get('/api/map/isochrones?lat=50&lon=30')
      .set(authHeader(viewer, tenantA.id));
    expect(res.status).toBe(403);
  });

  it('is open to technicians', async () => {
    const res = await request(app)
      .get('/api/map/isochrones?lat=50&lon=30')
      .set(authHeader(techSite, tenantA.id));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/map/route ──────────────────────────────────

describe('POST /api/map/route', () => {
  it('degrades to a straight-line ordering with 200 when OSRM is not configured', async () => {
    expect(process.env.OSRM_URL || '').toBe('');

    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteLviv.id, siteKyiv.id] });

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ optimized: false, provider: null, reason: 'router_disabled' });
    expect(res.body.data.order).toEqual([siteLviv.id, siteKyiv.id]);
    expect(res.body.data.legs).toBeNull();
    expect(res.body.data.geometry).toBeNull();
    expect(res.body.data.total_duration_s).toBeNull();
    // Kyiv ↔ Lviv is ~470 km great-circle.
    expect(res.body.data.total_distance_m).toBeGreaterThan(400000);

    // The phone hand-off works with no upstream at all.
    expect(res.body.data.google_maps_url).toContain('https://www.google.com/maps/dir/');
    expect(res.body.data.google_maps_url).toContain(`origin=${encodeURIComponent(`${LVIV.lat},${LVIV.lon}`)}`);
    expect(res.body.data.google_maps_url).toContain(`destination=${encodeURIComponent(`${KYIV.lat},${KYIV.lon}`)}`);
  });

  it('puts the start point first and orders the stops from it', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteKyiv.id, siteLviv.id], start: { lat: LVIV.lat, lon: LVIV.lon } });

    expect(res.status).toBe(200);
    expect(res.body.data.stops[0]).toMatchObject({ kind: 'start', site_id: null });
    expect(res.body.data.stops.map(s => s.site_id))
      .toEqual([null, siteLviv.id, siteKyiv.id]);
    // `order` carries site ids only.
    expect(res.body.data.order).toEqual([siteLviv.id, siteKyiv.id]);
  });

  it('closes the loop in the deep link for a roundtrip', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteKyiv.id, siteLviv.id], roundtrip: true });

    expect(res.status).toBe(200);
    expect(res.body.meta.roundtrip).toBe(true);
    const url = new URL(res.body.data.google_maps_url);
    expect(url.searchParams.get('origin')).toBe(url.searchParams.get('destination'));
    expect(url.searchParams.get('waypoints')).toBe(`${LVIV.lat},${LVIV.lon}`);
  });

  it('rejects a site from another tenant', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteKyiv.id, siteBrno.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_site');
    expect(res.body.site_ids).toEqual([siteBrno.id]);
  });

  it('rejects a site with no coordinates', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteKyiv.id, siteOdesaNoCoords.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_site');
  });

  it('rejects a site the caller cannot see under RBAC', async () => {
    // techNone holds no grant at all, so every site is invisible to it; techSite
    // holds the Lviv site grant and may plan a round to it.
    const denied = await request(app)
      .post('/api/map/route')
      .set(authHeader(techNone, tenantA.id))
      .send({ site_ids: [siteLviv.id] });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toBe('invalid_site');

    const allowed = await request(app)
      .post('/api/map/route')
      .set(authHeader(techSite, tenantA.id))
      .send({ site_ids: [siteLviv.id] });
    expect(allowed.status).toBe(200);
  });

  it('validates the body', async () => {
    const header = authHeader(admin, tenantA.id);
    const bodies = [
      {},
      { site_ids: [] },
      { site_ids: ['notauuid'] },
      { site_ids: [siteKyiv.id], start: { lat: 91, lon: 30 } },
      { site_ids: [siteKyiv.id], start: { lat: 50, lon: 181 } },
      { site_ids: [siteKyiv.id], roundtrip: 'yes' },
      { site_ids: Array.from({ length: 26 }, () => siteKyiv.id) },
    ];
    for (const body of bodies) {
      const res = await request(app).post('/api/map/route').set(header).send(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    }
  });

  it('caps the total number of points at 25 including the start', async () => {
    // 25 sites pass the zod array cap; adding a start point makes 26 stops, and
    // the cap must catch that before any DB lookup or upstream call.
    const ids = Array.from({ length: 25 }, () => randomUUID());
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: ids, start: { lat: 50, lon: 30 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.message).toMatch(/25 points/);
  });

  it('de-duplicates repeated site ids', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(admin, tenantA.id))
      .send({ site_ids: [siteKyiv.id, siteKyiv.id, siteLviv.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.stops).toHaveLength(2);
  });

  it('is closed to viewers', async () => {
    const res = await request(app)
      .post('/api/map/route')
      .set(authHeader(viewer, tenantA.id))
      .send({ site_ids: [siteKyiv.id] });
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/map/route').send({ site_ids: [siteKyiv.id] });
    expect(res.status).toBe(401);
  });
});
