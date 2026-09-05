'use strict';

// globals: true in vitest.config.js
//
// Maintenance hints (plan epic 2.4): the controller raises the alarms, the
// cloud notices when the same one keeps coming back. One rule — alarm_repeat,
// N of the same code within a window — opens a hint per (device, alarm code),
// refreshes it while the window still holds that many, closes it when the
// window slides past, and lets it be acknowledged (admin, technician with
// device access) or dismissed (admin). Organisations tune N and the window;
// the free plan has no rule running; administrators are notified.

const request = require('supertest');
const pino    = require('pino');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const maintenance = require('../src/services/maintenance');
const push        = require('../src/services/push');
const plan        = require('../src/middleware/plan');

const app = createTestApp();
const NOW = new Date('2026-09-05T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400e3);
const at = (offsetHours) => new Date(NOW.getTime() + offsetHours * 3600e3);

async function seedAlarms(tenantId, deviceId, code, times, severity = 'warning') {
  for (const t of times) {
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, $2, $3, $4, false, $5::timestamptz, $5::timestamptz + interval '10 minutes')`,
      [tenantId, deviceId, code, severity, t]);
  }
}
async function hints(tenantId, deviceId) {
  const { rows } = await db.query(
    `SELECT id, rule_key, alarm_code, value::float AS value, threshold::float AS threshold, window_hours, acknowledged_at, closed_at, closed_reason
       FROM maintenance_hints WHERE tenant_id = $1 AND device_id = $2 ORDER BY alarm_code, id`, [tenantId, deviceId]);
  return rows;
}
const openCodes = (rows) => rows.filter(r => !r.closed_at).map(r => r.alarm_code).sort();

describe('maintenance hints: the same alarm keeps coming back', () => {
  let tenant, freeTenant, admin, tech, techNone, viewer, freeAdmin, superadmin, d1, d2, fd;
  let sent = [];
  const fakeTelegram = { send: async (address, payload) => { sent.push({ address, payload }); } };

  beforeAll(async () => {
    await cleanDatabase();
    maintenance.__test.setLogger(pino({ level: 'silent' }));
    push.__test.setLogger(pino({ level: 'silent' }));
    push.__test.reset();
    push.registerChannel('telegram', fakeTelegram);

    tenant     = await createTenant({ slug: 'hints-a', plan: 'basic' });
    freeTenant = await createTenant({ slug: 'hints-free', plan: 'free' });
    admin      = await createUser(tenant.id, { role: 'admin', email: 'admin@hints.test' });
    tech       = await createUser(tenant.id, { role: 'technician', email: 'tech@hints.test' });
    techNone   = await createUser(tenant.id, { role: 'technician', email: 'tech-none@hints.test' });
    viewer     = await createUser(tenant.id, { role: 'viewer', email: 'viewer@hints.test' });
    superadmin = await createUser(tenant.id, { role: 'superadmin', email: 'super@hints.test' });
    freeAdmin  = await createUser(freeTenant.id, { role: 'admin', email: 'admin@hints-free.test' });
    await db.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [7001, admin.id]);
    await db.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [7002, tech.id]);

    d1 = await createDevice(tenant.id, { mqttId: 'HNT001', name: 'Камера заморозки №1' });
    d2 = await createDevice(tenant.id, { mqttId: 'HNT002', name: 'Вітрина' });
    fd = await createDevice(freeTenant.id, { mqttId: 'HNTF01' });
    await grantDeviceAccess(tech.id, d1.id, admin.id);
    await grantDeviceAccess(viewer.id, d1.id, admin.id);
    await db.query(`UPDATE devices SET model = 'ModESP-KF6' WHERE id = $1`, [d1.id]);

    // HNT001: high temperature four times this week, the door twice, and the
    // platform's own offline alarm five times (never counted)
    await seedAlarms(tenant.id, 'HNT001', 'high_temp_alarm', [daysAgo(5.5), daysAgo(4), daysAgo(2), daysAgo(1)], 'critical');
    await seedAlarms(tenant.id, 'HNT001', 'door_alarm', [daysAgo(3), daysAgo(0.5)]);
    await seedAlarms(tenant.id, 'HNT001', 'device_offline', [daysAgo(6), daysAgo(5), daysAgo(4), daysAgo(3), daysAgo(2)]);
    // HNT002: rapid cycling exactly three times inside the window, once outside it
    await seedAlarms(tenant.id, 'HNT002', 'rapid_cycle_alarm', [daysAgo(9), daysAgo(6.5), daysAgo(4.8), daysAgo(1)], 'info');
    // the free tenant's device has the same evidence and is never evaluated
    await seedAlarms(freeTenant.id, 'HNTF01', 'high_temp_alarm', [daysAgo(3), daysAgo(2), daysAgo(1)], 'critical');
  });

  afterAll(async () => {
    push.__test.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  it('opens one hint per (device, alarm code) that reached the line; ignores device_offline and plans without the feature', async () => {
    const report = await maintenance.evaluateAll({ now: NOW });
    expect(report['hints-a']).toMatchObject({ opened: 2, refreshed: 0, closed: 0, devices: 2 });
    expect(report['hints-free']).toBeUndefined();

    const h1 = await hints(tenant.id, 'HNT001');
    expect(openCodes(h1)).toEqual(['high_temp_alarm']);
    expect(h1[0]).toMatchObject({ rule_key: 'alarm_repeat', alarm_code: 'high_temp_alarm', value: 4, threshold: 3, window_hours: 168 });
    const h2 = await hints(tenant.id, 'HNT002');
    expect(openCodes(h2)).toEqual(['rapid_cycle_alarm']);
    expect(h2[0].value).toBe(3);   // the ninth-day alarm is outside the window
    expect(await hints(freeTenant.id, 'HNTF01')).toEqual([]);

    // administrators were told once per hint, with the controller's alarm named; the technician was not
    const admins = sent.filter(s => s.address === '7001');
    expect(admins.map(s => s.payload.type)).toEqual(['hint', 'hint']);
    expect(admins.map(s => s.payload.sourceAlarmCode).sort()).toEqual(['high_temp_alarm', 'rapid_cycle_alarm']);
    expect(admins.every(s => s.payload.ruleKey === 'alarm_repeat' && s.payload.windowHours === 168)).toBe(true);
    expect(admins.find(s => s.payload.deviceId === 'HNT001').payload).toMatchObject({ deviceName: 'Камера заморозки №1', value: 4, threshold: 3 });
    expect(sent.some(s => s.address === '7002')).toBe(false);
    const { rows: log } = await db.query(`SELECT alarm_code FROM notification_log WHERE tenant_id = $1 ORDER BY id`, [tenant.id]);
    expect(log.map(l => l.alarm_code).sort()).toEqual(['hint:high_temp_alarm', 'hint:rapid_cycle_alarm']);
  });

  it('a later run refreshes instead of duplicating, and closes the hint once the window slides past the old alarms', async () => {
    sent = [];
    const r1 = await maintenance.evaluateAll({ now: at(1) });
    expect(r1['hints-a']).toMatchObject({ opened: 0, refreshed: 2, closed: 0 });
    expect(sent).toEqual([]);

    // two days on: HNT001 still has three inside the window, HNT002 only two
    const r2 = await maintenance.evaluateAll({ now: at(48) });
    expect(r2['hints-a']).toMatchObject({ opened: 0, refreshed: 1, closed: 1 });
    expect((await hints(tenant.id, 'HNT001')).find(h => h.alarm_code === 'high_temp_alarm')).toMatchObject({ value: 3, closed_at: null });
    const closed = (await hints(tenant.id, 'HNT002')).find(h => h.alarm_code === 'rapid_cycle_alarm');
    expect(closed.closed_at).not.toBeNull();
    expect(closed.closed_reason).toBe('resolved');
    expect(closed.value).toBe(2);
  });

  it('the organisation raises the line and the hint closes; back to the default it reopens; disabled keeps it quiet', async () => {
    const put = await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id)).send({ threshold: 5 });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ rule_key: 'alarm_repeat', threshold: 5, window_hours: 168 });

    const rules = await request(app).get('/api/maintenance/rules').set(authHeader(admin, tenant.id));
    expect(rules.status).toBe(200);
    expect(rules.body.data).toHaveLength(1);
    expect(rules.body.data[0]).toMatchObject({ rule_key: 'alarm_repeat', unit: 'count', threshold: 5, overridden: true, default: { threshold: 3, window_hours: 168 } });

    await maintenance.evaluateAll({ now: at(2) });
    expect(openCodes(await hints(tenant.id, 'HNT001'))).toEqual([]);

    const del = await request(app).delete('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id));
    expect(del.status).toBe(200);
    const r = await maintenance.evaluateAll({ now: at(3) });
    expect(r['hints-a']).toMatchObject({ opened: 2 });   // both devices again: the evidence never went away
    expect(openCodes(await hints(tenant.id, 'HNT001'))).toEqual(['high_temp_alarm']);

    await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id)).send({ threshold: 3, enabled: false });
    await db.query(`UPDATE maintenance_hints SET closed_at = now(), closed_reason = 'dismissed' WHERE tenant_id = $1 AND closed_at IS NULL`, [tenant.id]);
    expect((await maintenance.evaluateAll({ now: at(4) }))['hints-a']).toMatchObject({ opened: 0, closed: 0 });
    await request(app).delete('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id));
    expect((await maintenance.evaluateAll({ now: at(5) }))['hints-a']).toMatchObject({ opened: 2 });
    plan.invalidate();
  });

  it('a window in days: the count only looks back as far as the organisation says', async () => {
    // 3 in 2 days: HNT001 has only two high-temperature alarms inside that window
    await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id)).send({ threshold: 3, window_hours: 48 });
    const r = await maintenance.evaluateAll({ now: at(6) });
    expect(r['hints-a']).toMatchObject({ closed: 2 });
    expect(openCodes(await hints(tenant.id, 'HNT001'))).toEqual([]);
    await request(app).delete('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id));
    expect((await maintenance.evaluateAll({ now: at(7) }))['hints-a']).toMatchObject({ opened: 2 });
  });

  it('rule editing is validated and the platform default is the superadmin\'s', async () => {
    expect((await request(app).put('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id)).send({ threshold: 1 })).status).toBe(404);
    expect((await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id)).send({ threshold: 0 })).status).toBe(400);
    expect((await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id)).send({ threshold: 3, window_hours: 9999 })).status).toBe(400);
    expect((await request(app).put('/api/maintenance/rules/alarm_repeat?global=1').set(authHeader(admin, tenant.id)).send({ threshold: 4 })).status).toBe(403);
    expect((await request(app).put('/api/maintenance/rules/alarm_repeat').set(authHeader(tech, tenant.id)).send({ threshold: 4 })).status).toBe(403);
    expect((await request(app).delete('/api/maintenance/rules/alarm_repeat').set(authHeader(admin, tenant.id))).status).toBe(404);

    const g = await request(app).put('/api/maintenance/rules/alarm_repeat?global=1').set(authHeader(superadmin, tenant.id)).send({ threshold: 3, window_hours: 168 });
    expect(g.status).toBe(200);
    expect(g.body.data.tenant_id).toBeNull();
  });

  it('lists are tenant-scoped and per-device; ack and dismiss follow the alarm rules', async () => {
    const list = await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.map(h => h.device_id).sort()).toEqual(['HNT001', 'HNT002']);
    const mine = list.body.data.find(h => h.device_id === 'HNT001');
    expect(mine).toMatchObject({ rule_key: 'alarm_repeat', alarm_code: 'high_temp_alarm', device_name: 'Камера заморозки №1', value: 4, threshold: 3 });

    const all = await request(app).get('/api/maintenance/hints?active=all').set(authHeader(admin, tenant.id));
    expect(all.body.data.length).toBeGreaterThan(2);

    // technician with access to HNT001 sees that one, one without sees nothing
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(tech, tenant.id))).body.data.map(h => h.device_id)).toEqual(['HNT001']);
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(techNone, tenant.id))).body.data.length).toBe(0);

    // per device, by uuid and by mqtt id
    const byUuid = await request(app).get(`/api/devices/${d1.id}/hints`).set(authHeader(viewer, tenant.id));
    expect(byUuid.status).toBe(200);
    expect(byUuid.body.feature_enabled).toBe(true);
    expect(byUuid.body.data.filter(h => !h.closed_at).length).toBe(1);
    expect((await request(app).get('/api/devices/HNT001/hints').set(authHeader(techNone, tenant.id))).status).toBe(403);

    // ack: viewer no, technician with access yes, twice no
    const id = mine.id;
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(viewer, tenant.id)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(techNone, tenant.id)).send({})).status).toBe(403);
    const ack = await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(tech, tenant.id)).send({ note: 'Дивлюсь завтра' });
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({ id, alarm_code: 'high_temp_alarm', ack_note: 'Дивлюсь завтра', acknowledged_by_email: 'tech@hints.test' });
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);

    // an acknowledged hint stays open and is still refreshed
    await maintenance.evaluateAll({ now: at(8) });
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data.map(h => h.id)).toContain(id);

    // dismiss: technician no, admin yes, then it is closed and cannot be acked
    expect((await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(tech, tenant.id)).send({})).status).toBe(403);
    const dis = await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(admin, tenant.id)).send({ note: 'Планове ТО зроблено' });
    expect(dis.status).toBe(200);
    expect(dis.body.data).toMatchObject({ id, closed_reason: 'dismissed' });
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);
    expect((await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);

    // a dismissed hint reopens next hour while the alarms are still there: dismiss is "not now", not "never"
    const before = (await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data.length;
    await maintenance.evaluateAll({ now: at(9) });
    const after = (await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data;
    expect(after.length).toBe(before + 1);
    expect(after.find(h => h.id === id)).toBeUndefined();

    // the other organisation cannot see or touch them
    const other = after.find(h => h.device_id === 'HNT002');
    expect((await request(app).post(`/api/maintenance/hints/${other.id}/ack`).set(authHeader(freeAdmin, freeTenant.id)).send({})).status).toBe(402);
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(freeAdmin, freeTenant.id))).status).toBe(402);
    const fdev = await request(app).get(`/api/devices/${fd.id}/hints`).set(authHeader(freeAdmin, freeTenant.id));
    expect(fdev.status).toBe(200);
    expect(fdev.body).toMatchObject({ data: [], feature_enabled: false });

    // the device list carries the open count
    const devs = await request(app).get('/api/devices').set(authHeader(admin, tenant.id));
    expect(devs.body.data.find(d => d.mqtt_device_id === 'HNT001').hints_open).toBe(1);
    expect(devs.body.data.find(d => d.mqtt_device_id === 'HNT002').hints_open).toBe(1);

    // evaluate on demand is superadmin-only
    expect((await request(app).post('/api/maintenance/evaluate').set(authHeader(admin, tenant.id))).status).toBe(403);
    expect((await request(app).post('/api/maintenance/evaluate').set(authHeader(superadmin, tenant.id))).status).toBe(200);
  });

  it('countByCode and resolveRule: window edge and scope order', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const a = (h, code) => ({ alarm_code: code, triggered_at: new Date(from.getTime() + h * 3600e3) });
    const counts = maintenance.__test.countByCode([a(0, 'door_alarm'), a(1, 'door_alarm'), a(2, 'door_alarm'), a(2, 'high_temp_alarm')], from);
    expect(counts.get('door_alarm')).toBe(2);        // the alarm exactly at `from` is outside
    expect(counts.get('high_temp_alarm')).toBe(1);

    const T = 'tenant-1';
    const rules = [
      { rule_key: 'alarm_repeat', tenant_id: null, model: null,   threshold: 3, enabled: true },
      { rule_key: 'alarm_repeat', tenant_id: null, model: 'KF6',  threshold: 5, enabled: true },
      { rule_key: 'alarm_repeat', tenant_id: T,    model: null,   threshold: 2, enabled: true },
      { rule_key: 'alarm_repeat', tenant_id: T,    model: 'KF6',  threshold: 4, enabled: false },
    ];
    expect(maintenance.__test.resolveRule(rules, 'alarm_repeat', T, 'KF6')).toBeNull();          // disabled at the most specific level
    expect(maintenance.__test.resolveRule(rules, 'alarm_repeat', T, 'XL').threshold).toBe(2);
    expect(maintenance.__test.resolveRule(rules, 'alarm_repeat', 'other', 'KF6').threshold).toBe(5);
    expect(maintenance.__test.resolveRule(rules, 'alarm_repeat', 'other', null).threshold).toBe(3);
  });
});
