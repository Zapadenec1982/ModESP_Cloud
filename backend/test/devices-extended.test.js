'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Devices Extended', () => {
  let tenant, admin, tech, viewer, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'devices-ext' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@devext.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@devext.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@devext.test' });
    device = await createDevice(tenant.id, { name: 'Test Device' });
    await grantDeviceAccess(viewer.id, device.id, admin.id);
    await grantDeviceAccess(tech.id, device.id, admin.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // --- Service Records ---
  it('admin can add service record', async () => {
    const res = await request(app)
      .post(`/api/devices/${device.id}/service-records`)
      .set(authHeader(admin, tenant.id))
      .send({
        service_date: '2026-03-10',
        technician: 'John Doe',
        reason: 'Annual maintenance',
        work_done: 'Replaced filter, calibrated sensors',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.technician).toBe('John Doe');
  });

  it('admin can list service records', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/service-records`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('technician can add service record', async () => {
    const res = await request(app)
      .post(`/api/devices/${device.id}/service-records`)
      .set(authHeader(tech, tenant.id))
      .send({
        service_date: '2026-03-12',
        technician: 'Jane Tech',
        reason: 'Urgent fix',
        work_done: 'Replaced compressor',
      });

    expect(res.status).toBe(201);
  });

  it('rejects invalid service record (missing fields)', async () => {
    const res = await request(app)
      .post(`/api/devices/${device.id}/service-records`)
      .set(authHeader(admin, tenant.id))
      .send({ service_date: '2026-03-10' }); // missing technician, reason, work_done

    expect(res.status).toBe(400);
  });

  it('admin can delete service record', async () => {
    // Create one first
    const createRes = await request(app)
      .post(`/api/devices/${device.id}/service-records`)
      .set(authHeader(admin, tenant.id))
      .send({
        service_date: '2026-01-01',
        technician: 'To Delete',
        reason: 'Test',
        work_done: 'Test',
      });
    const recordId = createRes.body.data.id;

    const res = await request(app)
      .delete(`/api/devices/${device.id}/service-records/${recordId}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  // --- Device commands ---
  it('rejects command with missing key', async () => {
    const res = await request(app)
      .post(`/api/devices/${device.id}/command`)
      .set(authHeader(admin, tenant.id))
      .send({ value: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  // --- PATCH validation ---
  it('rejects patch with empty body', async () => {
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({});

    expect(res.status).toBe(400);
  });

  // --- Viewer can read device (with device access) ---
  it('viewer with device access can get device', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}`)
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(device.id);
  });

  // --- Viewer without access cannot see unassigned device ---
  it('viewer without access cannot get unassigned device', async () => {
    const unassigned = await createDevice(tenant.id, { name: 'No Access' });
    const res = await request(app)
      .get(`/api/devices/${unassigned.id}`)
      .set(authHeader(viewer, tenant.id));

    expect([403, 404]).toContain(res.status);
  });
});
