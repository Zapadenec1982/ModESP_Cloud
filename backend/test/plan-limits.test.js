'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const planMw = require('../src/middleware/plan');

const app = createTestApp();

async function pendingClaimed(mqttId, tenantId) {
  await db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code, claimed_by_tenant_id)
     VALUES ($1, $2, 'pending', false, $3, $4)`,
    [db.SYSTEM_TENANT_ID, mqttId, 'C' + mqttId, tenantId]);
}

describe('plan limits (plan epic 1.8)', () => {
  let free, pro, adminFree, adminPro, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    free = await createTenant({ slug: 'plan-free', plan: 'free' });
    pro  = await createTenant({ slug: 'plan-pro', plan: 'pro' });
    adminFree  = await createUser(free.id, { role: 'admin', email: 'admin@free.test' });
    adminPro   = await createUser(pro.id, { role: 'admin', email: 'admin@pro.test' });
    superadmin = await createUser(pro.id, { role: 'superadmin', email: 'super@plan.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('the catalogue is readable by admins and carries the seeded plans', async () => {
    const res = await request(app).get('/api/tenants/plans').set(authHeader(adminFree, free.id));
    expect(res.status).toBe(200);
    const plans = res.body.data.map(p => p.plan);
    expect(plans).toEqual(expect.arrayContaining(['free', 'basic', 'pro', 'enterprise', 'partner']));
    expect(plans).not.toContain('system');
    const freePlan = res.body.data.find(p => p.plan === 'free');
    expect(freePlan).toMatchObject({ max_devices: 3, max_users: 3, max_sites: 1 });
  });

  it('a free organisation assigns three controllers and gets 402 on the fourth (whoever assigns)', async () => {
    for (const id of ['F00001', 'F00002', 'F00003', 'F00004']) await pendingClaimed(id, free.id);
    for (const id of ['F00001', 'F00002', 'F00003']) {
      const res = await request(app).post(`/api/devices/pending/${id}/assign`).set(authHeader(adminFree, free.id)).send({ name: id });
      expect([200, 201]).toContain(res.status);
    }
    const fourth = await request(app).post('/api/devices/pending/F00004/assign').set(authHeader(adminFree, free.id)).send({ name: 'four' });
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({ error: 'plan_limit', resource: 'devices', limit: 3, current: 3, plan: 'free' });

    const bySuper = await request(app).post('/api/devices/pending/F00004/assign').set(authHeader(superadmin, pro.id))
      .send({ name: 'four', tenant_id: free.id });
    expect(bySuper.status).toBe(402);

    // Upgrading the plan lifts the limit immediately (cache invalidated on PATCH)
    const up = await request(app).patch(`/api/tenants/${free.id}`).set(authHeader(superadmin, pro.id)).send({ plan: 'basic' });
    expect(up.status).toBe(200);
    const now = await request(app).post('/api/devices/pending/F00004/assign').set(authHeader(adminFree, free.id)).send({ name: 'four' });
    expect([200, 201]).toContain(now.status);
    await request(app).patch(`/api/tenants/${free.id}`).set(authHeader(superadmin, pro.id)).send({ plan: 'free' });
  });

  it('counts only active devices and reports usage on the tenant row', async () => {
    const res = await request(app).get(`/api/tenants/${free.id}`).set(authHeader(adminFree, free.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plan: 'free', max_devices: 3, device_count: 4, status: 'active' });
    const cap = await planMw.checkCapacity(free.id, 'devices');
    expect(cap).toMatchObject({ ok: false, limit: 3, current: 4 });
    expect((await planMw.checkCapacity(pro.id, 'devices')).ok).toBe(true);
  });

  it('users: creation and invitations of new accounts stop at max_users; joining an existing account does not', async () => {
    // free: admin + 2 more = 3
    for (const e of ['u2@free.test', 'u3@free.test']) {
      const r = await request(app).post('/api/users').set(authHeader(adminFree, free.id)).send({ email: e, password: 'LongEnoughPassw0rd!', role: 'viewer' });
      expect([200, 201]).toContain(r.status);
    }
    const over = await request(app).post('/api/users').set(authHeader(adminFree, free.id)).send({ email: 'u4@free.test', password: 'LongEnoughPassw0rd!', role: 'viewer' });
    expect(over.status).toBe(402);
    expect(over.body.resource).toBe('users');

    const invite = await request(app).post('/api/users/invite').set(authHeader(adminFree, free.id)).send({ email: 'u5@free.test', role: 'viewer' });
    expect(invite.status).toBe(402);

    const existing = await request(app).post('/api/users/invite').set(authHeader(adminFree, free.id)).send({ email: 'admin@pro.test', role: 'viewer' });
    expect(existing.status).toBe(201);
  });

  it('sites stop at max_sites', async () => {
    const first = await request(app).post('/api/sites').set(authHeader(adminFree, free.id)).send({ name: 'Store 1' });
    expect([200, 201]).toContain(first.status);
    const second = await request(app).post('/api/sites').set(authHeader(adminFree, free.id)).send({ name: 'Store 2' });
    expect(second.status).toBe(402);
    expect(second.body.resource).toBe('sites');
    expect([200, 201]).toContain((await request(app).post('/api/sites').set(authHeader(adminPro, pro.id)).send({ name: 'Pro store' })).status);
  });

  it('features: HACCP PDF and energy need a plan that includes them; superadmin passes', async () => {
    const dev = await createDevice(free.id, { mqttId: 'F00009' });
    const pdf = await request(app).get(`/api/devices/${dev.id}/telemetry/export.pdf`).set(authHeader(adminFree, free.id));
    expect(pdf.status).toBe(402);
    expect(pdf.body).toMatchObject({ error: 'plan_feature', feature: 'reports', plan: 'free' });
    const energy = await request(app).get(`/api/devices/${dev.id}/energy/summary`).set(authHeader(adminFree, free.id));
    expect(energy.status).toBe(402);

    const devPro = await createDevice(pro.id, { mqttId: 'P00001' });
    const energyPro = await request(app).get(`/api/devices/${devPro.id}/energy/summary`).set(authHeader(adminPro, pro.id));
    expect(energyPro.status).not.toBe(402);
    const asSuper = await request(app).get(`/api/devices/${dev.id}/energy/summary`).set(authHeader(superadmin, free.id));
    expect(asSuper.status).not.toBe(402);
  });
});
