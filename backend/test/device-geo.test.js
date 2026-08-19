'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Device geolocation', () => {
  let tenant, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'geo-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@geo.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@geo.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin can set coordinates via PATCH', async () => {
    const device = await createDevice(tenant.id);
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ latitude: 50.4501, longitude: 30.5234 });

    expect(res.status).toBe(200);
    expect(res.body.data.latitude).toBe(50.4501);
    expect(res.body.data.longitude).toBe(30.5234);
  });

  it('coordinates appear in the device list', async () => {
    const device = await createDevice(tenant.id, { latitude: 49.8397, longitude: 24.0297 });
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    const found = res.body.data.find(d => d.id === device.id);
    expect(found).toBeDefined();
    expect(found.latitude).toBe(49.8397);
    expect(found.longitude).toBe(24.0297);
  });

  it('coordinates appear in device detail', async () => {
    const device = await createDevice(tenant.id, { latitude: 46.4825, longitude: 30.7233 });
    const res = await request(app)
      .get(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.latitude).toBe(46.4825);
    expect(res.body.data.longitude).toBe(30.7233);
  });

  it('rejects out-of-range latitude', async () => {
    const device = await createDevice(tenant.id);
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ latitude: 91, longitude: 30 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('rejects out-of-range longitude', async () => {
    const device = await createDevice(tenant.id);
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ latitude: 50, longitude: -181 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('null clears coordinates', async () => {
    const device = await createDevice(tenant.id, { latitude: 50.0, longitude: 30.0 });
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ latitude: null, longitude: null });

    expect(res.status).toBe(200);
    expect(res.body.data.latitude).toBeNull();
    expect(res.body.data.longitude).toBeNull();
  });

  it('viewer cannot set coordinates', async () => {
    const device = await createDevice(tenant.id);
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(viewer, tenant.id))
      .send({ latitude: 50.0, longitude: 30.0 });

    expect([403, 404]).toContain(res.status);
  });
});
