'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Password Reset', () => {
  let tenant, admin, viewer, targetUser;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ name: 'Reset Tenant', slug: 'reset-tenant' });
    admin = await createUser(tenant.id, { email: 'admin@reset.test', role: 'admin' });
    viewer = await createUser(tenant.id, { email: 'viewer@reset.test', role: 'viewer' });
    targetUser = await createUser(tenant.id, { email: 'target@reset.test', role: 'technician' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Admin generates code ──

  it('admin can generate reset code for a user', async () => {
    const res = await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.reset_code).toHaveLength(16);
    expect(res.body.data.email).toBe('target@reset.test');
    expect(res.body.data.expires_at).toBeTruthy();
  });

  it('viewer cannot generate reset codes (403)', async () => {
    const res = await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  // ── User resets password with code ──

  it('user can reset password with valid code', async () => {
    // Generate code
    const genRes = await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(admin, tenant.id));

    const code = genRes.body.data.reset_code;

    // Reset password
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'target@reset.test', reset_code: code, new_password: 'NewPass123!' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/reset/i);
  });

  it('new password works for login after reset', async () => {
    // Generate fresh code
    const genRes = await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(admin, tenant.id));

    const code = genRes.body.data.reset_code;

    // Reset to known password
    await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'target@reset.test', reset_code: code, new_password: 'ResetTest999' });

    // Login with new password
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'target@reset.test', password: 'ResetTest999' });

    expect(loginRes.status).toBe(200);
  });

  it('old password fails after reset', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'target@reset.test', password: targetUser._password });

    expect(loginRes.status).toBe(401);
  });

  // ── Negative cases ──

  it('returns 400 for wrong reset code', async () => {
    // Generate a code first so the user has one set
    await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(admin, tenant.id));

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'target@reset.test', reset_code: 'aaaaaaaaaaaaaaaa', new_password: 'WrongCode123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
  });

  it('returns 400 for non-existent email', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'nobody@nowhere.test', reset_code: 'aaaaaaaaaaaaaaaa', new_password: 'NoBody123!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
  });

  it('returns 400 for expired code', async () => {
    // Generate code
    const genRes = await request(app)
      .post(`/api/users/${targetUser.id}/password-reset`)
      .set(authHeader(admin, tenant.id));

    const code = genRes.body.data.reset_code;

    // Manually expire the code in DB
    const db = require('../src/services/db');
    await db.query(
      "UPDATE users SET password_reset_expires = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [targetUser.id]
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'target@reset.test', reset_code: code, new_password: 'Expired123!' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent user when admin generates code', async () => {
    const res = await request(app)
      .post('/api/users/00000000-0000-0000-0000-000000000000/password-reset')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });
});
