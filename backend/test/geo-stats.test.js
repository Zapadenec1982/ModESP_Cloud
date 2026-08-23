'use strict';

// helpers/app.js is required for its side effects only: it sets the env vars and
// stubs services/mqtt before routes/geo-stats.js pulls in the middleware chain.
// The /api/stats mount does not exist in createTestApp(), so this suite builds
// its own app below (same approach as map-routes.test.js).
require('./helpers/app');

const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const { authenticate } = require('../src/middleware/auth');

// ── Test app ─────────────────────────────────────────────
// Mirrors the index.js chain for /api/stats: JWT gate, then the router.
function createStatsApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', authenticate);
  app.use('/api/stats', require('../src/routes/geo-stats'));
  app.use((_err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong', status: 500 });
  });
  return app;
}

const app = createStatsApp();

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

async function createAlarm(tenantId, mqttId, { code = 'HIGH_TEMP', active = true, at }) {
  await db.query(
    `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
     VALUES ($1, $2, $3, 'warning', $4, $5)`,
    [tenantId, mqttId, code, active, at]
  );
}

async function addTelemetry(tenantId, mqttId, channel, value, at) {
  await db.query(
    `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
     VALUES ($1, $2, $3, $4, $5)`,
    [at, tenantId, mqttId, channel, value]
  );
}

async function addEvent(tenantId, mqttId, eventType, at) {
  await db.query(
    `INSERT INTO events (tenant_id, device_id, event_type, time)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tenantId, mqttId, eventType, at]
  );
}

/** service_date is a DATE — write an unambiguous YYYY-MM-DD, not a Date object. */
async function addServiceRecord(tenantId, deviceUuid, at) {
  await db.query(
    `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done)
     VALUES ($1, $2, $3, 'Тестовий технік', 'planned', 'checked')`,
    [tenantId, deviceUuid, at.toISOString().slice(0, 10)]
  );
}

/** Rows keyed by label, so an assertion never depends on row order. */
const byLabel = res => new Map(res.body.data.map(r => [r.label, r]));
/** The single row whose key is null (devices with no site). */
const nullRow = res => res.body.data.find(r => r.key === null);

// ── Fixtures ─────────────────────────────────────────────
//
// The window is fixed at fixture time and passed explicitly on every request, so
// nothing in this suite depends on how long the run takes.
//
//   FROM = NOW - 8d      TO = NOW      period = 691200 s
//
// Everything inside the window sits at least an hour away from either edge.

const DAY  = 86400 * 1000;
const HOUR = 3600 * 1000;

const NOW  = Date.now();
const TO   = new Date(NOW);
const FROM = new Date(NOW - 8 * DAY);

const inWindow = (offsetMs) => new Date(FROM.getTime() + offsetMs);
const beforeWindow = (days) => new Date(FROM.getTime() - days * DAY);

const RANGE = { from: FROM.toISOString(), to: TO.toISOString() };
const q = (extra = {}) => ({ ...RANGE, ...extra });

let tenantA, tenantB;
let admin, superadmin, techDevice, techSite, techNone, viewer, adminB;
let siteKyiv, siteLviv, siteBerlin, siteBrno;
let devKyiv1, devKyiv2, devLviv, devBerlin, devBrno;

beforeAll(async () => {
  await cleanDatabase();

  tenantA = await createTenant({ slug: 'geostats-a' });
  tenantB = await createTenant({ slug: 'geostats-b' });

  admin      = await createUser(tenantA.id, { role: 'admin',      email: 'admin@geostats.test' });
  superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'root@geostats.test' });
  techDevice = await createUser(tenantA.id, { role: 'technician', email: 'dev-tech@geostats.test' });
  techSite   = await createUser(tenantA.id, { role: 'technician', email: 'site-tech@geostats.test' });
  techNone   = await createUser(tenantA.id, { role: 'technician', email: 'none-tech@geostats.test' });
  viewer     = await createUser(tenantA.id, { role: 'viewer',     email: 'viewer@geostats.test' });
  adminB     = await createUser(tenantB.id, { role: 'admin',      email: 'admin@geostats-b.test' });

  siteKyiv = await createSite(tenantA.id, {
    name: 'АТБ №142', city: 'Київ', region: 'Київ',
    country: 'Україна', country_code: 'UA', latitude: 50.4498, longitude: 30.5231,
  });
  siteLviv = await createSite(tenantA.id, {
    name: 'Сільпо №7', city: 'Львів', region: 'Львівська область',
    country: 'Україна', country_code: 'UA', latitude: 49.8440, longitude: 24.0262,
  });
  siteBerlin = await createSite(tenantA.id, {
    name: 'Kaufland Mitte', city: 'Berlin', region: 'Berlin',
    country: 'Deutschland', country_code: 'DE', latitude: 52.5200, longitude: 13.4050,
  });
  siteBrno = await createSite(tenantB.id, {
    name: 'Foreign Site', city: 'Brno', region: 'Jihomoravský',
    country: 'Česko', country_code: 'CZ', latitude: 49.1951, longitude: 16.6068,
  });

  devKyiv1  = await createDevice(tenantA.id, { name: 'Kyiv cabinet 1' });
  devKyiv2  = await createDevice(tenantA.id, { name: 'Kyiv cabinet 2' });
  devLviv   = await createDevice(tenantA.id, { name: 'Lviv cabinet' });
  devBerlin = await createDevice(tenantA.id, { name: 'Berlin cabinet' });
  // No site and no coordinates: it must land in the null-key group, not vanish.
  await createDevice(tenantA.id, { name: 'Unplaced cabinet' });
  devBrno   = await createDevice(tenantB.id, { name: 'Brno cabinet' });

  await updateDevice(devKyiv1.id,  { site_id: siteKyiv.id,   online: true,  model: 'MX-1', firmware_version: '1.2.3' });
  await updateDevice(devKyiv2.id,  { site_id: siteKyiv.id,   online: false, model: 'MX-1', firmware_version: '1.2.3' });
  await updateDevice(devLviv.id,   { site_id: siteLviv.id,   online: true,  model: 'MX-2', firmware_version: '2.0.0' });
  await updateDevice(devBerlin.id, { site_id: siteBerlin.id, online: false, model: 'MX-2', firmware_version: '2.0.0' });
  await updateDevice(devBrno.id,   { site_id: siteBrno.id,   online: true });

  await grantDeviceAccess(techDevice.id, devKyiv1.id, admin.id);
  await grantSiteAccess(techSite.id, siteLviv, admin.id);

  // ── Alarms ────────────────────────────────────────────
  // Kyiv-1: 2 active + 1 cleared inside the window, 1 cleared well before it.
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { code: 'HIGH_TEMP',   active: true,  at: inWindow(1 * HOUR) });
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { code: 'DOOR_OPEN',   active: true,  at: inWindow(2 * HOUR) });
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { code: 'SENSOR_FAIL', active: false, at: inWindow(3 * HOUR) });
  await createAlarm(tenantA.id, devKyiv1.mqtt_device_id, { code: 'OLD',         active: false, at: beforeWindow(30) });
  // Lviv: 1 active inside the window.
  await createAlarm(tenantA.id, devLviv.mqtt_device_id,  { code: 'HIGH_TEMP',   active: true,  at: inWindow(1 * HOUR) });
  // Tenant B — must never leak into tenant A's numbers.
  await createAlarm(tenantB.id, devBrno.mqtt_device_id,  { code: 'HIGH_TEMP',   active: true,  at: inWindow(1 * HOUR) });

  // ── Telemetry ─────────────────────────────────────────
  // air: Kyiv-1 -2/-4, Kyiv-2 -6, Lviv -10  → Kyiv avg -4, Lviv avg -10, UA avg -5.5
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'air', -2, inWindow(1 * HOUR));
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'air', -4, inWindow(2 * HOUR));
  await addTelemetry(tenantA.id, devKyiv2.mqtt_device_id, 'air', -6, inWindow(1 * HOUR));
  await addTelemetry(tenantA.id, devLviv.mqtt_device_id,  'air', -10, inWindow(1 * HOUR));
  // Outside the window on both sides — must be excluded.
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'air', 100, beforeWindow(20));
  await addTelemetry(tenantB.id, devBrno.mqtt_device_id,  'air', 50,  inWindow(1 * HOUR));
  // energy: Kyiv 1.5 + 2.5 + 0.5 = 4.5, Lviv 3.0, Berlin none → null
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'energy', 1.5, inWindow(1 * HOUR));
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'energy', 2.5, inWindow(2 * HOUR));
  await addTelemetry(tenantA.id, devKyiv2.mqtt_device_id, 'energy', 0.5, inWindow(1 * HOUR));
  await addTelemetry(tenantA.id, devLviv.mqtt_device_id,  'energy', 3.0, inWindow(1 * HOUR));
  await addTelemetry(tenantA.id, devKyiv1.mqtt_device_id, 'energy', 99,  beforeWindow(20));
  await addTelemetry(tenantB.id, devBrno.mqtt_device_id,  'energy', 7,   inWindow(1 * HOUR));

  // ── Service records ───────────────────────────────────
  await addServiceRecord(tenantA.id, devKyiv1.id, inWindow(2 * DAY));
  await addServiceRecord(tenantA.id, devKyiv1.id, inWindow(3 * DAY));
  await addServiceRecord(tenantA.id, devLviv.id,  inWindow(4 * DAY));
  await addServiceRecord(tenantA.id, devKyiv2.id, beforeWindow(60));   // outside
  await addServiceRecord(tenantB.id, devBrno.id,  inWindow(2 * DAY));  // other tenant

  // ── Uptime evidence ───────────────────────────────────
  // Kyiv-1: online before the window and never toggles  → 100 %
  // Kyiv-2: offline before the window and never toggles →   0 %
  // Lviv:   online before the window, goes offline at the midpoint → 50 %
  // Berlin / unplaced: no events at all → no evidence → uptime_pct null
  await addEvent(tenantA.id, devKyiv1.mqtt_device_id, 'device_online',  beforeWindow(1));
  await addEvent(tenantA.id, devKyiv2.mqtt_device_id, 'device_offline', beforeWindow(1));
  await addEvent(tenantA.id, devLviv.mqtt_device_id,  'device_online',  beforeWindow(1));
  await addEvent(tenantA.id, devLviv.mqtt_device_id,  'device_offline', inWindow(4 * DAY));
  await addEvent(tenantB.id, devBrno.mqtt_device_id,  'device_online',  beforeWindow(1));
});

afterAll(async () => {
  await cleanDatabase();
  await shutdownDb();
});

// ── Auth ─────────────────────────────────────────────────

describe('GET /api/stats/geo — auth', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stats/geo');
    expect(res.status).toBe(401);
  });

  it('requires authentication on the CSV export too', async () => {
    const res = await request(app).get('/api/stats/geo/export.csv');
    expect(res.status).toBe(401);
  });

  it('is readable by a viewer (narrowing is RBAC, not role)', async () => {
    const res = await request(app).get('/api/stats/geo').query(q())
      .set(authHeader(viewer, tenantA.id));
    expect(res.status).toBe(200);
    // The viewer holds no grants at all, so the whole table is empty.
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.totals.device_count).toBe(0);
  });
});

// ── group_by whitelist ───────────────────────────────────

describe('GET /api/stats/geo — group_by whitelist', () => {
  it('rejects an injected group_by with 400, never 500', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city);DROP--' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.status).toBe(400);
  });

  it('rejects a bare SQL fragment as group_by', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 's.city, (SELECT password_hash FROM users)' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(400);
  });

  it('leaves the users table intact after the injection attempts', async () => {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('accepts every whitelisted group_by', async () => {
    for (const groupBy of ['country', 'region', 'city', 'site']) {
      const res = await request(app).get('/api/stats/geo')
        .query(q({ group_by: groupBy }))
        .set(authHeader(admin, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.meta.group_by).toBe(groupBy);
    }
  });

  it('defaults to country when group_by is omitted', async () => {
    const res = await request(app).get('/api/stats/geo').query(q())
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.meta.group_by).toBe('country');
  });

  it('rejects an injected sort and an injected order', async () => {
    const bad = await request(app).get('/api/stats/geo')
      .query(q({ sort: 'device_count; DROP TABLE devices' }))
      .set(authHeader(admin, tenantA.id));
    expect(bad.status).toBe(400);

    const worse = await request(app).get('/api/stats/geo')
      .query(q({ order: 'asc; DROP TABLE devices' }))
      .set(authHeader(admin, tenantA.id));
    expect(worse.status).toBe(400);

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'devices'`
    );
    expect(rows[0].n).toBe(1);
  });
});

// ── Other validation: 400, never 500 ─────────────────────

describe('GET /api/stats/geo — parameter validation', () => {
  const cases = [
    ['bbox=a,b,c,d',        { bbox: 'a,b,c,d' }],
    ['bbox with 3 parts',   { bbox: '1,2,3' }],
    ['bbox out of range',   { bbox: '-200,-95,200,95' }],
    ['bbox min > max',      { bbox: '30,50,20,40' }],
    ['from=notadate',       { from: 'notadate' }],
    ['to=notadate',         { to: 'notadate' }],
    ['from after to',       { from: TO.toISOString(), to: FROM.toISOString() }],
    ['status=weird',        { status: 'weird' }],
    ['country_code=UAX',    { country_code: 'UAX' }],
    ['site_id=notauuid',    { site_id: 'notauuid' }],
    ['tenant_id=notauuid',  { tenant_id: 'notauuid' }],
    ['q too long',          { q: 'x'.repeat(201) }],
  ];

  for (const [label, extra] of cases) {
    it(`returns 400 for ${label}`, async () => {
      const res = await request(app).get('/api/stats/geo')
        .query({ ...RANGE, ...extra })
        .set(authHeader(admin, tenantA.id));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });
  }

  it('clamps an over-long range instead of rejecting it', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query({ from: '2020-01-01T00:00:00.000Z', to: TO.toISOString() })
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.meta.clamped).toBe(true);
    expect(new Date(res.body.meta.to) - new Date(res.body.meta.from)).toBe(366 * DAY);
  });

  it('reports the effective range back in meta', async () => {
    const res = await request(app).get('/api/stats/geo').query(q())
      .set(authHeader(admin, tenantA.id));
    expect(res.body.meta.from).toBe(FROM.toISOString());
    expect(res.body.meta.to).toBe(TO.toISOString());
    expect(res.body.meta.clamped).toBe(false);
    expect(res.body.meta.truncated).toBe(false);
  });
});

// ── Aggregate arithmetic ─────────────────────────────────

describe('GET /api/stats/geo — aggregate math (group_by=city)', () => {
  let cityRes;

  beforeAll(async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    cityRes = res;
  });

  it('groups every device, including the one with no site', () => {
    expect(cityRes.body.data).toHaveLength(4);        // Київ, Львів, Berlin, (no site)
    expect(nullRow(cityRes).device_count).toBe(1);
    expect(nullRow(cityRes).label).toBeNull();
  });

  it('counts devices, online and offline per city', () => {
    const m = byLabel(cityRes);
    expect(m.get('Київ')).toMatchObject({ device_count: 2, online_count: 1, offline_count: 1 });
    expect(m.get('Львів')).toMatchObject({ device_count: 1, online_count: 1, offline_count: 0 });
    expect(m.get('Berlin')).toMatchObject({ device_count: 1, online_count: 0, offline_count: 1 });
  });

  it('counts active alarms without a time filter and period alarms with one', () => {
    const m = byLabel(cityRes);
    // Kyiv-1 has 2 active + 1 cleared inside the window, and 1 cleared before it.
    expect(m.get('Київ').alarm_count).toBe(2);
    expect(m.get('Київ').alarms_period).toBe(3);
    expect(m.get('Львів').alarm_count).toBe(1);
    expect(m.get('Львів').alarms_period).toBe(1);
    expect(m.get('Berlin').alarm_count).toBe(0);
    expect(m.get('Berlin').alarms_period).toBe(0);
  });

  it('averages air temperature by sample, not by device', () => {
    const m = byLabel(cityRes);
    // Kyiv: (-2 + -4 + -6) / 3 = -4 — a mean of per-device means would give -4.5.
    expect(m.get('Київ').avg_air_temp).toBe(-4);
    expect(m.get('Львів').avg_air_temp).toBe(-10);
  });

  it('reports null, not zero, for a metric with no samples', () => {
    const m = byLabel(cityRes);
    expect(m.get('Berlin').avg_air_temp).toBeNull();
    expect(m.get('Berlin').energy_kwh).toBeNull();
    expect(m.get('Berlin').uptime_pct).toBeNull();
    // …while a genuinely empty count stays a real zero.
    expect(m.get('Berlin').alarm_count).toBe(0);
    expect(m.get('Berlin').service_visits).toBe(0);
  });

  it('sums energy from the Phase 13 telemetry channel', () => {
    const m = byLabel(cityRes);
    expect(m.get('Київ').energy_kwh).toBe(4.5);    // 1.5 + 2.5 + 0.5; the 99 kWh row is outside the window
    expect(m.get('Львів').energy_kwh).toBe(3);
  });

  it('counts service_records in range, joined on the device UUID', () => {
    const m = byLabel(cityRes);
    expect(m.get('Київ').service_visits).toBe(2);  // the third Kyiv record is 60 days old
    expect(m.get('Львів').service_visits).toBe(1);
  });

  it('derives uptime from device_online/offline events, seeded from before the window', () => {
    const m = byLabel(cityRes);
    // Kyiv-1 online throughout (100 %) + Kyiv-2 offline throughout (0 %) → 50 %.
    expect(m.get('Київ').uptime_pct).toBe(50);
    // Lviv went offline exactly at the midpoint of an 8-day window.
    expect(m.get('Львів').uptime_pct).toBe(50);
  });

  it('puts the period totals in meta.totals', () => {
    const t = cityRes.body.meta.totals;
    expect(t.device_count).toBe(5);
    expect(t.online_count).toBe(2);
    expect(t.offline_count).toBe(3);
    expect(t.alarm_count).toBe(3);
    expect(t.alarms_period).toBe(4);
    expect(t.service_visits).toBe(3);
    expect(t.energy_kwh).toBe(7.5);
    expect(t.avg_air_temp).toBe(-5.5);             // (-2 -4 -6 -10) / 4
    expect(t.uptime_pct).toBe(50);                 // (100 + 0 + 50) / 3
    expect(t).not.toHaveProperty('key');
    expect(t).not.toHaveProperty('label');
  });
});

describe('GET /api/stats/geo — the other group_by modes', () => {
  it('rolls cities up into countries', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'country' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);

    const m = byLabel(res);
    expect(m.get('Україна')).toMatchObject({
      key: 'UA', device_count: 3, online_count: 2, offline_count: 1,
      alarm_count: 3, alarms_period: 4, service_visits: 3,
    });
    expect(m.get('Україна').energy_kwh).toBe(7.5);
    expect(m.get('Україна').avg_air_temp).toBe(-5.5);
    expect(m.get('Україна').uptime_pct).toBe(50);

    expect(m.get('Deutschland')).toMatchObject({ key: 'DE', device_count: 1 });
    expect(nullRow(res).device_count).toBe(1);
  });

  it('groups by region, keeping Kyiv as its own region', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'region' }))
      .set(authHeader(admin, tenantA.id));
    const m = byLabel(res);
    expect(m.get('Київ').device_count).toBe(2);
    expect(m.get('Львівська область').device_count).toBe(1);
    expect(m.get('Berlin').device_count).toBe(1);
  });

  it('groups by site and keys on the site UUID for the drill-down', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'site' }))
      .set(authHeader(admin, tenantA.id));
    const m = byLabel(res);
    expect(m.get('АТБ №142').key).toBe(siteKyiv.id);
    expect(m.get('АТБ №142').device_count).toBe(2);
    expect(m.get('Сільпо №7').key).toBe(siteLviv.id);
    expect(m.get('Kaufland Mitte').key).toBe(siteBerlin.id);
    expect(nullRow(res).device_count).toBe(1);
  });
});

// ── Sorting ──────────────────────────────────────────────

describe('GET /api/stats/geo — sorting', () => {
  it('sorts by device_count descending by default', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(admin, tenantA.id));
    const counts = res.body.data.map(r => r.device_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(res.body.data[0].label).toBe('Київ');
  });

  it('honours a whitelisted sort + order', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', sort: 'label', order: 'asc' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.meta.sort).toBe('label');
    expect(res.body.meta.order).toBe('asc');
    // NULLS LAST — the unplaced device's group sorts to the bottom.
    expect(res.body.data[0].label).toBe('Berlin');
    expect(res.body.data[res.body.data.length - 1].label).toBeNull();
  });

  it('puts the largest energy consumer first when asked', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', sort: 'energy_kwh', order: 'desc' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data[0].label).toBe('Київ');
    expect(res.body.data[0].energy_kwh).toBe(4.5);
  });
});

// ── Filters ──────────────────────────────────────────────

describe('GET /api/stats/geo — filters', () => {
  it('filters by country_code', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', country_code: 'ua' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data.map(r => r.label).sort()).toEqual(['Київ', 'Львів']);
    expect(res.body.meta.totals.device_count).toBe(3);
  });

  it('filters by city', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'site', city: 'Львів' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].key).toBe(siteLviv.id);
  });

  it('filters by site_id', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', site_id: siteKyiv.id }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: 'Київ', device_count: 2 });
  });

  it('filters by status=online', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', status: 'online' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.meta.totals.device_count).toBe(2);
    expect(res.body.meta.totals.offline_count).toBe(0);
  });

  it('filters by status=alarm', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', status: 'alarm' }))
      .set(authHeader(admin, tenantA.id));
    // Kyiv-1 and Lviv carry active alarms.
    expect(res.body.meta.totals.device_count).toBe(2);
  });

  it('filters by model and firmware_version', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', model: 'MX-1', firmware_version: '1.2.3' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: 'Київ', device_count: 2 });
  });

  it('filters by free-text q over device and site names', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', q: 'Сільпо' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].label).toBe('Львів');
  });

  it('filters by bbox on effective coordinates', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', bbox: '23,49,31,51' }))   // Ukraine only
      .set(authHeader(admin, tenantA.id));
    expect(res.body.data.map(r => r.label).sort()).toEqual(['Київ', 'Львів']);
  });

  it('narrows alarms_period, energy and service_visits when the window shrinks', async () => {
    // A 2-hour window that contains only the very first fixture rows.
    const res = await request(app).get('/api/stats/geo')
      .query({
        group_by: 'city',
        from: FROM.toISOString(),
        to: inWindow(90 * 60 * 1000).toISOString(),   // FROM + 1.5 h
      })
      .set(authHeader(admin, tenantA.id));
    const m = byLabel(res);
    expect(m.get('Київ').alarms_period).toBe(1);     // only the 1 h alarm
    expect(m.get('Київ').energy_kwh).toBe(2);        // 1.5 + 0.5; the 2 h row is out
    expect(m.get('Київ').avg_air_temp).toBe(-4);     // (-2 + -6) / 2
    expect(m.get('Київ').service_visits).toBe(0);    // all visits are days later
  });

  it('rejects ?user_id= from a non-admin', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ user_id: techDevice.id }))
      .set(authHeader(techDevice, tenantA.id));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('resolves ?user_id= for an admin as user_devices ∪ user_sites', async () => {
    const viaDevice = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', user_id: techDevice.id }))
      .set(authHeader(admin, tenantA.id));
    expect(viaDevice.body.data).toHaveLength(1);
    expect(viaDevice.body.data[0]).toMatchObject({ label: 'Київ', device_count: 1 });

    const viaSite = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', user_id: techSite.id }))
      .set(authHeader(admin, tenantA.id));
    expect(viaSite.body.data).toHaveLength(1);
    expect(viaSite.body.data[0]).toMatchObject({ label: 'Львів', device_count: 1 });

    const none = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', user_id: techNone.id }))
      .set(authHeader(admin, tenantA.id));
    expect(none.body.data).toEqual([]);
  });
});

// ── Tenant isolation ─────────────────────────────────────

describe('GET /api/stats/geo — tenant isolation', () => {
  it('never shows tenant A anything from tenant B', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(admin, tenantA.id));
    const labels = res.body.data.map(r => r.label);
    expect(labels).not.toContain('Brno');
    expect(res.body.meta.totals.device_count).toBe(5);
    // Tenant B's alarm / telemetry / service row must not inflate A's metrics.
    expect(res.body.meta.totals.alarm_count).toBe(3);
    expect(res.body.meta.totals.energy_kwh).toBe(7.5);
    expect(res.body.meta.totals.service_visits).toBe(3);
  });

  it('never shows tenant B anything from tenant A', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(adminB, tenantB.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: 'Brno', device_count: 1, online_count: 1 });
    expect(res.body.meta.totals.energy_kwh).toBe(7);
    expect(res.body.meta.totals.alarm_count).toBe(1);
  });

  it('ignores a forged tenant_id from a non-superadmin', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', tenant_id: tenantB.id }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    // tenant_id is a superadmin-only facet; the tenant predicate still wins.
    expect(res.body.data.map(r => r.label)).not.toContain('Brno');
    expect(res.body.meta.totals.device_count).toBe(5);
  });

  it('ignores an unknown tenant_id from a non-superadmin as well', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', tenant_id: randomUUID() }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.meta.totals.device_count).toBe(5);
  });

  it('lets a superadmin span tenants, and scope back down with tenant_id', async () => {
    const all = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(superadmin, tenantA.id));
    expect(all.status).toBe(200);
    expect(all.body.data.map(r => r.label)).toContain('Brno');
    expect(all.body.meta.totals.device_count).toBe(6);

    const onlyB = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city', tenant_id: tenantB.id }))
      .set(authHeader(superadmin, tenantA.id));
    expect(onlyB.body.data).toHaveLength(1);
    expect(onlyB.body.data[0].label).toBe('Brno');
  });
});

// ── RBAC ─────────────────────────────────────────────────

describe('GET /api/stats/geo — RBAC', () => {
  it('shows a device-granted technician exactly their one device', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(techDevice, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      label: 'Київ', device_count: 1, online_count: 1, offline_count: 0,
    });
  });

  it('never leaks metrics of an invisible device into a visible group', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(techDevice, tenantA.id));
    const kyiv = res.body.data[0];
    // Kyiv-2 is on the same site but not granted: its alarm-free row, its -6 °C
    // sample, its 0.5 kWh and its uptime of 0 % must all stay out.
    expect(kyiv.alarm_count).toBe(2);
    expect(kyiv.alarms_period).toBe(3);
    expect(kyiv.avg_air_temp).toBe(-3);       // (-2 + -4) / 2, not -4
    expect(kyiv.energy_kwh).toBe(4);          // 1.5 + 2.5, not 4.5
    expect(kyiv.uptime_pct).toBe(100);        // Kyiv-1 alone, not the 50 % pair average
    expect(kyiv.service_visits).toBe(2);
  });

  it('shows a site-granted technician exactly that site', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(techSite, tenantA.id));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: 'Львів', device_count: 1 });
    expect(res.body.data[0].energy_kwh).toBe(3);
  });

  it('shows a technician with no grants an empty table, not the whole tenant', async () => {
    const res = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(techNone, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.totals).toMatchObject({
      device_count: 0, online_count: 0, offline_count: 0,
      alarm_count: 0, alarms_period: 0, service_visits: 0,
    });
    expect(res.body.meta.totals.energy_kwh).toBeNull();
    expect(res.body.meta.totals.avg_air_temp).toBeNull();
    expect(res.body.meta.totals.uptime_pct).toBeNull();
  });

  it('follows a revoked site grant', async () => {
    const tempTech = await createUser(tenantA.id, { role: 'technician', email: 'temp@geostats.test' });
    await grantSiteAccess(tempTech.id, siteKyiv, admin.id);

    const granted = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(tempTech, tenantA.id));
    expect(granted.body.data).toHaveLength(1);
    expect(granted.body.data[0].device_count).toBe(2);

    await db.query('DELETE FROM user_sites WHERE user_id = $1', [tempTech.id]);

    const revoked = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(tempTech, tenantA.id));
    expect(revoked.body.data).toEqual([]);

    await db.query('DELETE FROM users WHERE id = $1', [tempTech.id]);
  });

  it('does not honour a site grant held in another tenant', async () => {
    // The grant is real, but it belongs to tenant B while the caller acts in A.
    const crossTech = await createUser(tenantA.id, { role: 'technician', email: 'cross@geostats.test' });
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [crossTech.id, tenantB.id]
    );
    await grantSiteAccess(crossTech.id, siteBrno, adminB.id);

    const inA = await request(app).get('/api/stats/geo')
      .query(q({ group_by: 'city' }))
      .set(authHeader(crossTech, tenantA.id));
    expect(inA.status).toBe(200);
    expect(inA.body.data).toEqual([]);

    await db.query('DELETE FROM user_sites WHERE user_id = $1', [crossTech.id]);
    await db.query('DELETE FROM user_tenants WHERE user_id = $1', [crossTech.id]);
    await db.query('DELETE FROM users WHERE id = $1', [crossTech.id]);
  });
});

// ── CSV export ───────────────────────────────────────────

describe('GET /api/stats/geo/export.csv', () => {
  it('returns a CSV attachment with a BOM and a TOTAL line', async () => {
    const res = await request(app).get('/api/stats/geo/export.csv')
      .query(q({ group_by: 'city' }))
      .set(authHeader(admin, tenantA.id));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/geo_stats_city_.*\.csv/);

    const body = res.text;
    expect(body.charCodeAt(0)).toBe(0xFEFF);           // Excel Cyrillic BOM

    const lines = body.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      'Key,Label,Devices,Online,Offline,Active alarms,Alarms in period,' +
      'Avg air temp (°C),Uptime (%),Energy (kWh),Service visits'
    );
    expect(lines).toHaveLength(1 + 4 + 1);             // header + 4 groups + TOTAL

    const kyiv = lines.find(l => l.includes('Київ'));
    expect(kyiv).toBeTruthy();
    expect(kyiv.split(',')).toContain('4.5');          // energy

    const total = lines[lines.length - 1];
    expect(total).toMatch(/^,TOTAL,5,2,3,3,4,-5.5,50,7.5,3$/);
  });

  it('leaves an unknown metric blank rather than writing 0', async () => {
    const res = await request(app).get('/api/stats/geo/export.csv')
      .query(q({ group_by: 'city' }))
      .set(authHeader(admin, tenantA.id));
    const berlin = res.text.split(/\r?\n/).find(l => l.startsWith('Berlin,Berlin,'));
    // key,label,devices,online,offline,active,period,avg,uptime,energy,visits
    expect(berlin).toBe('Berlin,Berlin,1,0,1,0,0,,,,0');
  });

  it('applies the same RBAC as the JSON endpoint', async () => {
    const res = await request(app).get('/api/stats/geo/export.csv')
      .query(q({ group_by: 'city' }))
      .set(authHeader(techSite, tenantA.id));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Львів');
    expect(res.text).not.toContain('Київ');
    expect(res.text).not.toContain('Berlin');
  });

  it('rejects an injected group_by before producing any file', async () => {
    const res = await request(app).get('/api/stats/geo/export.csv')
      .query(q({ group_by: 'city);DROP--' }))
      .set(authHeader(admin, tenantA.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
});
