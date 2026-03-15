'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Telemetry', () => {
  let tenant, admin, viewer, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'telem-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@telem.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@telem.test' });
    device = await createDevice(tenant.id, { name: 'Telem Dev', mqttId: 'TLM001' });
    await grantDeviceAccess(viewer.id, device.id, admin.id);

    // Insert telemetry data
    await db.query(
      `INSERT INTO telemetry (tenant_id, device_id, channel, value, time)
       VALUES ($1, $2, 'temperature', 25.5, NOW() - INTERVAL '1 hour'),
              ($1, $2, 'temperature', 26.0, NOW() - INTERVAL '30 minutes'),
              ($1, $2, 'humidity', 60, NOW() - INTERVAL '1 hour')`,
      [tenant.id, device.mqtt_device_id]
    );
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── GET /api/devices/:id/telemetry ──

  it('admin can get device telemetry', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('can filter telemetry by channel', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry?channels=temperature`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    res.body.data.forEach(row => expect(row.channel).toBe('temperature'));
  });

  it('viewer with device access can get telemetry', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry`)
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for nonexistent device telemetry', async () => {
    const res = await request(app)
      .get('/api/devices/00000000-0000-0000-0000-000000000099/telemetry')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });

  // ── GET /api/devices/:id/telemetry/stats ──

  it('returns aggregated telemetry stats', async () => {
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const to = new Date().toISOString();
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry/stats?from=${from}&to=${to}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('buckets');
    expect(res.body.data).toHaveProperty('summary');
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry`);

    expect(res.status).toBe(401);
  });
});
