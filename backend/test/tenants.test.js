'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Tenants CRUD', () => {
  let baseTenant, superadmin, admin;

  beforeAll(async () => {
    await cleanDatabase();
    baseTenant = await createTenant({ slug: 'tenants-test' });
    superadmin = await createUser(baseTenant.id, { role: 'superadmin', email: 'sa@tenants.test' });
    admin = await createUser(baseTenant.id, { role: 'admin', email: 'admin@tenants.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('superadmin can list tenants', async () => {
    const res = await request(app)
      .get('/api/tenants')
      .set(authHeader(superadmin, baseTenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('superadmin can create tenant', async () => {
    const res = await request(app)
      .post('/api/tenants')
      .set(authHeader(superadmin, baseTenant.id))
      .send({ name: 'New Tenant', slug: 'new-tenant', plan: 'free' });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data.slug).toBe('new-tenant');
  });

  it('superadmin can update tenant', async () => {
    const t = await createTenant({ slug: 'to-update' });
    const res = await request(app)
      .patch(`/api/tenants/${t.id}`)
      .set(authHeader(superadmin, baseTenant.id))
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Name');
  });

  it('superadmin can deactivate tenant', async () => {
    const t = await createTenant({ slug: 'to-deactivate' });
    const res = await request(app)
      .delete(`/api/tenants/${t.id}`)
      .set(authHeader(superadmin, baseTenant.id));

    expect(res.status).toBe(200);
  });

  it('admin cannot create tenant (superadmin-only)', async () => {
    const res = await request(app)
      .post('/api/tenants')
      .set(authHeader(admin, baseTenant.id))
      .send({ name: 'Fail', slug: 'fail-tenant', plan: 'free' });

    expect(res.status).toBe(403);
  });

  it('admin cannot delete tenant (superadmin-only)', async () => {
    const t = await createTenant({ slug: 'no-delete' });
    const res = await request(app)
      .delete(`/api/tenants/${t.id}`)
      .set(authHeader(admin, baseTenant.id));

    expect(res.status).toBe(403);
  });

  it('duplicate slug returns conflict', async () => {
    const res = await request(app)
      .post('/api/tenants')
      .set(authHeader(superadmin, baseTenant.id))
      .send({ name: 'Dupe', slug: baseTenant.slug, plan: 'free' });

    expect([400, 409]).toContain(res.status);
  });
});
