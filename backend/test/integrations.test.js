'use strict';

// globals: true in vitest.config.js
//
// API keys and webhooks (plan epic 2.6): a key is a scoped machine identity
// kept away from the account surface; a webhook receives signed, retried
// deliveries of the organisation's events and switches off after repeated
// failures.

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const mqttSvc = require('../src/services/mqtt');
const webhooks = require('../src/services/webhooks');
const planMw = require('../src/middleware/plan');

const app = createTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting');
    await sleep(50);
  }
}
const deliveries = (hookId) => db.query('SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at', [hookId]).then(r => r.rows);

describe('integrations (plan epic 2.6)', () => {
  let tenant, other, freeTenant, site, device, admin, viewer, otherAdmin, freeAdmin;
  let receiver, port, received = [], respondWith = 200;

  beforeAll(async () => {
    await cleanDatabase();
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.WEBHOOK_INTERVAL_SEC = '0';
    webhooks.attach();
    tenant = await createTenant({ slug: 'int-a', plan: 'pro' });
    other  = await createTenant({ slug: 'int-b', plan: 'pro' });
    freeTenant = await createTenant({ slug: 'int-free', plan: 'free' });
    site = (await db.query(`INSERT INTO sites (tenant_id, name, timezone) VALUES ($1, 'Магазин №3', 'Europe/Kyiv') RETURNING id, name`, [tenant.id])).rows[0];
    device = await createDevice(tenant.id, { mqttId: 'INT001', name: 'Вітрина 3' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, device.id]);
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@int.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@int.test' });
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@int-b.test' });
    freeAdmin  = await createUser(freeTenant.id, { role: 'admin', email: 'admin@int-free.test' });

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(respondWith, { 'Content-Type': 'text/plain' }); res.end('ok'); });
    });
    await new Promise(r => receiver.listen(0, '127.0.0.1', r));
    port = receiver.address().port;
  });

  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    delete process.env.WEBHOOK_INTERVAL_SEC;
    await new Promise(r => receiver.close(r));
    await cleanDatabase();
    await shutdownDb();
  });

  // ── API keys ──

  let readKey, writeKey, readKeyId;

  it('an administrator on a plan with the api feature creates keys; the key is shown once', async () => {
    expect((await request(app).post('/api/api-keys').set(authHeader(freeAdmin, freeTenant.id)).send({ name: 'x' })).status).toBe(402);
    expect((await request(app).post('/api/api-keys').set(authHeader(viewer, tenant.id)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/api-keys').set(authHeader(admin, tenant.id)).send({ name: '' })).status).toBe(400);
    expect((await request(app).post('/api/api-keys').set(authHeader(admin, tenant.id)).send({ name: 'x', scope: 'root' })).status).toBe(400);

    const res = await request(app).post('/api/api-keys').set(authHeader(admin, tenant.id)).send({ name: 'CMMS', scope: 'read' });
    expect(res.status).toBe(201);
    readKey = res.body.data.key;
    readKeyId = res.body.data.id;
    expect(readKey).toMatch(/^modesp_[A-Za-z0-9_-]{43}$/);
    expect(res.body.data).toMatchObject({ name: 'CMMS', scope: 'read', active: true, prefix: readKey.slice(0, 15), created_by: admin.id });

    const w = await request(app).post('/api/api-keys').set(authHeader(admin, tenant.id)).send({ name: 'Automation', scope: 'write', expires_in_days: 30 });
    expect(w.status).toBe(201);
    writeKey = w.body.data.key;
    expect(new Date(w.body.data.expires_at) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const list = await request(app).get('/api/api-keys').set(authHeader(admin, tenant.id));
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body.data)).not.toContain(readKey.slice(20));
    expect((await request(app).get('/api/api-keys').set(authHeader(otherAdmin, other.id))).body.data).toEqual([]);
  });

  it('a key acts as its scope and never reaches the account surface', async () => {
    const list = await request(app).get('/api/devices').set(bearer(readKey));
    expect(list.status).toBe(200);
    expect(list.body.data.map(d => d.mqtt_device_id)).toContain('INT001');
    // read → viewer: no writes
    expect((await request(app).patch(`/api/devices/${device.id}`).set(bearer(readKey)).send({ name: 'x' })).status).toBe(403);
    // write → technician: acknowledging alarms is allowed
    const { rows: [alarm] } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at) VALUES ($1, 'INT001', 'high_temp_alarm', 'critical', true, now()) RETURNING id`, [tenant.id]);
    expect((await request(app).post(`/api/alarms/${alarm.id}/ack`).set(bearer(readKey)).send({})).status).toBe(403);
    const ack = await request(app).post(`/api/alarms/${alarm.id}/ack`).set(bearer(writeKey)).send({ note: 'from the CMMS' });
    expect(ack.status).toBe(200);
    expect(ack.body.data.acknowledged_by_email).toBe('apikey:Automation');
    // the denied surface
    for (const path of ['/api/users', '/api/api-keys', '/api/webhooks', '/api/profile', '/api/tenants', '/api/billing/invoices']) {
      const r = await request(app).get(path).set(bearer(writeKey));
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe('api_key_scope');
    }
    expect((await request(app).get('/api/auth/sessions').set(bearer(writeKey))).status).toBe(403);
    const { rows } = await db.query('SELECT last_used_at FROM api_keys WHERE id = $1', [readKeyId]);
    expect(rows[0].last_used_at).toBeTruthy();
    // the audit trail names the key
    const trail = await waitFor(async () => (await db.query(`SELECT user_email, user_id FROM audit_log WHERE action = 'alarm.ack' AND user_email = 'apikey:Automation' LIMIT 1`)).rows[0]);
    expect(trail).toMatchObject({ user_email: 'apikey:Automation', user_id: null });
  });

  it('a key stops when revoked, expired, without the plan feature, or in a suspended organisation', async () => {
    expect((await request(app).delete(`/api/api-keys/${readKeyId}`).set(authHeader(otherAdmin, other.id))).status).toBe(404);
    const rev = await request(app).delete(`/api/api-keys/${readKeyId}`).set(authHeader(admin, tenant.id));
    expect(rev.status).toBe(200);
    expect(rev.body.data.active).toBe(false);
    expect((await request(app).get('/api/devices').set(bearer(readKey))).status).toBe(401);
    expect((await request(app).get('/api/devices').set(bearer('modesp_nope'))).status).toBe(401);

    await db.query(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE name = 'Automation'`);
    expect((await request(app).get('/api/devices').set(bearer(writeKey))).status).toBe(401);
    await db.query(`UPDATE api_keys SET expires_at = NULL WHERE name = 'Automation'`);
    expect((await request(app).get('/api/devices').set(bearer(writeKey))).status).toBe(200);

    await db.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [tenant.id]);
    planMw.invalidate(tenant.id);
    const noApi = await request(app).get('/api/devices').set(bearer(writeKey));
    expect(noApi.status).toBe(402);
    expect(noApi.body.error).toBe('plan_feature');
    await db.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenant.id]);
    planMw.invalidate(tenant.id);

    // closed: reads, no writes; suspended: nothing
    await db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [tenant.id]);
    planMw.invalidate(tenant.id);
    expect((await request(app).get('/api/devices').set(bearer(writeKey))).status).toBe(200);
    expect((await request(app).patch(`/api/devices/${device.id}`).set(bearer(writeKey)).send({ name: 'x' })).status).toBe(423);
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenant.id]);
    planMw.invalidate(tenant.id);
    expect((await request(app).get('/api/devices').set(bearer(writeKey))).status).toBe(401);
    await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenant.id]);
    planMw.invalidate(tenant.id);
  });

  // ── Webhooks ──

  let hook, secret;

  it('a webhook needs a public http(s) target and the api feature; the secret is shown once', async () => {
    const post = (body, who = admin, t = tenant) => request(app).post('/api/webhooks').set(authHeader(who, t.id)).send(body);
    expect((await post({ name: 'x', url: `http://127.0.0.1:${port}/h`, events: ['alarm.raised'] }, freeAdmin, freeTenant)).status).toBe(402);
    expect((await post({ name: 'x', url: 'ftp://example.com/h', events: ['alarm.raised'] })).status).toBe(400);
    expect((await post({ name: 'x', url: 'https://user:pw@example.com/h', events: ['alarm.raised'] })).status).toBe(400);
    expect((await post({ name: 'x', url: 'https://example.com/h', events: ['nope'] })).status).toBe(400);
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const priv = await post({ name: 'x', url: `http://127.0.0.1:${port}/h`, events: ['alarm.raised'] });
    expect(priv.status).toBe(400);
    expect(priv.body.error).toBe('invalid_url');
    expect((await post({ name: 'x', url: 'http://localhost/h', events: ['alarm.raised'] })).status).toBe(400);
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';

    const res = await post({ name: 'CMMS', url: `http://127.0.0.1:${port}/hook`, events: ['alarm.raised', 'alarm.cleared', 'alarm.acknowledged', 'work_order.created', 'hint.opened'] });
    expect(res.status).toBe(201);
    hook = res.body.data;
    secret = hook.secret;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hook).toMatchObject({ name: 'CMMS', enabled: true, failures: 0, pending: 0, dead: 0 });
    const list = await request(app).get('/api/webhooks').set(authHeader(admin, tenant.id));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].secret).toBeUndefined();
    expect(list.body.meta.events).toContain('device.offline');
    const { rows } = await db.query('SELECT secret FROM webhooks WHERE id = $1', [hook.id]);
    expect(rows[0].secret).toMatch(/^v1:/);
    expect(rows[0].secret).not.toContain(secret);
  });

  it('an alarm becomes a signed delivery with the device and site named', async () => {
    received = [];
    mqttSvc.emit('alarm', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', alarmId: 41, alarmCode: 'high_temp_alarm', active: true, severity: 'critical' });
    const d = await waitFor(async () => (await deliveries(hook.id)).find(x => x.status === 'ok'));
    expect(d).toMatchObject({ event: 'alarm.raised', attempts: 1, status_code: 200 });
    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.headers['x-modesp-event']).toBe('alarm.raised');
    expect(r.headers['x-modesp-delivery']).toBe(d.id);
    expect(r.headers['user-agent']).toMatch(/ModESP-Cloud-Webhooks/);
    const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${r.headers['x-modesp-timestamp']}.${r.body}`).digest('hex');
    expect(r.headers['x-modesp-signature']).toBe(expected);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ id: d.id, event: 'alarm.raised', tenant_id: tenant.id });
    expect(body.data).toMatchObject({ device_id: 'INT001', device_name: 'Вітрина 3', site_name: site.name, alarm_code: 'high_temp_alarm', severity: 'critical', active: true, alarm_id: 41 });

    // Not subscribed to presence: nothing queued for it
    mqttSvc.emit('device_status', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', online: true, lastSeen: new Date().toISOString() });
    await sleep(200);
    expect((await deliveries(hook.id)).map(x => x.event)).toEqual(['alarm.raised']);
    // Another organisation's alarm never reaches this hook
    mqttSvc.emit('alarm', { tenantSlug: 'int-b', tenantId: other.id, deviceId: 'ZZZ', alarmCode: 'door_alarm', active: true, severity: 'warning' });
    await sleep(200);
    expect(await deliveries(hook.id)).toHaveLength(1);
  });

  it('acknowledgements, work orders and hints map to their events', async () => {
    received = [];
    const { rows: [alarm] } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at) VALUES ($1, 'INT001', 'door_alarm', 'warning', true, now()) RETURNING id`, [tenant.id]);
    expect((await request(app).post(`/api/alarms/${alarm.id}/ack`).set(authHeader(admin, tenant.id)).send({ note: 'seen' })).status).toBe(200);
    mqttSvc.emit('work_order', { tenantId: tenant.id, tenantSlug: 'int-a', orderId: 7, deviceId: 'INT001', status: 'open', assignedTo: null, action: 'created' });
    mqttSvc.emit('hint', { tenantId: tenant.id, tenantSlug: 'int-a', deviceId: 'INT001', deviceUuid: device.id, ruleKey: 'alarm_repeat', alarmCode: 'door_alarm', severity: 'info', value: 3, threshold: 3, windowHours: 168, hintId: 5, active: true });
    await waitFor(async () => (await deliveries(hook.id)).filter(x => x.status === 'ok').length >= 4);
    const events = received.map(r => r.headers['x-modesp-event']).sort();
    expect(events).toEqual(['alarm.acknowledged', 'hint.opened', 'work_order.created']);
    const ack = JSON.parse(received.find(r => r.headers['x-modesp-event'] === 'alarm.acknowledged').body);
    expect(ack.data).toMatchObject({ alarm_id: alarm.id, alarm_code: 'door_alarm', acknowledged_by: admin.email, device_name: 'Вітрина 3' });
    const wo = JSON.parse(received.find(r => r.headers['x-modesp-event'] === 'work_order.created').body);
    expect(wo.data).toMatchObject({ work_order_id: 7, status: 'open', action: 'created', device_id: 'INT001' });
    const hint = JSON.parse(received.find(r => r.headers['x-modesp-event'] === 'hint.opened').body);
    expect(hint.data).toMatchObject({ hint_id: 5, rule_key: 'alarm_repeat', value: 3, threshold: 3 });
  });

  it('a failing target is retried with backoff, then the delivery is dead and the hook switched off', async () => {
    respondWith = 500;
    received = [];
    mqttSvc.emit('alarm', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', alarmId: 42, alarmCode: 'high_temp_alarm', active: false, severity: 'critical' });
    let d = await waitFor(async () => (await deliveries(hook.id)).find(x => x.event === 'alarm.cleared' && x.attempts === 1));
    expect(d.status).toBe('pending');
    expect(d.status_code).toBe(500);
    expect(new Date(d.next_attempt_at) - new Date(d.created_at)).toBeGreaterThanOrEqual(59_000);
    // Not due yet: nothing happens now
    expect(await webhooks.deliverDue()).toBe(0);
    // Walk the schedule: 1 min, 5 min, 30 min, 2 h, 12 h → dead after 5 attempts
    let clock = Date.now();
    for (const step of webhooks.BACKOFF_MS) {
      clock += step + 1000;
      await webhooks.deliverDue({ now: new Date(clock) });
    }
    d = (await deliveries(hook.id)).find(x => x.event === 'alarm.cleared');
    expect(d).toMatchObject({ status: 'dead', attempts: 5 });
    let h = (await request(app).get('/api/webhooks').set(authHeader(admin, tenant.id))).body.data[0];
    expect(h).toMatchObject({ enabled: true, failures: 5, dead: 1, last_status: 500 });

    // Five more failures on another event: ten in a row switch the hook off
    mqttSvc.emit('alarm', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', alarmId: 43, alarmCode: 'door_alarm', active: true, severity: 'warning' });
    await waitFor(async () => (await deliveries(hook.id)).find(x => x.payload.data.alarm_id === 43 && x.attempts === 1));
    for (const step of webhooks.BACKOFF_MS) { clock += step + 1000; await webhooks.deliverDue({ now: new Date(clock) }); }
    h = (await request(app).get('/api/webhooks').set(authHeader(admin, tenant.id))).body.data[0];
    expect(h).toMatchObject({ enabled: false, failures: 10, disabled_reason: 'failures', dead: 2 });
    expect(h.disabled_at).toBeTruthy();
    // Nothing is queued for a disabled hook
    mqttSvc.emit('alarm', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', alarmId: 44, alarmCode: 'door_alarm', active: true, severity: 'warning' });
    await sleep(200);
    expect((await deliveries(hook.id)).find(x => x.payload.data.alarm_id === 44)).toBeUndefined();

    // Re-enabling resets the count; the target is healthy again
    respondWith = 200;
    const on = await request(app).patch(`/api/webhooks/${hook.id}`).set(authHeader(admin, tenant.id)).send({ enabled: true });
    expect(on.body.data).toMatchObject({ enabled: true, failures: 0, disabled_at: null, disabled_reason: null });
  });

  it('test, redeliver, deliveries listing, secret rotation and tenant isolation', async () => {
    received = [];
    const t = await request(app).post(`/api/webhooks/${hook.id}/test`).set(authHeader(admin, tenant.id));
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ ok: true, status_code: 200 });
    expect(received[0].headers['x-modesp-event']).toBe('ping');

    const dead = (await deliveries(hook.id)).find(x => x.status === 'dead');
    const rd = await request(app).post(`/api/webhooks/${hook.id}/deliveries/${dead.id}/redeliver`).set(authHeader(admin, tenant.id));
    expect(rd.status).toBe(202);
    const again = await waitFor(async () => (await deliveries(hook.id)).find(x => x.id === rd.body.data.id && x.status === 'ok'));
    expect(again.payload.redelivery_of).toBe(dead.id);
    expect(again.event).toBe(dead.event);

    const list = await request(app).get(`/api/webhooks/${hook.id}/deliveries?status=dead`).set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.every(x => x.status === 'dead')).toBe(true);
    expect(list.body.data[0].payload.event).toBeTruthy();
    expect((await request(app).get(`/api/webhooks/${hook.id}/deliveries`).set(authHeader(otherAdmin, other.id))).status).toBe(404);
    expect((await request(app).patch(`/api/webhooks/${hook.id}`).set(authHeader(otherAdmin, other.id)).send({ name: 'x' })).status).toBe(404);

    const rot = await request(app).post(`/api/webhooks/${hook.id}/rotate-secret`).set(authHeader(admin, tenant.id));
    expect(rot.status).toBe(200);
    expect(rot.body.data.secret).not.toBe(secret);
    received = [];
    mqttSvc.emit('alarm', { tenantSlug: 'int-a', tenantId: tenant.id, deviceId: 'INT001', alarmId: 45, alarmCode: 'door_alarm', active: true, severity: 'warning' });
    await waitFor(async () => received.length === 1);
    const r = received[0];
    expect(r.headers['x-modesp-signature']).toBe('v1=' + crypto.createHmac('sha256', rot.body.data.secret).update(`${r.headers['x-modesp-timestamp']}.${r.body}`).digest('hex'));

    // Manual off keeps its own reason; delete
    const off = await request(app).patch(`/api/webhooks/${hook.id}`).set(authHeader(admin, tenant.id)).send({ enabled: false });
    expect(off.body.data).toMatchObject({ enabled: false, disabled_reason: 'manual' });
    expect((await request(app).delete(`/api/webhooks/${hook.id}`).set(authHeader(admin, tenant.id))).status).toBe(200);
    expect(await deliveries(hook.id)).toEqual([]);
  });
});
