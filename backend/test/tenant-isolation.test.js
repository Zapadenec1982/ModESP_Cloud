'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Tenant Isolation', () => {
  let tenantA, tenantB, adminA, adminB, deviceA, deviceB;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA = await createTenant({ slug: 'isolation-a' });
    tenantB = await createTenant({ slug: 'isolation-b' });
    adminA = await createUser(tenantA.id, { role: 'admin', email: 'admin@a.test' });
    adminB = await createUser(tenantB.id, { role: 'admin', email: 'admin@b.test' });
    deviceA = await createDevice(tenantA.id, { name: 'Device A' });
    deviceB = await createDevice(tenantB.id, { name: 'Device B' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin A cannot see tenant B devices', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(adminA, tenantA.id));

    expect(res.status).toBe(200);
    const ids = res.body.data.map(d => d.id);
    expect(ids).toContain(deviceA.id);
    expect(ids).not.toContain(deviceB.id);
  });

  it('admin B cannot see tenant A devices', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(adminB, tenantB.id));

    expect(res.status).toBe(200);
    const ids = res.body.data.map(d => d.id);
    expect(ids).toContain(deviceB.id);
    expect(ids).not.toContain(deviceA.id);
  });

  it('admin A cannot access tenant B device by ID', async () => {
    const res = await request(app)
      .get(`/api/devices/${deviceB.id}`)
      .set(authHeader(adminA, tenantA.id));

    expect(res.status).toBe(404);
  });

  it('admin A cannot update tenant B device', async () => {
    const res = await request(app)
      .patch(`/api/devices/${deviceB.id}`)
      .set(authHeader(adminA, tenantA.id))
      .send({ name: 'Hacked' });

    expect([403, 404]).toContain(res.status);
  });

  it('admin A cannot delete tenant B device', async () => {
    const res = await request(app)
      .delete(`/api/devices/${deviceB.id}`)
      .set(authHeader(adminA, tenantA.id));

    expect([403, 404]).toContain(res.status);
  });

  it('admin A cannot see tenant B users', async () => {
    const res = await request(app)
      .get('/api/users')
      .set(authHeader(adminA, tenantA.id));

    expect(res.status).toBe(200);
    const emails = res.body.data.map(u => u.email);
    expect(emails).not.toContain(adminB.email);
  });

  it('admin A cannot see tenant B alarms', async () => {
    const res = await request(app)
      .get('/api/alarms')
      .set(authHeader(adminA, tenantA.id));

    expect(res.status).toBe(200);
    // All returned alarms should belong to tenant A
    for (const alarm of res.body.data) {
      expect(alarm.tenant_id).toBe(tenantA.id);
    }
  });
});
