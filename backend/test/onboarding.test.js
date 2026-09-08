'use strict';

// globals: true in vitest.config.js
//
// Getting-started checklist (plan epic 2.1): the steps are read from the data
// and the first time each is seen done is written to tenant_settings.onboarding.

const crypto = require('crypto');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

const get = (user, tenant) => request(app).get('/api/onboarding').set(authHeader(user, tenant.id));
const doneKeys = (body) => body.data.steps.filter(s => s.done).map(s => s.key);

describe('onboarding checklist', () => {
  let tenant, other, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'onb-a' });
    other  = await createTenant({ slug: 'onb-b' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@onb.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@onb.test' });
    // The other organisation is fully set up; none of it may leak into onb-a
    await db.query("INSERT INTO sites (tenant_id, name) VALUES ($1, 'Elsewhere')", [other.id]);
    await createDevice(other.id, { mqttId: 'ONB0002' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('administrators only', async () => {
    expect((await get(viewer, tenant)).status).toBe(403);
  });

  it('starts empty', async () => {
    const res = await get(admin, tenant);
    expect(res.status).toBe(200);
    expect(res.body.data.steps.map(s => s.key)).toEqual(['site', 'device', 'team', 'telegram', 'report']);
    // admin + viewer are two members already: "team" counts a second person
    expect(doneKeys(res.body)).toEqual(['team']);
    expect(res.body.data).toMatchObject({ done_count: 1, total: 5, completed: false, dismissed_at: null });
    expect(res.body.data.trial).toEqual({ status: 'active', trial_expires_at: null, days_left: null });
  });

  it('a second person also counts through an open invitation', async () => {
    const solo = await createTenant({ slug: 'onb-solo' });
    const soloAdmin = await createUser(solo.id, { role: 'admin', email: 'solo@onb.test' });
    expect(doneKeys((await get(soloAdmin, solo)).body)).toEqual([]);
    await db.query(
      `INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at) VALUES ($1, 'tech@onb.test', 'technician', $2, now() + interval '3 days')`,
      [solo.id, crypto.randomBytes(32).toString('hex')]);
    expect(doneKeys((await get(soloAdmin, solo)).body)).toEqual(['team']);
  });

  it('records each step the first time it is seen done', async () => {
    await db.query("INSERT INTO sites (tenant_id, name) VALUES ($1, 'Store 1')", [tenant.id]);
    let res = await get(admin, tenant);
    expect(doneKeys(res.body)).toEqual(['site', 'team']);
    const siteAt = res.body.data.steps.find(s => s.key === 'site').done_at;
    expect(siteAt).toBeTruthy();
    const { rows } = await db.query('SELECT onboarding FROM tenant_settings WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].onboarding.steps.site).toBe(siteAt);
    expect(rows[0].onboarding.steps.team).toBeTruthy();

    // A pending controller is not a connected one
    await db.query(
      `INSERT INTO devices (tenant_id, mqtt_device_id, name, status, online) VALUES ($1, 'ONB0001', 'Cabinet', 'pending', false)`, [tenant.id]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'team']);
    await db.query("UPDATE devices SET status = 'active' WHERE mqtt_device_id = 'ONB0001'");
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'team']);

    await db.query('UPDATE users SET telegram_id = 123456 WHERE id = $1', [viewer.id]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'team', 'telegram']);

    await db.query(
      `INSERT INTO report_exports (code, kind, tenant_id, device_id, period_from, period_to, bucket, source, sha256)
       VALUES ('ABCDEFGH1234', 'device', $1, 'ONB0001', now() - interval '7 days', now(), '1h', 'raw', $2)`,
      [tenant.id, 'a'.repeat(64)]);
    res = await get(admin, tenant);
    expect(doneKeys(res.body)).toEqual(['site', 'device', 'team', 'telegram', 'report']);
    expect(res.body.data).toMatchObject({ done_count: 5, completed: true });
    // The site timestamp is the one recorded first, not refreshed on every read
    expect(res.body.data.steps.find(s => s.key === 'site').done_at).toBe(siteAt);
  });

  it('dismiss hides the card and keeps the progress', async () => {
    const res = await request(app).post('/api/onboarding/dismiss').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.dismissed_at).toBeTruthy();
    expect(res.body.data.done_count).toBe(5);
    const { rows } = await db.query('SELECT onboarding FROM tenant_settings WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].onboarding.dismissed_by).toBe(admin.id);
    expect(Object.keys(rows[0].onboarding.steps).sort()).toEqual(['device', 'report', 'site', 'team', 'telegram']);
  });

  it('shows the days left of a trial', async () => {
    await db.query("UPDATE tenants SET status = 'trial', trial_expires_at = now() + interval '3 days' WHERE id = $1", [tenant.id]);
    const res = await get(admin, tenant);
    expect(res.body.data.trial.status).toBe('trial');
    expect(res.body.data.trial.days_left).toBe(3);
  });
});
