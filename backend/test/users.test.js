'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Users CRUD', () => {
  let tenant, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'users-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@users.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@users.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin can list users', async () => {
    const res = await request(app)
      .get('/api/users')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('admin can create user', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(admin, tenant.id))
      .send({ email: 'new-user@users.test', password: 'Test1234!', role: 'viewer' });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data.email).toBe('new-user@users.test');
  });

  it('admin can update user role', async () => {
    const user = await createUser(tenant.id, { role: 'viewer', email: 'to-promote@users.test' });
    const res = await request(app)
      .put(`/api/users/${user.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ role: 'technician' });

    expect(res.status).toBe(200);
  });

  it('admin can deactivate user', async () => {
    const user = await createUser(tenant.id, { email: 'to-deactivate@users.test' });
    const res = await request(app)
      .delete(`/api/users/${user.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });

  it('viewer cannot list users (403)', async () => {
    const res = await request(app)
      .get('/api/users')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  it('viewer cannot create user (403)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(viewer, tenant.id))
      .send({ email: 'fail@users.test', password: 'Test1234!', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  it('admin cannot escalate to superadmin', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(admin, tenant.id))
      .send({ email: 'escalate@users.test', password: 'Test1234!', role: 'superadmin' });

    // Should be rejected — admin cannot create superadmin
    expect([400, 403]).toContain(res.status);
  });

  it('duplicate email returns conflict', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(admin, tenant.id))
      .send({ email: admin.email, password: 'Test1234!', role: 'viewer' });

    expect([400, 409]).toContain(res.status);
  });
});
