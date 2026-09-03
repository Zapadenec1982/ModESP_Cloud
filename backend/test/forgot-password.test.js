'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser } = require('./helpers/factories');

const app = createTestApp();

describe('Self-service password reset', () => {
  let tenant, user, disabled;

  beforeAll(async () => {
    await cleanDatabase();
    tenant   = await createTenant({ slug: 'forgot-test' });
    user     = await createUser(tenant.id, { role: 'technician', email: 'Tech@Forgot.test', password: 'OldPasswordValue!1' });
    disabled = await createUser(tenant.id, { role: 'viewer', email: 'gone@forgot.test', active: false });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('answers identically for unknown, disabled and known addresses', async () => {
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@forgot.test' });
    const off     = await request(app).post('/api/auth/forgot-password').send({ email: 'gone@forgot.test' });
    const known   = await request(app).post('/api/auth/forgot-password').send({ email: 'tech@forgot.test' });
    expect(unknown.status).toBe(200);
    expect(off.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(off.body).toEqual(known.body);

    const { rows } = await db.query('SELECT password_reset_code FROM users WHERE id = $1', [disabled.id]);
    expect(rows[0].password_reset_code).toBeNull();
  });

  it('rejects a malformed email', async () => {
    expect((await request(app).post('/api/auth/forgot-password').send({ email: 'nope' })).status).toBe(400);
  });

  it('stores a 30-minute code for an active account (case-insensitive email)', async () => {
    const { rows } = await db.query(
      'SELECT password_reset_code, password_reset_expires FROM users WHERE id = $1', [user.id]);
    expect(rows[0].password_reset_code).toMatch(/^[0-9a-f]{16}$/);
    const minutes = (new Date(rows[0].password_reset_expires) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('the emailed code works with the existing reset endpoint under the 15-character policy', async () => {
    const { rows } = await db.query('SELECT password_reset_code FROM users WHERE id = $1', [user.id]);
    const code = rows[0].password_reset_code;

    const weak = await request(app).post('/api/auth/reset-password')
      .send({ email: 'Tech@Forgot.test', reset_code: code, new_password: 'tooshort' });
    expect(weak.status).toBe(400);

    const ok = await request(app).post('/api/auth/reset-password')
      .send({ email: 'Tech@Forgot.test', reset_code: code, new_password: 'FreshPasswordValue!2' });
    expect(ok.status).toBe(200);

    const login = await request(app).post('/api/auth/login').send({ email: 'Tech@Forgot.test', password: 'FreshPasswordValue!2' });
    expect(login.status).toBe(200);

    const reuse = await request(app).post('/api/auth/reset-password')
      .send({ email: 'Tech@Forgot.test', reset_code: code, new_password: 'AnotherPasswordValue!3' });
    expect(reuse.status).toBe(400);
  });
});
