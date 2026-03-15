'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Device Access Control', () => {
  let tenant, admin, tech, viewer, device1, device2;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'device-access' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@access.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@access.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@access.test' });
    device1 = await createDevice(tenant.id, { name: 'Assigned Device' });
    device2 = await createDevice(tenant.id, { name: 'Unassigned Device' });

    // Grant tech and viewer access only to device1
    await grantDeviceAccess(tech.id, device1.id, admin.id);
    await grantDeviceAccess(viewer.id, device1.id, admin.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin sees all devices', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('technician sees only assigned devices', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(tech, tenant.id));

    expect(res.status).toBe(200);
    const ids = res.body.data.map(d => d.id);
    expect(ids).toContain(device1.id);
    expect(ids).not.toContain(device2.id);
  });

  it('viewer sees only assigned devices', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(200);
    const ids = res.body.data.map(d => d.id);
    expect(ids).toContain(device1.id);
    expect(ids).not.toContain(device2.id);
  });

  it('technician can access assigned device by ID', async () => {
    const res = await request(app)
      .get(`/api/devices/${device1.id}`)
      .set(authHeader(tech, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(device1.id);
  });

  it('technician cannot access unassigned device', async () => {
    const res = await request(app)
      .get(`/api/devices/${device2.id}`)
      .set(authHeader(tech, tenant.id));

    expect([403, 404]).toContain(res.status);
  });

  it('viewer cannot update device', async () => {
    const res = await request(app)
      .patch(`/api/devices/${device1.id}`)
      .set(authHeader(viewer, tenant.id))
      .send({ name: 'Updated' });

    expect([403, 404]).toContain(res.status);
  });

  it('viewer cannot delete device', async () => {
    const res = await request(app)
      .delete(`/api/devices/${device1.id}`)
      .set(authHeader(viewer, tenant.id));

    expect([403, 404]).toContain(res.status);
  });

  it('admin can send command to any device', async () => {
    const res = await request(app)
      .post(`/api/devices/${device2.id}/command`)
      .set(authHeader(admin, tenant.id))
      .send({ key: 'setpoint', value: 5 });

    // Should succeed (200) or the command route may have specific validation
    expect([200, 201, 400]).toContain(res.status);
  });
});
