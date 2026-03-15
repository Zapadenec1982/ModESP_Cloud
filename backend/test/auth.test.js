'use strict';

// globals: true in vitest.config.js — describe/it/expect available globally
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Auth & RBAC', () => {
  let tenant, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'auth-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@auth.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@auth.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Login ──────────────────────────────────────────────

  it('POST /auth/login — valid credentials returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: admin.email, password: admin._password });

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.refresh_token).toBeDefined();
    expect(res.body.data.user.email).toBe(admin.email);
    expect(res.body.data.user.role).toBe('admin');
    expect(res.body.data.tenant.id).toBe(tenant.id);
  });

  it('POST /auth/login — wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: admin.email, password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('POST /auth/login — nonexistent email returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope@nope.com', password: 'whatever' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('POST /auth/login — disabled account returns 401', async () => {
    const disabled = await createUser(tenant.id, { active: false, email: 'disabled@auth.test' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: disabled.email, password: disabled._password });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('account_disabled');
  });

  it('POST /auth/login — invalid body returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  // ── Token refresh ──────────────────────────────────────

  it('POST /auth/refresh — valid refresh token issues new pair', async () => {
    // Login first to get a refresh token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: viewer.email, password: viewer._password });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: loginRes.body.data.refresh_token });

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.refresh_token).toBeDefined();
    // Old token should be different from new
    expect(res.body.data.refresh_token).not.toBe(loginRes.body.data.refresh_token);
  });

  it('POST /auth/refresh — reusing revoked token returns 401', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: viewer.email, password: viewer._password });

    const rt = loginRes.body.data.refresh_token;

    // Use it once (revokes it)
    await request(app).post('/api/auth/refresh').send({ refresh_token: rt });

    // Try again — should fail
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: rt });

    expect(res.status).toBe(401);
  });

  // ── Logout ─────────────────────────────────────────────

  it('POST /auth/logout — revokes refresh token', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: viewer.email, password: viewer._password });

    const rt = loginRes.body.data.refresh_token;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .send({ refresh_token: rt });
    expect(logoutRes.status).toBe(200);

    // Refresh should now fail
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: rt });
    expect(res.status).toBe(401);
  });

  // ── JWT middleware ─────────────────────────────────────

  it('GET /api/devices — missing auth header returns 401', async () => {
    const res = await request(app).get('/api/devices');
    expect(res.status).toBe(401);
  });

  it('GET /api/devices — invalid token returns 401', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set('Authorization', 'Bearer invalid.jwt.token');
    expect(res.status).toBe(401);
  });

  it('GET /api/devices — valid token succeeds', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(viewer, tenant.id));
    expect(res.status).toBe(200);
  });

  // ── Role-based authorization ───────────────────────────

  it('POST /api/users — viewer gets 403', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(viewer, tenant.id))
      .send({ email: 'new@test.com', password: 'Test1234!', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  it('POST /api/users — admin gets 200/201', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(authHeader(admin, tenant.id))
      .send({ email: 'created-by-admin@test.com', password: 'Test1234!', role: 'viewer' });

    expect([200, 201]).toContain(res.status);
  });

  it('GET /api/tenants — admin gets 200 (inherits from authorize("admin"))', async () => {
    const res = await request(app)
      .get('/api/tenants')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });

  it('GET /api/tenants — viewer gets 403', async () => {
    const res = await request(app)
      .get('/api/tenants')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  // ── Superadmin ─────────────────────────────────────────

  it('superadmin can access admin routes', async () => {
    const sa = await createUser(tenant.id, { role: 'superadmin', email: 'sa@auth.test' });
    const res = await request(app)
      .get('/api/users')
      .set(authHeader(sa, tenant.id));

    expect(res.status).toBe(200);
  });
});
