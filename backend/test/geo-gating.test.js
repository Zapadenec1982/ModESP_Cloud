'use strict';

// Weather and route planning are plan features (migration 031, plan epic 1.2).
// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const planMw = require('../src/middleware/plan');

const app = createTestApp();

describe('weather and routing plan gates', () => {
  let basic, pro, basicAdmin, proAdmin, basicSite, proSite;

  beforeAll(async () => {
    await cleanDatabase();
    basic = await createTenant({ slug: 'gate-basic', plan: 'basic' });
    pro = await createTenant({ slug: 'gate-pro', plan: 'pro' });
    basicAdmin = await createUser(basic.id, { role: 'admin', email: 'a@basic.test' });
    proAdmin = await createUser(pro.id, { role: 'admin', email: 'a@pro.test' });
    basicSite = (await db.query(`INSERT INTO sites (tenant_id, name, latitude, longitude) VALUES ($1, 'B', 50.45, 30.52) RETURNING id`, [basic.id])).rows[0];
    proSite = (await db.query(`INSERT INTO sites (tenant_id, name, latitude, longitude) VALUES ($1, 'P', 50.45, 30.52) RETURNING id`, [pro.id])).rows[0];
    planMw.invalidate(basic.id); planMw.invalidate(pro.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('migration 031 put weather and routing on the network plans only', async () => {
    const { rows } = await db.query(`SELECT plan, features ? 'weather' AS w, features ? 'routing' AS r FROM plan_limits ORDER BY sort_order`);
    const byPlan = Object.fromEntries(rows.map(r => [r.plan, [r.w, r.r]]));
    expect(byPlan.free).toEqual([false, false]);
    expect(byPlan.basic).toEqual([false, false]);
    expect(byPlan.pro).toEqual([true, true]);
    expect(byPlan.partner).toEqual([true, true]);
  });

  it('the single-site plan gets 402 plan_feature for weather and route planning', async () => {
    const w = await request(app).get(`/api/sites/${basicSite.id}/weather`).set(authHeader(basicAdmin, basic.id));
    expect(w.status).toBe(402);
    expect(w.body.error).toBe('plan_feature');
    const h = await request(app).get(`/api/sites/${basicSite.id}/weather/history`).set(authHeader(basicAdmin, basic.id));
    expect(h.status).toBe(402);
  });

  it('the network plan passes the gate (weather itself is disabled in tests, so the meta says why)', async () => {
    const w = await request(app).get(`/api/sites/${proSite.id}/weather`).set(authHeader(proAdmin, pro.id));
    expect(w.status).not.toBe(402);
    expect(w.status).toBeLessThan(500);
  });
});
