'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Devices CRUD', () => {
  let tenant, admin, tech;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'devices-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@devices.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@devices.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin can list devices', async () => {
    await createDevice(tenant.id, { name: 'Dev1' });
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('admin can get single device', async () => {
    const device = await createDevice(tenant.id, { name: 'Single' });
    const res = await request(app)
      .get(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(device.id);
  });

  it('admin can update device metadata', async () => {
    const device = await createDevice(tenant.id, { name: 'Old Name' });
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ name: 'New Name', location: 'Room 101' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
    expect(res.body.data.location).toBe('Room 101');
  });

  it('viewer cannot update device', async () => {
    const viewer = await createUser(tenant.id, { role: 'viewer', email: 'v@devices.test' });
    const device = await createDevice(tenant.id, { name: 'Protected' });
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(viewer, tenant.id))
      .send({ name: 'Hacked' });

    expect([403, 404]).toContain(res.status);
  });

  it('get nonexistent device returns 404', async () => {
    const res = await request(app)
      .get('/api/devices/00000000-0000-0000-0000-000000000001')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });

  it('admin can delete device', async () => {
    const device = await createDevice(tenant.id, { name: 'To Delete' });
    const res = await request(app)
      .delete(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });
});
