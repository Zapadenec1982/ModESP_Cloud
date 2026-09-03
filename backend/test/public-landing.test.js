'use strict';

// Landing page endpoints (plan epic 1.11): public pricing and pilot requests.
// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('landing endpoints (plan epic 1.11)', () => {
  let tenant, admin, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'landing' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@landing.test' });
    superadmin = await createUser(tenant.id, { role: 'superadmin', email: 'super@landing.test' });
    await db.query('DELETE FROM pilot_requests');
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('GET /api/public/plans lists the public plans with their prices, without authentication', async () => {
    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    const plans = res.body.data.map(p => p.plan);
    expect(plans).toEqual(['free', 'basic', 'pro', 'enterprise', 'partner']);
    expect(plans).not.toContain('system');
    const basic = res.body.data.find(p => p.plan === 'basic');
    expect(basic).toMatchObject({ price_controller_uah: 150, max_devices: 20, retention_days: 400 });
    expect(basic.features).toContain('reports');
    const pro = res.body.data.find(p => p.plan === 'pro');
    expect(pro).toMatchObject({ price_site_uah: 250, price_controller_uah: 100 });
    expect(res.body.data.find(p => p.plan === 'partner').price_base_uah).toBe(2000);
    expect(res.body.data.find(p => p.plan === 'enterprise').price_controller_uah).toBeNull();
  });

  it('POST /api/public/pilot-request validates, stores and normalises the request', async () => {
    const bad = await request(app).post('/api/public/pilot-request').send({ name: 'Ім\'я', email: 'not-an-email' });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/public/pilot-request').send({
      name: '  Олена  ', company: 'Аптека №7', email: 'olena@example.com', phone: '+380501234567',
      segment: 'shop', sites: '3', message: 'Хочемо спробувати на двох холодильниках', source: 'hero', lang: 'uk',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toEqual({ received: true, emailed: false });   // e-mail is not configured in tests

    const { rows } = await db.query('SELECT * FROM pilot_requests ORDER BY created_at DESC LIMIT 1');
    expect(rows[0]).toMatchObject({ name: 'Олена', company: 'Аптека №7', email: 'olena@example.com', segment: 'other', sites: 3, source: 'hero', lang: 'uk', emailed_at: null });
  });

  it('a filled honeypot answers 200 and stores nothing', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM pilot_requests')).rows[0].n;
    const res = await request(app).post('/api/public/pilot-request').send({ name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
    expect(res.status).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM pilot_requests')).rows[0].n).toBe(before);
  });

  it('GET /api/pilot-requests is superadmin-only and paginates', async () => {
    expect((await request(app).get('/api/pilot-requests').set(authHeader(admin, tenant.id))).status).toBe(403);
    const res = await request(app).get('/api/pilot-requests?limit=1').set(authHeader(superadmin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(res.body.data[0]).toMatchObject({ name: 'Олена', segment: 'other' });
    expect(res.body.data[0]).not.toHaveProperty('ip');
  });
});
