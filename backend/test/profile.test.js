'use strict';

// globals: true in vitest.config.js
//
// /api/profile is the only self-service router: every role, own row only. The
// regression that matters most is the first test — a technician's session must
// survive a page reload, which calls GET /api/profile with nothing but the JWT.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Profile (self-service)', () => {
  let tenant, other, tech, viewer, admin, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant     = await createTenant({ slug: 'profile-test' });
    other      = await createTenant({ slug: 'profile-other' });
    tech       = await createUser(tenant.id, { role: 'technician', email: 'tech@profile.test', password: 'CurrentPassw0rd!x' });
    viewer     = await createUser(tenant.id, { role: 'viewer', email: 'viewer@profile.test' });
    admin      = await createUser(tenant.id, { role: 'admin', email: 'admin@profile.test' });
    superadmin = await createUser(tenant.id, { role: 'superadmin', email: 'super@profile.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('a technician restores their session from GET /profile (no admin gate)', async () => {
    const res = await request(app).get('/api/profile').set(authHeader(tech, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: tech.id, email: 'tech@profile.test', role: 'technician', active: true });
    expect(res.body.data).toHaveProperty('base_latitude');
    expect(res.body.data).not.toHaveProperty('password_hash');
  });

  it('the old admin-only /users/me path is gone for everyone', async () => {
    expect((await request(app).get('/api/users/me').set(authHeader(tech, tenant.id))).status).toBe(403);
    expect((await request(app).get('/api/users/me').set(authHeader(admin, tenant.id))).status).toBe(404);
  });

  it('a viewer can read but the row is scoped to the caller', async () => {
    const res = await request(app).get('/api/profile').set(authHeader(viewer, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(viewer.id);
  });

  it('a superadmin acting inside another tenant still gets their own profile', async () => {
    const res = await request(app).get('/api/profile').set(authHeader(superadmin, other.id));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(superadmin.id);
  });

  it('PUT /profile/password enforces the 15-character policy and the current password', async () => {
    const hdr = authHeader(tech, tenant.id);

    const short = await request(app).put('/api/profile/password').set(hdr)
      .send({ old_password: 'CurrentPassw0rd!x', new_password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/15 characters/);

    const wrong = await request(app).put('/api/profile/password').set(hdr)
      .send({ old_password: 'not-the-password', new_password: 'BrandNewPassw0rd!!' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_password');

    const ok = await request(app).put('/api/profile/password').set(hdr)
      .send({ old_password: 'CurrentPassw0rd!x', new_password: 'BrandNewPassw0rd!!' });
    expect(ok.status).toBe(200);

    const login = await request(app).post('/api/auth/login')
      .send({ email: 'tech@profile.test', password: 'BrandNewPassw0rd!!' });
    expect(login.status).toBe(200);
  });

  it('PUT /profile changes the email of the caller only', async () => {
    const res = await request(app).put('/api/profile').set(authHeader(viewer, tenant.id))
      .send({ email: 'viewer2@profile.test' });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('viewer2@profile.test');
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [tech.id]);
    expect(rows[0].email).toBe('tech@profile.test');
  });

  it('Telegram link code and unlink live on /profile', async () => {
    const hdr = authHeader(tech, tenant.id);
    const gen = await request(app).post('/api/profile/telegram-link').set(hdr);
    expect(gen.status).toBe(200);
    expect(gen.body.data.link_code).toHaveLength(16);

    const del = await request(app).delete('/api/profile/telegram-link').set(hdr);
    expect(del.status).toBe(200);
    const { rows } = await db.query('SELECT telegram_link_code FROM users WHERE id = $1', [tech.id]);
    expect(rows[0].telegram_link_code).toBeNull();
  });

  it('Web Push subscription save/remove live on /profile', async () => {
    const hdr = authHeader(viewer, tenant.id);
    const sub = { endpoint: 'https://push.example/sub/abc', keys: { p256dh: 'p', auth: 'a' } };
    const save = await request(app).post('/api/profile/push-subscription').set(hdr).send(sub);
    expect(save.status).toBe(200);
    expect(save.body.data.id).toBeTruthy();

    const bad = await request(app).post('/api/profile/push-subscription').set(hdr).send({ endpoint: 'x' });
    expect(bad.status).toBe(400);

    const del = await request(app).delete('/api/profile/push-subscription').set(hdr).send({ endpoint: sub.endpoint });
    expect(del.status).toBe(200);
    const { rows } = await db.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
    expect(rows).toHaveLength(0);
  });
});
