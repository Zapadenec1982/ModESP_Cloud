'use strict';

// globals: true in vitest.config.js
//
// Maintenance hints (plan epic 2.4): five repair-prevention rules read the
// events, telemetry and live state the platform already keeps; a hint opens
// once per (device, rule), is refreshed while the metric stays over the line,
// closes on its own when it drops back, and can be acknowledged (admin,
// technician with device access) or dismissed (admin). Organisations tune the
// thresholds; the free plan has no rules running; administrators are notified.

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
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);

async function seedEvents(tenantId, deviceId, type, times) {
  for (const t of times) {
    await db.query(`INSERT INTO events (tenant_id, device_id, event_type, time) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, deviceId, type, t]);
  }
}
async function openHints(tenantId, deviceId) {
  const { rows } = await db.query(
    `SELECT rule_key, value::float AS value, threshold::float AS threshold, acknowledged_at, closed_at, closed_reason
       FROM maintenance_hints WHERE tenant_id = $1 AND device_id = $2 ORDER BY rule_key`, [tenantId, deviceId]);
  return rows;
}
const keys = (rows) => rows.filter(r => !r.closed_at).map(r => r.rule_key).sort();

describe('maintenance hints', () => {
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
    d2 = await createDevice(tenant.id, { mqttId: 'HNT002', name: 'Офлайн' });
    fd = await createDevice(freeTenant.id, { mqttId: 'HNTF01' });
    await grantDeviceAccess(tech.id, d1.id, admin.id);
    await grantDeviceAccess(viewer.id, d1.id, admin.id);
    await db.query(`UPDATE devices SET online = true, model = 'ModESP-KF6', last_state = '{"defrost.consecutive_timeouts": 4}'::jsonb WHERE id = $1`, [d1.id]);
    await db.query(`UPDATE devices SET online = false, last_state = '{"defrost.consecutive_timeouts": 9}'::jsonb WHERE id = $1`, [d2.id]);
    await db.query(`UPDATE devices SET online = true, last_state = '{"defrost.consecutive_timeouts": 9}'::jsonb WHERE id = $1`, [fd.id]);

    // d1: 10 compressor starts per hour for 24 h (short cycling), each ON 2 min → duty ≈ 33 %
    const on = [], off = [];
    // First start one minute inside the window (the evaluator reads (from, now]),
    // and the series runs 12 h past NOW so the later evaluations, whose window
    // slides forward, still see a full day of short cycling.
    for (let i = 0; i < 360; i++) { on.push(new Date(hoursAgo(24).getTime() + 60e3 + i * 6 * 60e3)); off.push(new Date(hoursAgo(24).getTime() + 60e3 + i * 6 * 60e3 + 2 * 60e3)); }
    await seedEvents(tenant.id, 'HNT001', 'compressor_on', on);
    await seedEvents(tenant.id, 'HNT001', 'compressor_off', off);
    // 100 door openings in 24 h
    const doors = []; for (let i = 0; i < 100; i++) doors.push(new Date(hoursAgo(23).getTime() + i * 13 * 60e3));
    await seedEvents(tenant.id, 'HNT001', 'door_open', doors);
    // condenser at 60 °C, 24 samples
    for (let i = 0; i < 24; i++) {
      await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ($1, $2, 'HNT001', 'cond', 60) ON CONFLICT DO NOTHING`, [hoursAgo(i + 0.5), tenant.id]);
    }
    // the offline device has the same evidence and must be ignored
    await seedEvents(tenant.id, 'HNT002', 'door_open', doors);
    // the free tenant's device too
    await seedEvents(freeTenant.id, 'HNTF01', 'door_open', doors);
  });

  afterAll(async () => {
    push.__test.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  it('opens one hint per rule the device crosses, ignores offline devices and plans without the feature', async () => {
    const report = await maintenance.evaluateAll({ now: NOW });
    expect(report['hints-a']).toMatchObject({ opened: 4, devices: 2 });
    expect(report['hints-free']).toBeUndefined();

    const rows = await openHints(tenant.id, 'HNT001');
    expect(keys(rows)).toEqual(['compressor_starts', 'cond_temp', 'defrost_timeouts', 'door_openings']);
    const starts = rows.find(r => r.rule_key === 'compressor_starts');
    expect(starts.value).toBe(10);
    expect(starts.threshold).toBe(8);
    expect(await openHints(tenant.id, 'HNT002')).toEqual([]);
    expect(await openHints(freeTenant.id, 'HNTF01')).toEqual([]);

    // administrators were told once per hint; the technician was not
    const admins = sent.filter(s => s.address === '7001');
    expect(admins.map(s => s.payload.type)).toEqual(['hint', 'hint', 'hint', 'hint']);
    expect(admins.map(s => s.payload.ruleKey).sort()).toEqual(['compressor_starts', 'cond_temp', 'defrost_timeouts', 'door_openings']);
    expect(admins[0].payload.deviceName).toBe('Камера заморозки №1');
    expect(sent.some(s => s.address === '7002')).toBe(false);
    const { rows: log } = await db.query(`SELECT alarm_code FROM notification_log WHERE tenant_id = $1 ORDER BY id`, [tenant.id]);
    expect(log.map(l => l.alarm_code).sort()).toEqual(['hint:compressor_starts', 'hint:cond_temp', 'hint:defrost_timeouts', 'hint:door_openings']);
  });

  it('a second run refreshes instead of duplicating, and closes a hint once the metric is back under the line', async () => {
    sent = [];
    const r1 = await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 3600e3) });
    expect(r1['hints-a']).toMatchObject({ opened: 0, refreshed: 4, closed: 0 });
    expect(sent).toEqual([]);
    expect((await openHints(tenant.id, 'HNT001')).length).toBe(4);

    await db.query(`DELETE FROM events WHERE device_id = 'HNT001' AND event_type = 'door_open'`);
    const r2 = await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 2 * 3600e3) });
    expect(r2['hints-a']).toMatchObject({ opened: 0, closed: 1 });
    const door = (await openHints(tenant.id, 'HNT001')).find(r => r.rule_key === 'door_openings');
    expect(door.closed_at).not.toBeNull();
    expect(door.closed_reason).toBe('resolved');
  });

  it('the organisation raises a threshold and the hint closes; disabling a rule keeps it quiet', async () => {
    const put = await request(app).put('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id)).send({ threshold: 70 });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ rule_key: 'cond_temp', threshold: 70, window_hours: 24 });

    const rules = await request(app).get('/api/maintenance/rules').set(authHeader(admin, tenant.id));
    expect(rules.status).toBe(200);
    const cond = rules.body.data.find(r => r.rule_key === 'cond_temp');
    expect(cond).toMatchObject({ threshold: 70, overridden: true, default: { threshold: 55 } });
    expect(rules.body.data.find(r => r.rule_key === 'compressor_duty')).toMatchObject({ threshold: 85, overridden: false });

    await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 3 * 3600e3) });
    expect((await openHints(tenant.id, 'HNT001')).find(r => r.rule_key === 'cond_temp').closed_reason).toBe('resolved');

    // back to the default → reopens; then disabled → nothing opens again
    const del = await request(app).delete('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id));
    expect(del.status).toBe(200);
    await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 4 * 3600e3) });
    expect(keys(await openHints(tenant.id, 'HNT001'))).toContain('cond_temp');

    await request(app).put('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id)).send({ threshold: 55, enabled: false });
    await db.query(`UPDATE maintenance_hints SET closed_at = now(), closed_reason = 'dismissed' WHERE device_id = 'HNT001' AND rule_key = 'cond_temp' AND closed_at IS NULL`);
    await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 5 * 3600e3) });
    expect(keys(await openHints(tenant.id, 'HNT001'))).not.toContain('cond_temp');
    await request(app).delete('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id));
    plan.invalidate();
  });

  it('rule editing is validated and the platform defaults are the superadmin\'s', async () => {
    expect((await request(app).put('/api/maintenance/rules/nope').set(authHeader(admin, tenant.id)).send({ threshold: 1 })).status).toBe(404);
    expect((await request(app).put('/api/maintenance/rules/cond_temp').set(authHeader(admin, tenant.id)).send({ threshold: -1 })).status).toBe(400);
    expect((await request(app).put('/api/maintenance/rules/cond_temp?global=1').set(authHeader(admin, tenant.id)).send({ threshold: 60 })).status).toBe(403);
    expect((await request(app).put('/api/maintenance/rules/cond_temp').set(authHeader(tech, tenant.id)).send({ threshold: 60 })).status).toBe(403);
    expect((await request(app).delete('/api/maintenance/rules/door_openings').set(authHeader(admin, tenant.id))).status).toBe(404);

    const g = await request(app).put('/api/maintenance/rules/cond_temp?global=1').set(authHeader(superadmin, tenant.id)).send({ threshold: 55, window_hours: 24 });
    expect(g.status).toBe(200);
    expect(g.body.data.tenant_id).toBeNull();
  });

  it('lists are tenant-scoped and per-device; ack and dismiss follow the alarm rules', async () => {
    const list = await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.every(h => h.device_id === 'HNT001')).toBe(true);
    expect(list.body.data[0]).toHaveProperty('device_name', 'Камера заморозки №1');
    // left open after the previous tests: compressor_starts and defrost_timeouts
    const openIds = list.body.data.map(h => h.id);
    expect(openIds.length).toBe(2);

    const all = await request(app).get('/api/maintenance/hints?active=all').set(authHeader(admin, tenant.id));
    expect(all.body.data.length).toBeGreaterThan(2);

    // technician with device access sees them, one without sees nothing
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(tech, tenant.id))).body.data.length).toBe(2);
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(techNone, tenant.id))).body.data.length).toBe(0);

    // per device, by uuid and by mqtt id
    const byUuid = await request(app).get(`/api/devices/${d1.id}/hints`).set(authHeader(viewer, tenant.id));
    expect(byUuid.status).toBe(200);
    expect(byUuid.body.feature_enabled).toBe(true);
    expect(byUuid.body.data.filter(h => !h.closed_at).length).toBe(2);
    expect((await request(app).get('/api/devices/HNT001/hints').set(authHeader(techNone, tenant.id))).status).toBe(403);

    // ack: viewer no, technician with access yes, twice no
    const id = openIds[0];
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(viewer, tenant.id)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(techNone, tenant.id)).send({})).status).toBe(403);
    const ack = await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(tech, tenant.id)).send({ note: 'Дивлюсь завтра' });
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({ id, ack_note: 'Дивлюсь завтра', acknowledged_by_email: 'tech@hints.test' });
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);

    // an acknowledged hint stays open and is still refreshed
    await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 6 * 3600e3) });
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data.map(h => h.id)).toContain(id);

    // dismiss: technician no, admin yes, then it is closed and cannot be acked
    expect((await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(tech, tenant.id)).send({})).status).toBe(403);
    const dis = await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(admin, tenant.id)).send({ note: 'Планове ТО зроблено' });
    expect(dis.status).toBe(200);
    expect(dis.body.data).toMatchObject({ id, closed_reason: 'dismissed' });
    expect((await request(app).post(`/api/maintenance/hints/${id}/ack`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);
    expect((await request(app).post(`/api/maintenance/hints/${id}/dismiss`).set(authHeader(admin, tenant.id)).send({})).status).toBe(409);

    // a dismissed hint does not reopen while the metric is still over the line
    const before = (await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data.length;
    await maintenance.evaluateAll({ now: new Date(NOW.getTime() + 7 * 3600e3) });
    const after = (await request(app).get('/api/maintenance/hints').set(authHeader(admin, tenant.id))).body.data;
    expect(after.length).toBe(before + 1);   // reopened: dismiss is "not now", the evidence is still there next hour
    expect(after.find(h => h.id === id)).toBeUndefined();

    // the other organisation cannot see or touch them
    expect((await request(app).post(`/api/maintenance/hints/${openIds[1]}/ack`).set(authHeader(freeAdmin, freeTenant.id)).send({})).status).toBe(402);
    expect((await request(app).get('/api/maintenance/hints').set(authHeader(freeAdmin, freeTenant.id))).status).toBe(402);
    const fdev = await request(app).get(`/api/devices/${fd.id}/hints`).set(authHeader(freeAdmin, freeTenant.id));
    expect(fdev.status).toBe(200);
    expect(fdev.body).toMatchObject({ data: [], feature_enabled: false });

    // the device list carries the open count
    const devs = await request(app).get('/api/devices').set(authHeader(admin, tenant.id));
    expect(devs.body.data.find(d => d.mqtt_device_id === 'HNT001').hints_open).toBe(after.length);
    expect(devs.body.data.find(d => d.mqtt_device_id === 'HNT002').hints_open).toBe(0);

    // evaluate on demand is superadmin-only
    expect((await request(app).post('/api/maintenance/evaluate').set(authHeader(admin, tenant.id))).status).toBe(403);
    expect((await request(app).post('/api/maintenance/evaluate').set(authHeader(superadmin, tenant.id))).status).toBe(200);
  });

  it('dutyPercent integrates ON time across the window edge', () => {
    const from = new Date('2026-01-01T00:00:00Z'), to = new Date('2026-01-02T00:00:00Z');
    const ev = (h, type) => ({ time: new Date(from.getTime() + h * 3600e3), event_type: type });
    expect(maintenance.__test.dutyPercent([], null, from, to)).toBeNull();
    expect(maintenance.__test.dutyPercent([], true, from, to)).toBe(100);
    expect(maintenance.__test.dutyPercent([ev(12, 'compressor_off')], true, from, to)).toBe(50);
    expect(maintenance.__test.dutyPercent([ev(6, 'compressor_on'), ev(18, 'compressor_off')], false, from, to)).toBe(50);
    expect(maintenance.__test.dutyPercent([ev(6, 'compressor_on')], null, from, to)).toBe(75);
  });
});
