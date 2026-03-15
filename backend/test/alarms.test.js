'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Alarms', () => {
  let tenant, admin, viewer, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'alarms-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@alarms.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@alarms.test' });
    device = await createDevice(tenant.id, { name: 'Alarm Dev', mqttId: 'ALM001' });
    await grantDeviceAccess(viewer.id, device.id, admin.id);

    // Insert test alarms
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, value, limit_value, triggered_at)
       VALUES ($1, $2, 'HIGH_TEMP', 'critical', true, 95, 80, NOW() - INTERVAL '1 hour'),
              ($1, $2, 'LOW_PRESSURE', 'warning', false, 10, 20, NOW() - INTERVAL '2 hours')`,
      [tenant.id, device.mqtt_device_id]
    );
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── GET /api/alarms ──

  it('admin can list all alarms', async () => {
    const res = await request(app)
      .get('/api/alarms')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('can filter active alarms only', async () => {
    const res = await request(app)
      .get('/api/alarms?active=true')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    res.body.data.forEach(a => expect(a.active).toBe(true));
  });

  it('can filter inactive alarms only', async () => {
    const res = await request(app)
      .get('/api/alarms?active=false')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    res.body.data.forEach(a => expect(a.active).toBe(false));
  });

  it('respects limit and offset', async () => {
    const res = await request(app)
      .get('/api/alarms?limit=1&offset=0')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  // ── GET /api/alarms/stats ──

  it('returns alarm stats grouped by alarm_code', async () => {
    const res = await request(app)
      .get('/api/alarms/stats')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const stat = res.body.data[0];
    expect(stat).toHaveProperty('alarm_code');
    expect(stat).toHaveProperty('count');
    expect(stat).toHaveProperty('avg_duration_sec');
  });

  // ── GET /api/devices/:id/alarms ──

  it('can get alarms for a specific device by UUID', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/alarms`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('can get alarms for device by mqtt_device_id', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.mqtt_device_id}/alarms`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for nonexistent device alarms', async () => {
    const res = await request(app)
      .get('/api/devices/NOEXST/alarms')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });
});
