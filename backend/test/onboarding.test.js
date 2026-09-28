'use strict';

// globals: true in vitest.config.js
//
// Getting-started checklist (plan epic 2.1; the first-run chain of product
// audit item 8): the steps are read from the data and the first time each is
// seen done is written to tenant_settings.onboarding.

const crypto = require('crypto');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

const get = (user, tenant) => request(app).get('/api/onboarding').set(authHeader(user, tenant.id));
const doneKeys = (body) => body.data.steps.filter(s => s.done).map(s => s.key);
const addSite = async (tenantId, name) =>
  (await db.query('INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name])).rows[0].id;

describe('onboarding checklist', () => {
  let tenant, other, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'onb-a' });
    other  = await createTenant({ slug: 'onb-b' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@onb.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@onb.test' });
    // The other organisation is fully set up; none of it may leak into onb-a
    await db.query("INSERT INTO sites (tenant_id, name, contact_phone) VALUES ($1, 'Elsewhere', '+380000000000')", [other.id]);
    await createDevice(other.id, { mqttId: 'ONB0002' });
    await db.query("UPDATE devices SET last_seen = now() WHERE mqtt_device_id = 'ONB0002'");
    await db.query("INSERT INTO notification_log (tenant_id, channel, device_id, alarm_code, status) VALUES ($1, 'telegram', 'ONB0002', 'high_temp', 'sent')", [other.id]);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('administrators only', async () => {
    expect((await get(viewer, tenant)).status).toBe(403);
  });

  it('starts empty, in the order the work happens', async () => {
    const res = await get(admin, tenant);
    expect(res.status).toBe(200);
    expect(res.body.data.steps.map(s => s.key)).toEqual(['site', 'device', 'data', 'team', 'responsible', 'notify', 'report']);
    // admin + viewer are two members already: "team" counts a second person
    expect(doneKeys(res.body)).toEqual(['team']);
    expect(res.body.data).toMatchObject({ done_count: 1, total: 7, completed: false, next: 'site', dismissed_at: null });
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
    const siteId = await addSite(tenant.id, 'Store 1');
    let res = await get(admin, tenant);
    expect(doneKeys(res.body)).toEqual(['site', 'team']);
    expect(res.body.data.next).toBe('device');
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
    res = await get(admin, tenant);
    expect(doneKeys(res.body)).toEqual(['site', 'device', 'team']);
    // …and a connected one that has not reported yet is still waiting for its first measurement
    expect(res.body.data.next).toBe('data');
    await db.query("UPDATE devices SET last_seen = now() WHERE mqtt_device_id = 'ONB0001'");
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'data', 'team']);

    // A linked Telegram is not a checked channel: only a delivery is, and a failed one does not count
    await db.query('UPDATE users SET telegram_id = 123456 WHERE id = $1', [viewer.id]);
    await db.query(
      "INSERT INTO notification_log (tenant_id, channel, device_id, alarm_code, status, error_message) VALUES ($1, 'telegram', 'ONB0001', 'high_temp', 'failed', 'chat not found')",
      [tenant.id]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'data', 'team']);
    await db.query(
      "INSERT INTO notification_log (tenant_id, user_id, channel, device_id, alarm_code, status) VALUES ($1, $2, 'telegram', 'TEST', 'test_notification', 'sent')",
      [tenant.id, viewer.id]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'data', 'team', 'notify']);

    // A contact person on the site makes someone responsible (blank strings do not)
    await db.query("UPDATE sites SET contact_name = '  ' WHERE id = $1", [siteId]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'data', 'team', 'notify']);
    await db.query("UPDATE sites SET contact_name = 'Олена', contact_phone = '+380501112233' WHERE id = $1", [siteId]);
    expect(doneKeys((await get(admin, tenant)).body)).toEqual(['site', 'device', 'data', 'team', 'responsible', 'notify']);

    await db.query(
      `INSERT INTO report_exports (code, kind, tenant_id, device_id, period_from, period_to, bucket, source, sha256)
       VALUES ('ABCDEFGH1234', 'device', $1, 'ONB0001', now() - interval '7 days', now(), '1h', 'raw', $2)`,
      [tenant.id, 'a'.repeat(64)]);
    res = await get(admin, tenant);
    expect(doneKeys(res.body)).toEqual(['site', 'device', 'data', 'team', 'responsible', 'notify', 'report']);
    expect(res.body.data).toMatchObject({ done_count: 7, completed: true, next: null });
    // The site timestamp is the one recorded first, not refreshed on every read
    expect(res.body.data.steps.find(s => s.key === 'site').done_at).toBe(siteAt);
  });

  it('a technician given a site or a device, or an order with an assignee, is a responsible person too', async () => {
    const org   = await createTenant({ slug: 'onb-resp' });
    const boss  = await createUser(org.id, { role: 'admin', email: 'boss@resp.test' });
    const watch = await createUser(org.id, { role: 'viewer', email: 'watch@resp.test' });
    const tech  = await createUser(org.id, { role: 'technician', email: 'tech@resp.test' });
    const siteId = await addSite(org.id, 'Depot');
    const device = await createDevice(org.id, { mqttId: 'ONB0003' });
    const responsible = async () => doneKeys((await get(boss, org)).body).includes('responsible');
    expect(await responsible()).toBe(false);

    // A viewer can look, not answer
    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id) VALUES ($1, $2, $3)', [watch.id, siteId, org.id]);
    await db.query('INSERT INTO user_devices (user_id, device_id) VALUES ($1, $2)', [watch.id, device.id]);
    expect(await responsible()).toBe(false);

    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id) VALUES ($1, $2, $3)', [tech.id, siteId, org.id]);
    expect(await responsible()).toBe(true);
    await db.query('DELETE FROM user_sites WHERE user_id = $1', [tech.id]);
    // (the first sighting was recorded; the live state is what the step shows)
    expect(await responsible()).toBe(false);

    await db.query('INSERT INTO user_devices (user_id, device_id) VALUES ($1, $2)', [tech.id, device.id]);
    expect(await responsible()).toBe(true);
    await db.query('DELETE FROM user_devices WHERE user_id = $1', [tech.id]);
    expect(await responsible()).toBe(false);

    await db.query(
      `INSERT INTO work_orders (tenant_id, device_id, title, status, assigned_to, created_by, assigned_at)
       VALUES ($1, $2, 'Check the door', 'assigned', $3, $4, now())`, [org.id, device.id, tech.id, boss.id]);
    expect(await responsible()).toBe(true);
  });

  it('dismiss hides the card and keeps the progress', async () => {
    const res = await request(app).post('/api/onboarding/dismiss').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.dismissed_at).toBeTruthy();
    expect(res.body.data.done_count).toBe(7);
    const { rows } = await db.query('SELECT onboarding FROM tenant_settings WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].onboarding.dismissed_by).toBe(admin.id);
    expect(Object.keys(rows[0].onboarding.steps).sort()).toEqual(['data', 'device', 'notify', 'report', 'responsible', 'site', 'team']);
  });

  it('restore brings the card back with the progress intact', async () => {
    const res = await request(app).post('/api/onboarding/restore').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dismissed_at: null, done_count: 7, completed: true });
    expect((await get(admin, tenant)).body.data.dismissed_at).toBeNull();
    expect((await request(app).post('/api/onboarding/restore').set(authHeader(viewer, tenant.id))).status).toBe(403);
  });

  it('shows the days left of a trial', async () => {
    await db.query("UPDATE tenants SET status = 'trial', trial_expires_at = now() + interval '3 days' WHERE id = $1", [tenant.id]);
    const res = await get(admin, tenant);
    expect(res.body.data.trial.status).toBe('trial');
    expect(res.body.data.trial.days_left).toBe(3);
  });
});
