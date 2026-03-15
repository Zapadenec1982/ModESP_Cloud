'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Users Extended', () => {
  let tenant, admin, viewer, superadmin, tenant2;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'users-ext' });
    tenant2 = await createTenant({ slug: 'users-ext-2' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@usersext.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@usersext.test' });
    superadmin = await createUser(tenant.id, { role: 'superadmin', email: 'sa@usersext.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // --- Profile (uses admin since /api/users is gated by authorize('admin')) ---
  it('admin can get own profile', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(admin.email);
  });

  it('admin can update own email', async () => {
    const testAdmin = await createUser(tenant.id, { role: 'admin', email: 'old@usersext.test' });
    const res = await request(app)
      .put('/api/users/me')
      .set(authHeader(testAdmin, tenant.id))
      .send({ email: 'new-email@usersext.test' });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('new-email@usersext.test');
  });

  it('admin can change password with old_password', async () => {
    const testAdmin = await createUser(tenant.id, {
      role: 'admin',
      email: 'changepw@usersext.test',
      password: 'OldPass123!',
    });
    const res = await request(app)
      .put('/api/users/me')
      .set(authHeader(testAdmin, tenant.id))
      .send({ password: 'NewPass456!', old_password: 'OldPass123!' });

    expect(res.status).toBe(200);
  });

  it('rejects password change without old_password', async () => {
    const res = await request(app)
      .put('/api/users/me')
      .set(authHeader(admin, tenant.id))
      .send({ password: 'NewPass789!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('viewer cannot access /users routes (403)', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  // --- Telegram ---
  it('admin can generate telegram link code', async () => {
    const res = await request(app)
      .post('/api/users/me/telegram-link')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.link_code).toBeDefined();
    expect(res.body.data.expires_at).toBeDefined();
  });

  it('admin can unlink telegram', async () => {
    const res = await request(app)
      .delete('/api/users/me/telegram-link')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });

  it('admin can generate telegram link for user', async () => {
    const res = await request(app)
      .post(`/api/users/${viewer.id}/telegram-link`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.link_code).toBeDefined();
  });

  // --- Device access ---
  it('admin can list user devices', async () => {
    const device = await createDevice(tenant.id, { name: 'User Device' });
    await grantDeviceAccess(viewer.id, device.id, admin.id);

    const res = await request(app)
      .get(`/api/users/${viewer.id}/devices`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('admin can grant single device access', async () => {
    const device = await createDevice(tenant.id, { name: 'Grant Device' });
    const res = await request(app)
      .post(`/api/users/${viewer.id}/devices`)
      .set(authHeader(admin, tenant.id))
      .send({ device_id: device.id });

    expect(res.status).toBe(201);
  });

  it('admin can revoke device access', async () => {
    const device = await createDevice(tenant.id, { name: 'Revoke Device' });
    await grantDeviceAccess(viewer.id, device.id, admin.id);

    const res = await request(app)
      .delete(`/api/users/${viewer.id}/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });

  it('admin can bulk replace device access', async () => {
    const d1 = await createDevice(tenant.id, { name: 'Bulk1' });
    const d2 = await createDevice(tenant.id, { name: 'Bulk2' });

    const res = await request(app)
      .put(`/api/users/${viewer.id}/devices`)
      .set(authHeader(admin, tenant.id))
      .send({ device_ids: [d1.id, d2.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
  });

  // --- Self-deletion prevention ---
  it('admin cannot delete themselves', async () => {
    const res = await request(app)
      .delete(`/api/users/${admin.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  // --- Superadmin tenant membership ---
  it('superadmin can list user tenant memberships', async () => {
    const res = await request(app)
      .get(`/api/users/${viewer.id}/tenants`)
      .set(authHeader(superadmin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('superadmin can add user to another tenant', async () => {
    const res = await request(app)
      .post(`/api/users/${viewer.id}/tenants`)
      .set(authHeader(superadmin, tenant.id))
      .send({ tenant_id: tenant2.id });

    expect(res.status).toBe(201);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('admin cannot list tenant memberships (403)', async () => {
    const res = await request(app)
      .get(`/api/users/${viewer.id}/tenants`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(403);
  });
});
