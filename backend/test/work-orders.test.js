'use strict';

// globals: true in vitest.config.js
//
// Work orders (plan epic 2.3): alarm or hint → order → technician → visit →
// structured service record. Creating from an alarm acknowledges it; the
// assignee is the only one notified, with the site address and a route link;
// a technician can take an order themselves but not hand it to a colleague;
// closing writes a service record that carries the user, the order and the cost.

const request = require('supertest');
const pino    = require('pino');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const push = require('../src/services/push');

const app = createTestApp();

describe('work orders', () => {
  let tenant, other, admin, tech, tech2, viewer, adminOther, site, d1, d2, alarmId, hintId;
  let sent = [];
  const fakeTelegram = { send: async (address, payload) => { sent.push({ address, payload }); } };
  const H = (u) => authHeader(u, tenant.id);

  beforeAll(async () => {
    await cleanDatabase();
    push.__test.setLogger(pino({ level: 'silent' }));
    push.__test.reset();
    push.registerChannel('telegram', fakeTelegram);

    tenant     = await createTenant({ slug: 'wo-a', plan: 'basic' });
    other      = await createTenant({ slug: 'wo-b' });
    admin      = await createUser(tenant.id, { role: 'admin', email: 'admin@wo.test' });
    tech       = await createUser(tenant.id, { role: 'technician', email: 'tech@wo.test' });
    tech2      = await createUser(tenant.id, { role: 'technician', email: 'tech2@wo.test' });
    viewer     = await createUser(tenant.id, { role: 'viewer', email: 'viewer@wo.test' });
    adminOther = await createUser(other.id, { role: 'admin', email: 'admin@wo-b.test' });
    for (const [u, tg] of [[admin, 9001], [tech, 9002], [tech2, 9003]]) await db.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [tg, u.id]);

    site = (await db.query(
      `INSERT INTO sites (tenant_id, name, city, address_line, latitude, longitude) VALUES ($1, 'Магазин №7', 'Полтава', 'вул. Соборності, 12', 49.5883, 34.5514) RETURNING id`,
      [tenant.id])).rows[0];
    d1 = await createDevice(tenant.id, { mqttId: 'WO0001', name: 'Камера заморозки №1' });
    d2 = await createDevice(tenant.id, { mqttId: 'WO0002', name: 'Вітрина без доступу' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, d1.id]);
    await grantDeviceAccess(tech.id, d1.id, admin.id);
    await grantDeviceAccess(viewer.id, d1.id, admin.id);

    alarmId = (await db.query(`INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'WO0001', 'high_temp_alarm', 'critical', true) RETURNING id`, [tenant.id])).rows[0].id;
    hintId  = (await db.query(`INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, severity, value, threshold) VALUES ($1, 'WO0001', 'cond_temp', 'info', 61, 55) RETURNING id`, [tenant.id])).rows[0].id;
  });

  afterAll(async () => {
    push.__test.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  let fromAlarm, fromHint, techOwn;

  it('an administrator creates an order from an alarm: the alarm is acknowledged, the assignee is told where to go', async () => {
    sent = [];
    const res = await request(app).post('/api/work-orders').set(H(admin))
      .send({ title: 'Висока температура — камера №1', device_id: 'WO0001', alarm_id: alarmId, priority: 'high', assigned_to: tech.id });
    expect(res.status).toBe(201);
    fromAlarm = res.body.data;
    expect(fromAlarm).toMatchObject({ status: 'assigned', priority: 'high', device_mqtt_id: 'WO0001', site_id: site.id, assigned_to_email: 'tech@wo.test', created_by_email: 'admin@wo.test' });
    expect(fromAlarm.site_address).toBe('вул. Соборності, 12, Полтава');
    expect(fromAlarm.maps_url).toContain('destination=49.5883%2C34.5514');
    expect(fromAlarm.assigned_at).not.toBeNull();

    const { rows } = await db.query('SELECT acknowledged_by, ack_note FROM alarms WHERE id = $1', [alarmId]);
    expect(rows[0].acknowledged_by).toBe(admin.id);
    expect(rows[0].ack_note).toBe(`Наряд #${fromAlarm.id}`);

    expect(sent.map(s => s.address)).toEqual(['9002']);
    expect(sent[0].payload).toMatchObject({ type: 'work_order', orderId: fromAlarm.id, siteName: 'Магазин №7', siteAddress: 'вул. Соборності, 12, Полтава', priority: 'high' });
    expect(sent[0].payload.mapsUrl).toContain('google.com/maps');

    // the alarm list now carries the order
    const alarms = await request(app).get('/api/alarms?active=true').set(H(admin));
    expect(alarms.body.data.find(a => a.id === alarmId)).toMatchObject({ work_order_id: fromAlarm.id, work_order_status: 'assigned' });
  });

  it('a technician creates an order from a hint on a device they may open, only for themselves', async () => {
    sent = [];
    const denied = await request(app).post('/api/work-orders').set(H(tech)).send({ title: 'x', device_id: 'WO0002', hint_id: hintId });
    expect(denied.status).toBe(403);
    const notMine = await request(app).post('/api/work-orders').set(H(tech)).send({ title: 'x', device_id: 'WO0001', assigned_to: tech2.id });
    expect(notMine.status).toBe(403);
    const wrongDevice = await request(app).post('/api/work-orders').set(H(tech)).send({ title: 'x', device_id: 'WO0001', hint_id: 999999 });
    expect(wrongDevice.status).toBe(400);
    const noTarget = await request(app).post('/api/work-orders').set(H(admin)).send({ title: 'x' });
    expect(noTarget.status).toBe(400);
    expect((await request(app).post('/api/work-orders').set(H(viewer)).send({ title: 'x', device_id: 'WO0001' })).status).toBe(403);

    const res = await request(app).post('/api/work-orders').set(H(tech)).send({ title: 'Почистити конденсатор', device_id: d1.id, hint_id: hintId, assigned_to: tech.id });
    expect(res.status).toBe(201);
    fromHint = res.body.data;
    expect(fromHint).toMatchObject({ status: 'assigned', hint_id: hintId, assigned_to: tech.id });
    expect(sent).toEqual([]);   // self-assignment is not announced to oneself
    const { rows } = await db.query('SELECT acknowledged_by FROM maintenance_hints WHERE id = $1', [hintId]);
    expect(rows[0].acknowledged_by).toBe(tech.id);
    const hints = await request(app).get('/api/maintenance/hints').set(H(admin));
    expect(hints.body.data.find(h => h.id === hintId)).toMatchObject({ work_order_id: fromHint.id, work_order_status: 'assigned' });
  });

  it('lists are scoped: admin sees all, a technician sees own and accessible, a viewer only accessible, the other organisation nothing', async () => {
    const unassigned = await request(app).post('/api/work-orders').set(H(admin)).send({ title: 'Перевірити ущільнення', device_id: 'WO0002' });
    expect(unassigned.status).toBe(201);
    expect(unassigned.body.data.status).toBe('new');

    const all = await request(app).get('/api/work-orders').set(H(admin));
    expect(all.body.data.map(o => o.id).sort()).toEqual([fromAlarm.id, fromHint.id, unassigned.body.data.id].sort());
    // urgent/high first
    expect(all.body.data[0].id).toBe(fromAlarm.id);

    const techList = await request(app).get('/api/work-orders').set(H(tech));
    expect(techList.body.data.map(o => o.id).sort()).toEqual([fromAlarm.id, fromHint.id].sort());
    const mine = await request(app).get('/api/work-orders?mine=1').set(H(tech));
    expect(mine.body.data.length).toBe(2);
    const tech2List = await request(app).get('/api/work-orders').set(H(tech2));
    expect(tech2List.body.data).toEqual([]);
    const viewerList = await request(app).get('/api/work-orders').set(H(viewer));
    expect(viewerList.body.data.map(o => o.id).sort()).toEqual([fromAlarm.id, fromHint.id].sort());
    expect((await request(app).get('/api/work-orders').set(authHeader(adminOther, other.id))).body.data).toEqual([]);
    expect((await request(app).get(`/api/work-orders/${fromAlarm.id}`).set(authHeader(adminOther, other.id))).status).toBe(404);
    expect((await request(app).get(`/api/work-orders/${unassigned.body.data.id}`).set(H(tech))).status).toBe(404);

    const byDevice = await request(app).get('/api/devices/WO0001/work-orders').set(H(viewer));
    expect(byDevice.status).toBe(200);
    expect(byDevice.body.data.length).toBe(2);
    expect((await request(app).get('/api/devices/WO0002/work-orders').set(H(tech))).status).toBe(403);

    const detail = await request(app).get(`/api/work-orders/${fromAlarm.id}`).set(H(tech));
    expect(detail.status).toBe(200);
    expect(detail.body.data.alarm).toMatchObject({ id: alarmId, alarm_code: 'high_temp_alarm' });
    expect(detail.body.data.hint).toBeNull();

    // a technician takes the unassigned order themselves, but cannot hand it over
    const take = await request(app).post(`/api/work-orders/${unassigned.body.data.id}/assign`).set(H(tech2)).send({ user_id: tech2.id });
    expect(take.status).toBe(404);   // not visible to tech2: no device access, not assigned
    const takeByTech = await request(app).post(`/api/work-orders/${fromHint.id}/assign`).set(H(tech)).send({ user_id: tech2.id });
    expect(takeByTech.status).toBe(403);
    techOwn = unassigned.body.data;
  });

  it('assignment by an administrator notifies the new assignee; assignees list is admin-only', async () => {
    sent = [];
    expect((await request(app).get('/api/work-orders/assignees').set(H(tech))).status).toBe(403);
    const assignees = await request(app).get('/api/work-orders/assignees').set(H(admin));
    expect(assignees.body.data.map(u => u.email).sort()).toEqual(['admin@wo.test', 'tech2@wo.test', 'tech@wo.test']);

    expect((await request(app).post(`/api/work-orders/${techOwn.id}/assign`).set(H(admin)).send({ user_id: viewer.id })).status).toBe(400);
    const res = await request(app).post(`/api/work-orders/${techOwn.id}/assign`).set(H(admin)).send({ user_id: tech2.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'assigned', assigned_to: tech2.id });
    expect(sent.map(s => s.address)).toEqual(['9003']);
    expect(sent[0].payload.title).toBe('Перевірити ущільнення');
    // now tech2 sees it although they have no device access
    expect((await request(app).get('/api/work-orders?mine=1').set(H(tech2))).body.data.map(o => o.id)).toEqual([techOwn.id]);
  });

  it('start, edit, close with a structured service record; closed orders reject further changes', async () => {
    expect((await request(app).post(`/api/work-orders/${fromAlarm.id}/start`).set(H(tech2))).status).toBe(404);
    expect((await request(app).post(`/api/work-orders/${fromAlarm.id}/start`).set(H(viewer))).status).toBe(403);
    const start = await request(app).post(`/api/work-orders/${fromAlarm.id}/start`).set(H(tech));
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe('in_progress');
    expect(start.body.data.started_at).not.toBeNull();
    expect((await request(app).post(`/api/work-orders/${fromAlarm.id}/start`).set(H(tech))).status).toBe(409);

    const edit = await request(app).patch(`/api/work-orders/${fromAlarm.id}`).set(H(tech)).send({ priority: 'urgent', scheduled_at: '2026-09-06T08:00:00Z' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.priority).toBe('urgent');
    expect((await request(app).patch(`/api/work-orders/${fromAlarm.id}`).set(H(tech)).send({})).status).toBe(400);

    const close = await request(app).post(`/api/work-orders/${fromAlarm.id}/close`).set(H(tech))
      .send({ work_done: 'Замінено пускове реле, перевірено заправку', duration_min: 95, parts: [{ name: 'Реле пускове', qty: 1, cost: 850 }], cost: 1450, cost_currency: 'uah' });
    expect(close.status).toBe(200);
    expect(close.body.data).toMatchObject({ status: 'done', closed_reason: 'Замінено пускове реле, перевірено заправку' });
    expect(Number(close.body.service_record_id)).toBeGreaterThan(0);   // BIGSERIAL ids are strings, like alarms

    const { rows } = await db.query('SELECT * FROM service_records WHERE id = $1', [close.body.service_record_id]);
    expect(rows[0]).toMatchObject({ device_id: d1.id, technician: 'tech@wo.test', user_id: tech.id, work_order_id: fromAlarm.id, duration_min: 95, cost_currency: 'UAH' });
    expect(Number(rows[0].cost)).toBe(1450);
    expect(rows[0].parts).toEqual([{ name: 'Реле пускове', qty: 1, cost: 850 }]);
    expect(rows[0].reason).toBe('Висока температура — камера №1');

    const detail = await request(app).get(`/api/work-orders/${fromAlarm.id}`).set(H(admin));
    expect(detail.body.data.service_record).toMatchObject({ id: close.body.service_record_id, work_done: 'Замінено пускове реле, перевірено заправку' });

    expect((await request(app).post(`/api/work-orders/${fromAlarm.id}/close`).set(H(tech)).send({ work_done: 'x' })).status).toBe(409);
    expect((await request(app).patch(`/api/work-orders/${fromAlarm.id}`).set(H(admin)).send({ title: 'x' })).status).toBe(409);
    expect((await request(app).post(`/api/work-orders/${fromAlarm.id}/assign`).set(H(admin)).send({ user_id: tech2.id })).status).toBe(409);

    // the legacy service-records endpoint still lists it
    const legacy = await request(app).get(`/api/devices/${d1.id}/service-records`).set(H(admin));
    expect(legacy.body.data.some(r => r.id === close.body.service_record_id)).toBe(true);
  });

  it('cancel is for administrators; lists split open and closed; stats count the chain', async () => {
    expect((await request(app).post(`/api/work-orders/${fromHint.id}/cancel`).set(H(tech)).send({ reason: 'x' })).status).toBe(403);
    const cancel = await request(app).post(`/api/work-orders/${fromHint.id}/cancel`).set(H(admin)).send({ reason: 'Дубль' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', closed_reason: 'Дубль' });

    const open = await request(app).get('/api/work-orders').set(H(admin));
    expect(open.body.data.map(o => o.id)).toEqual([techOwn.id]);
    const closed = await request(app).get('/api/work-orders?status=closed').set(H(admin));
    expect(closed.body.data.map(o => o.id).sort()).toEqual([fromAlarm.id, fromHint.id].sort());
    expect((await request(app).get('/api/work-orders?status=all').set(H(admin))).body.data.length).toBe(3);

    const stats = await request(app).get('/api/work-orders/stats').set(H(admin));
    expect(stats.status).toBe(200);
    expect(stats.body.data).toMatchObject({ total: 3, assigned: 1, done: 1, cancelled: 1, from_alarms: 1, from_hints: 1 });
    expect(stats.body.data.avg_close_min).toBeGreaterThanOrEqual(0);
    expect((await request(app).get('/api/work-orders/stats').set(H(viewer))).status).toBe(403);
  });
});
