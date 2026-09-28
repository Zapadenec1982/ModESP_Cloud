'use strict';

// globals: true in vitest.config.js
//
// GET /api/alarms narrowed by place and by equipment: ?site_id=, ?device_id=
// and ?q= (the site page, the ?site= link from the sites table, and the
// device search on the alarms page). Kept apart from alarms.test.js so the
// column-list changes of the alarm rows merge without touching this file.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

async function createSite(tenantId, name) {
  const { rows } = await db.query('INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING *', [tenantId, name]);
  return rows[0];
}

async function raise(tenantId, mqttId, code, { active = true, severity = 'warning', ago = '1 hour' } = {}) {
  await db.query(
    `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
     VALUES ($1, $2, $3, $4, $5, NOW() - $6::interval, CASE WHEN $5 THEN NULL ELSE NOW() END)`,
    [tenantId, mqttId, code, severity, active, ago]);
}

const ids = (res) => res.body.data.map(a => a.device_id).sort();

describe('GET /api/alarms — site, device and text filters', () => {
  let tenant, other, admin, viewer, siteA, siteB, otherSite, d1, d2, d3, od;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'alarm-filters' });
    other  = await createTenant({ slug: 'alarm-filters-other' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@alarm-filters.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@alarm-filters.test' });

    siteA = await createSite(tenant.id, 'Магазин А');
    siteB = await createSite(tenant.id, 'Магазин Б');
    otherSite = await createSite(other.id, 'Чужий магазин');

    d1 = await createDevice(tenant.id, { mqttId: 'FLT001', name: 'Вітрина молочна' });
    d2 = await createDevice(tenant.id, { mqttId: 'FLT002', name: 'Ларь морозиво' });
    d3 = await createDevice(tenant.id, { mqttId: 'FLT003', name: 'Камера мʼясо' });
    od = await createDevice(other.id,  { mqttId: 'FLT9ZZ', name: 'Вітрина чужа' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = ANY($2)', [siteA.id, [d1.id, d2.id]]);
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteB.id, d3.id]);
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [otherSite.id, od.id]);

    await raise(tenant.id, 'FLT001', 'high_temp_alarm', { active: true, severity: 'critical', ago: '10 minutes' });
    await raise(tenant.id, 'FLT002', 'door_alarm',      { active: false, ago: '2 hours' });
    await raise(tenant.id, 'FLT003', 'low_temp_alarm',  { active: true, ago: '30 minutes' });
    await raise(other.id,  'FLT9ZZ', 'high_temp_alarm', { active: true, ago: '5 minutes' });

    // The viewer may see site B's device only
    await grantDeviceAccess(viewer.id, d3.id, admin.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('?site_id= narrows to the devices standing on that site', async () => {
    const a = await request(app).get(`/api/alarms?site_id=${siteA.id}`).set(authHeader(admin, tenant.id));
    expect(a.status).toBe(200);
    expect(ids(a)).toEqual(['FLT001', 'FLT002']);

    const b = await request(app).get(`/api/alarms?site_id=${siteB.id}`).set(authHeader(admin, tenant.id));
    expect(ids(b)).toEqual(['FLT003']);

    // Combined with the existing active flag
    const active = await request(app).get(`/api/alarms?site_id=${siteA.id}&active=true`).set(authHeader(admin, tenant.id));
    expect(ids(active)).toEqual(['FLT001']);
  });

  it('CROSS-TENANT: another organisation\'s site id matches nothing, and a malformed one is a 400', async () => {
    const foreign = await request(app).get(`/api/alarms?site_id=${otherSite.id}`).set(authHeader(admin, tenant.id));
    expect(foreign.status).toBe(200);
    expect(foreign.body.data).toEqual([]);

    const bad = await request(app).get('/api/alarms?site_id=not-a-uuid').set(authHeader(admin, tenant.id));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_failed');
  });

  it('?device_id= accepts the device UUID or the controller id', async () => {
    const byUuid = await request(app).get(`/api/alarms?device_id=${d1.id}`).set(authHeader(admin, tenant.id));
    expect(ids(byUuid)).toEqual(['FLT001']);

    const byMqtt = await request(app).get('/api/alarms?device_id=FLT002').set(authHeader(admin, tenant.id));
    expect(ids(byMqtt)).toEqual(['FLT002']);

    const foreign = await request(app).get('/api/alarms?device_id=FLT9ZZ').set(authHeader(admin, tenant.id));
    expect(foreign.body.data).toEqual([]);

    expect((await request(app).get('/api/alarms?device_id=').set(authHeader(admin, tenant.id))).status).toBe(400);
    expect((await request(app).get(`/api/alarms?device_id=${'x'.repeat(65)}`).set(authHeader(admin, tenant.id))).status).toBe(400);
  });

  it('?q= matches a fragment of the device name or of the controller id, case-insensitively', async () => {
    const byName = await request(app).get('/api/alarms?q=' + encodeURIComponent('вітрина')).set(authHeader(admin, tenant.id));
    expect(ids(byName)).toEqual(['FLT001']);                 // the other «Вітрина» belongs to the other tenant

    const byId = await request(app).get('/api/alarms?q=flt00').set(authHeader(admin, tenant.id));
    expect(ids(byId)).toEqual(['FLT001', 'FLT002', 'FLT003']);

    const none = await request(app).get('/api/alarms?q=nothing-here').set(authHeader(admin, tenant.id));
    expect(none.body.data).toEqual([]);

    // Blank is "no filter", not "match nothing"
    const blank = await request(app).get('/api/alarms?q=%20').set(authHeader(admin, tenant.id));
    expect(blank.body.data.length).toBe(3);
  });

  it('LIKE wildcards in ?q= are escaped, and the length is capped at 64', async () => {
    const percent = await request(app).get('/api/alarms?q=%25').set(authHeader(admin, tenant.id));
    expect(percent.status).toBe(200);
    expect(percent.body.data).toEqual([]);

    const underscore = await request(app).get('/api/alarms?q=FLT_01').set(authHeader(admin, tenant.id));
    expect(underscore.body.data).toEqual([]);

    const long = await request(app).get('/api/alarms?q=' + 'a'.repeat(65)).set(authHeader(admin, tenant.id));
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('validation_failed');

    const max = await request(app).get('/api/alarms?q=' + 'a'.repeat(64)).set(authHeader(admin, tenant.id));
    expect(max.status).toBe(200);
  });

  it('RBAC: the filters never widen what a viewer may see', async () => {
    const all = await request(app).get('/api/alarms').set(authHeader(viewer, tenant.id));
    expect(ids(all)).toEqual(['FLT003']);

    const siteA1 = await request(app).get(`/api/alarms?site_id=${siteA.id}`).set(authHeader(viewer, tenant.id));
    expect(siteA1.body.data).toEqual([]);

    const byId = await request(app).get('/api/alarms?device_id=FLT001').set(authHeader(viewer, tenant.id));
    expect(byId.body.data).toEqual([]);

    const q = await request(app).get('/api/alarms?q=FLT').set(authHeader(viewer, tenant.id));
    expect(ids(q)).toEqual(['FLT003']);
  });

  it('a superadmin may combine the filters across organisations', async () => {
    const superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@alarm-filters.test' });
    const res = await request(app).get('/api/alarms?q=' + encodeURIComponent('Вітрина')).set(authHeader(superadmin, other.id));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(['FLT001', 'FLT9ZZ']);

    const bySite = await request(app).get(`/api/alarms?site_id=${siteA.id}&active=true`).set(authHeader(superadmin, other.id));
    expect(ids(bySite)).toEqual(['FLT001']);
  });
});
