'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Fleet Summary', () => {
  let tenant, admin, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'fleet-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@fleet.test' });
    device = await createDevice(tenant.id, { name: 'Fleet Dev', mqttId: 'FLT001' });

    // Insert an active alarm
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, value, limit_value, triggered_at)
       VALUES ($1, $2, 'OVERLOAD', 'warning', true, 100, 90, NOW())`,
      [tenant.id, device.mqtt_device_id]
    );
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('returns fleet summary with device and alarm counts', async () => {
    const res = await request(app)
      .get('/api/fleet/summary')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toHaveProperty('devices_total');
    expect(d).toHaveProperty('devices_online');
    expect(d).toHaveProperty('devices_active');
    expect(d).toHaveProperty('alarms_active');
    expect(d).toHaveProperty('alarms_24h');
    expect(d.devices_total).toBeGreaterThanOrEqual(1);
    expect(d.alarms_active).toBeGreaterThanOrEqual(1);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .get('/api/fleet/summary');

    expect(res.status).toBe(401);
  });

  it('viewer can access fleet summary', async () => {
    const viewer = await createUser(tenant.id, { role: 'viewer', email: 'v@fleet.test' });
    const res = await request(app)
      .get('/api/fleet/summary')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('devices_total');
  });
});
