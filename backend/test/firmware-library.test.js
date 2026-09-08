'use strict';

/**
 * Firmware library, pre-OTA checks, rollback and rollout notifications
 * (plan epic 2.8). Runs the real OTA service against the database; only
 * the MQTT publish is recorded instead of sent.
 */

process.env.OTA_MAX_DEFERRALS = '1';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, createFirmware, grantDeviceAccess, authHeader } = require('./helpers/factories');
const otaSvc = require('../src/services/ota');
const mqttSvc = require('../src/services/mqtt');
const pushSvc = require('../src/services/push');
const webhooks = require('../src/services/webhooks');

const app = createTestApp();
Object.assign(otaSvc, otaSvc.__real);

const sent = [];
mqttSvc.sendJsonCommand = async (slug, deviceId, key, payload) => { sent.push({ slug, deviceId, key, payload }); };
const notified = [];
pushSvc.notifyRollout = async (evt) => { notified.push(evt); };

const bin = () => Buffer.from('fake-firmware-binary-' + Math.random());
async function waitFor(probe, { timeout = 3000, step = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor: timed out');
    await new Promise(r => setTimeout(r, step));
  }
}
const upload = (user, tenantId, fields) => {
  let r = request(app).post('/api/firmware/upload').set(authHeader(user, tenantId));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', bin(), 'firmware.bin');
};

describe('firmware library (plan epic 2.8)', () => {
  let a, b, adminA, adminB, techA, viewerA, superadmin, devA1, devA2, devA3, ownFw;

  beforeAll(async () => {
    await cleanDatabase();
    a = await createTenant({ slug: 'lib-a' });
    b = await createTenant({ slug: 'lib-b' });
    adminA = await createUser(a.id, { role: 'admin', email: 'admin@lib-a.test' });
    adminB = await createUser(b.id, { role: 'admin', email: 'admin@lib-b.test' });
    techA = await createUser(a.id, { role: 'technician', email: 'tech@lib-a.test' });
    viewerA = await createUser(a.id, { role: 'viewer', email: 'viewer@lib-a.test' });
    superadmin = await createUser(a.id, { role: 'superadmin', email: 'root@lib.test' });
    devA1 = await createDevice(a.id, { name: 'Cabinet 1' });
    devA2 = await createDevice(a.id, { name: 'Cabinet 2' });
    devA3 = await createDevice(a.id, { name: 'Cabinet 3' });
    await db.query(`UPDATE devices SET online = true, firmware_version = '1.0.0' WHERE id = ANY($1)`, [[devA1.id, devA2.id, devA3.id]]);
    await grantDeviceAccess(techA.id, devA1.id, adminA.id);
    ownFw = await createFirmware(a.id, { version: '1.0.0' });
    if (webhooks.__test && webhooks.__test.setAutoRun) webhooks.__test.setAutoRun(false);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  beforeEach(() => { sent.length = 0; notified.length = 0; });

  // ── Library and visibility ──

  it('a superadmin publishes a platform firmware to selected organisations; admins cannot', async () => {
    const denied = await upload(adminA, a.id, { version: '2.0.0', global: 'true' });
    expect(denied.status).toBe(403);

    const res = await upload(superadmin, a.id, { version: '2.0.0', global: 'true', visibility: 'selected', tenant_ids: JSON.stringify([a.id]) });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ global: true, visibility: 'selected', version: '2.0.0', tenant_id: null, visible_to_count: 1 });
    expect(res.body.data.visible_to.map(v => v.tenant_id)).toEqual([a.id]);
    expect(res.body.data.filename).toMatch(/^global_2\.0\.0_/);

    // the same version twice at platform level → 409; the same version inside an organisation is a different firmware
    expect((await upload(superadmin, a.id, { version: '2.0.0', global: 'true' })).status).toBe(409);
    expect((await upload(adminB, b.id, { version: '2.0.0' })).status).toBe(201);

    const listA = await request(app).get('/api/firmware').set(authHeader(adminA, a.id));
    expect(listA.body.data.map(f => [f.version, f.global])).toEqual(expect.arrayContaining([['1.0.0', false], ['2.0.0', true]]));
    const listB = await request(app).get('/api/firmware').set(authHeader(adminB, b.id));
    expect(listB.body.data.filter(f => f.global)).toEqual([]);      // not published to B
    expect((await request(app).get('/api/firmware').set(authHeader(viewerA, a.id))).status).toBe(403);
    expect((await request(app).get('/api/firmware').set(authHeader(techA, a.id))).status).toBe(200);
  });

  it('publication changes with PATCH; an organisation admin cannot touch platform firmware', async () => {
    const { rows: [fw] } = await db.query(`SELECT id FROM firmwares WHERE tenant_id IS NULL AND version = '2.0.0'`);
    expect((await request(app).patch(`/api/firmware/${fw.id}`).set(authHeader(adminA, a.id)).send({ notes: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/firmware/${fw.id}`).set(authHeader(adminA, a.id))).status).toBe(403);

    const all = await request(app).patch(`/api/firmware/${fw.id}`).set(authHeader(superadmin, a.id)).send({ visibility: 'all', notes: 'For everyone' });
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ visibility: 'all', notes: 'For everyone' });
    const listB = await request(app).get('/api/firmware').set(authHeader(adminB, b.id));
    expect(listB.body.data.some(f => f.global && f.version === '2.0.0')).toBe(true);

    const back = await request(app).patch(`/api/firmware/${fw.id}`).set(authHeader(superadmin, a.id)).send({ visibility: 'selected', tenant_ids: [b.id] });
    expect(back.body.data.visible_to.map(v => v.tenant_id)).toEqual([b.id]);
    expect((await request(app).get(`/api/firmware/${fw.id}`).set(authHeader(adminA, a.id))).status).toBe(404);
    // own firmware has no visibility of its own
    expect((await request(app).patch(`/api/firmware/${ownFw.id}`).set(authHeader(adminA, a.id)).send({ visibility: 'all' })).status).toBe(400);
    await request(app).patch(`/api/firmware/${fw.id}`).set(authHeader(superadmin, a.id)).send({ visibility: 'all' });
  });

  // ── Pre-OTA checks ──

  it('deploy refuses an offline device, and a technician may not force the soft checks', async () => {
    await db.query(`UPDATE devices SET online = false WHERE id = $1`, [devA1.id]);
    const off = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA1.mqtt_device_id, force: true });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: 'precheck_failed', reasons: ['offline'], forceable: false });
    await db.query(`UPDATE devices SET online = true, last_state = '{"defrost.active": true}'::jsonb WHERE id = $1`, [devA1.id]);

    const defrost = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA1.mqtt_device_id });
    expect(defrost.status).toBe(409);
    expect(defrost.body).toMatchObject({ reasons: ['defrost'], forceable: true });

    const techForce = await request(app).post('/api/ota/deploy').set(authHeader(techA, a.id)).send({ firmware_id: ownFw.id, device_id: devA1.mqtt_device_id, force: true });
    expect(techForce.status).toBe(409);
    expect(techForce.body.reasons).toEqual(['defrost']);
    expect((await request(app).post('/api/ota/deploy').set(authHeader(techA, a.id)).send({ firmware_id: ownFw.id, device_id: devA2.mqtt_device_id })).status).toBe(403);

    const forced = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA1.mqtt_device_id, force: true });
    expect(forced.status).toBe(201);
    expect(forced.body.data).toMatchObject({ status: 'sent', forced: true, overridden: ['defrost'], kind: 'deploy' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ deviceId: devA1.mqtt_device_id, key: '_ota' });
    const { rows: [job] } = await db.query(`SELECT actor, created_by, forced, firmware_version FROM ota_jobs WHERE id = $1`, [forced.body.data.job_id]);
    expect(job).toMatchObject({ actor: 'admin@lib-a.test', created_by: adminA.id, forced: true, firmware_version: '1.0.0' });
    await db.query(`UPDATE ota_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1`, [forced.body.data.job_id]);
    await db.query(`UPDATE devices SET last_state = NULL WHERE id = $1`, [devA1.id]);
  });

  it('an active critical alarm and the OTA window block a deploy until forced', async () => {
    await db.query(`INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at) VALUES ($1, $2, 'high_temp_alarm', 'critical', true, now())`, [a.id, devA2.mqtt_device_id]);
    const alarm = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA2.mqtt_device_id });
    expect(alarm.status).toBe(409);
    expect(alarm.body.reasons).toEqual(['critical_alarm']);
    await db.query(`UPDATE alarms SET active = false, cleared_at = now() WHERE device_id = $1`, [devA2.mqtt_device_id]);

    // a one-hour window that opens in two hours (local time of the organisation)
    const cur = otaSvc.__test.localMinutes('Europe/Kyiv');
    const from = (cur + 120) % 1440, to = (cur + 180) % 1440;
    const set = await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: from, ota_window_to: to });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ ota_window_from: from, ota_window_to: to });
    expect((await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: 1500 })).status).toBe(400);

    const closed = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA2.mqtt_device_id });
    expect(closed.status).toBe(409);
    expect(closed.body.reasons).toEqual(['outside_window']);
    expect(closed.body.window).toMatchObject({ from, to, timezone: 'Europe/Kyiv' });

    // a window around now lets it through; a wrap-around window is understood
    expect(otaSvc.__test.inWindow({ timezone: 'UTC', from: 1380, to: 60 }, new Date('2026-01-01T23:30:00Z'))).toBe(true);
    expect(otaSvc.__test.inWindow({ timezone: 'UTC', from: 1380, to: 60 }, new Date('2026-01-01T12:00:00Z'))).toBe(false);
    await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: (cur + 1410) % 1440, ota_window_to: (cur + 30) % 1440 });
    const open = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: ownFw.id, device_id: devA2.mqtt_device_id });
    expect(open.status).toBe(201);
    expect(open.body.data.forced).toBe(false);
    await db.query(`UPDATE ota_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1`, [open.body.data.job_id]);
    await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: null, ota_window_to: null });
  });

  // ── Rollback ──

  it('rolls a device back to the version it ran before its last successful update', async () => {
    const fw11 = await createFirmware(a.id, { version: '1.1.0' });
    const dep = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: fw11.id, device_id: devA3.mqtt_device_id });
    expect(dep.status).toBe(201);
    const none = await request(app).get('/api/ota/rollback').set(authHeader(adminA, a.id)).query({ device_id: devA3.mqtt_device_id });
    expect(none.body.data).toMatchObject({ current_version: '1.0.0', previous_version: null, available: false });

    // the controller reports the new version → the job succeeds with pre_ota_version = 1.0.0
    await db.query(`UPDATE devices SET firmware_version = '1.1.0' WHERE id = $1`, [devA3.id]);
    await otaSvc.__test.checkOtaStatus();
    const { rows: [job] } = await db.query(`SELECT status, pre_ota_version FROM ota_jobs WHERE id = $1`, [dep.body.data.job_id]);
    expect(job).toEqual({ status: 'succeeded', pre_ota_version: '1.0.0' });

    const preview = await request(app).get('/api/ota/rollback').set(authHeader(adminA, a.id)).query({ device_id: devA3.mqtt_device_id });
    expect(preview.body.data).toMatchObject({ current_version: '1.1.0', previous_version: '1.0.0', available: true, firmware: { id: ownFw.id, version: '1.0.0' } });

    const rb = await request(app).post('/api/ota/rollback').set(authHeader(adminA, a.id)).send({ device_id: devA3.mqtt_device_id });
    expect(rb.status).toBe(201);
    expect(rb.body.data).toMatchObject({ kind: 'rollback', firmware_version: '1.0.0', status: 'sent' });
    expect(sent.at(-1).payload.version).toBe('1.0.0');
    expect((await request(app).post('/api/ota/rollback').set(authHeader(adminA, a.id)).send({ device_id: devA3.mqtt_device_id })).body.error).toBe('ota_in_progress');
    await db.query(`UPDATE ota_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1`, [rb.body.data.job_id]);

    // without the previous version in the library the rollback is unavailable, and it names the version
    await db.query(`UPDATE firmwares SET version = '1.0.0-renamed' WHERE id = $1`, [ownFw.id]);
    const gone = await request(app).post('/api/ota/rollback').set(authHeader(adminA, a.id)).send({ device_id: devA3.mqtt_device_id });
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ error: 'rollback_unavailable', previous_version: '1.0.0' });
    await db.query(`UPDATE firmwares SET version = '1.0.0' WHERE id = $1`, [ownFw.id]);
    await db.query(`UPDATE devices SET firmware_version = '1.0.0' WHERE id = $1`, [devA3.id]);
  });

  // ── Deleting firmware ──

  it('deleting a firmware keeps the history readable and refuses while it is in use', async () => {
    const fw = await createFirmware(a.id, { version: '1.2.0' });
    const dep = await request(app).post('/api/ota/deploy').set(authHeader(adminA, a.id)).send({ firmware_id: fw.id, device_id: devA2.mqtt_device_id });
    expect(dep.status).toBe(201);
    const busy = await request(app).delete(`/api/firmware/${fw.id}`).set(authHeader(adminA, a.id));
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'firmware_in_use', active_jobs: 1 });

    await db.query(`UPDATE ota_jobs SET status = 'failed', completed_at = now(), error = 'timeout' WHERE id = $1`, [dep.body.data.job_id]);
    const del = await request(app).delete(`/api/firmware/${fw.id}`).set(authHeader(adminA, a.id));
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ deleted: true, history_jobs: 1 });

    const jobs = await request(app).get('/api/ota/jobs').set(authHeader(adminA, a.id)).query({ device_id: devA2.mqtt_device_id });
    const row = jobs.body.data.find(j => j.id === dep.body.data.job_id);
    expect(row).toMatchObject({ firmware_version: '1.2.0', firmware_deleted: true, firmware_id: null, status: 'failed' });
  });

  // ── Rollouts: deferral, auto-pause, completion ──

  it('a rollout defers devices that fail the checks, then fails them; too many failures pause it and tell the admins', async () => {
    const fw = await createFirmware(a.id, { version: '1.3.0' });
    await db.query(`UPDATE devices SET online = false WHERE id = $1`, [devA1.id]);
    await db.query(`UPDATE devices SET online = true WHERE id = ANY($1)`, [[devA2.id, devA3.id]]);
    const hook = await db.query(
      `INSERT INTO webhooks (tenant_id, name, url, secret, events, enabled) VALUES ($1, 'all', 'http://127.0.0.1:1/hook', $2, '{*}', true) RETURNING id`,
      [a.id, webhooks.encryptSecret('s'.repeat(32))]);
    webhooks.attach();

    const res = await request(app).post('/api/ota/rollout').set(authHeader(adminA, a.id)).send({
      firmware_id: fw.id, device_ids: [devA1.mqtt_device_id, devA2.mqtt_device_id, devA3.mqtt_device_id], batch_size: 10, batch_interval_s: 60, fail_threshold_pct: 50,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ total_devices: 3, fail_threshold_pct: 50, status: 'running' });
    const rid = res.body.data.rollout_id;

    // first batch: two sent, the offline one deferred and moved to the back
    let { rows } = await db.query(`SELECT device_id, status, deferrals, defer_reason FROM ota_jobs WHERE rollout_id = $1 ORDER BY device_id`, [rid]);
    expect(rows.find(r => r.device_id === devA1.mqtt_device_id)).toMatchObject({ status: 'queued', deferrals: 1, defer_reason: 'offline' });
    expect(rows.filter(r => r.status === 'sent')).toHaveLength(2);
    expect(sent).toHaveLength(2);
    const list = await request(app).get('/api/ota/rollouts').set(authHeader(adminA, a.id));
    expect(list.body.data.find(r => r.id === rid)).toMatchObject({ queued: 1, deferred: 1, sent: 2, created_by_email: 'admin@lib-a.test' });

    // second batch: OTA_MAX_DEFERRALS=1 → the offline device fails the checks for good
    await otaSvc.__test.processRolloutBatch(rid, 'lib-a');
    ({ rows } = await db.query(`SELECT status, error FROM ota_jobs WHERE rollout_id = $1 AND device_id = $2`, [rid, devA1.mqtt_device_id]));
    expect(rows[0]).toEqual({ status: 'failed', error: 'precheck: offline' });

    // one of the two sent ones times out → 2 of 2 completed failed = 100% ≥ 50% → paused with a notification
    await db.query(`UPDATE ota_jobs SET sent_at = now() - interval '1 hour' WHERE rollout_id = $1 AND device_id = $2`, [rid, devA2.mqtt_device_id]);
    await otaSvc.__test.checkOtaStatus();
    await otaSvc.__test.processRolloutBatch(rid, 'lib-a');
    const { rows: [r1] } = await db.query(`SELECT status, paused_reason FROM ota_rollouts WHERE id = $1`, [rid]);
    expect(r1).toEqual({ status: 'paused', paused_reason: 'failures' });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ tenantId: a.id, rolloutId: rid, event: 'paused', firmwareVersion: '1.3.0', failed: 2, failPct: 100, threshold: 50 });
    // the webhook mapping runs off the event loop after the emit
    const deliveries = await waitFor(async () => {
      const { rows } = await db.query(`SELECT event, payload FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at`, [hook.rows[0].id]);
      return rows.some(d => d.event === 'ota.rollout_paused') ? rows : null;
    });
    expect(deliveries.map(d => d.event)).toContain('ota.rollout_paused');
    expect(deliveries.find(d => d.event === 'ota.rollout_paused').payload.data).toMatchObject({ rollout_id: rid, fail_pct: 100, paused_reason: 'failures' });

    // resume clears the reason; the last device reports the version → completed with a notification
    const resumed = await request(app).post(`/api/ota/rollouts/${rid}/resume`).set(authHeader(adminA, a.id));
    expect(resumed.status).toBe(200);
    await db.query(`UPDATE devices SET firmware_version = '1.3.0' WHERE id = $1`, [devA3.id]);
    await otaSvc.__test.checkOtaStatus();
    const { rows: [r2] } = await db.query(`SELECT status, paused_reason, completed_at FROM ota_rollouts WHERE id = $1`, [rid]);
    expect(r2.status).toBe('completed');
    expect(r2.paused_reason).toBeNull();
    expect(r2.completed_at).toBeTruthy();
    expect(notified.at(-1)).toMatchObject({ event: 'completed', succeeded: 1, failed: 2, total: 3 });
    const detail = await request(app).get(`/api/ota/rollouts/${rid}`).set(authHeader(adminA, a.id));
    expect(detail.body.data.jobs.map(j => j.status).sort()).toEqual(['failed', 'failed', 'succeeded']);

    await db.query(`UPDATE devices SET online = true, firmware_version = '1.0.0' WHERE tenant_id = $1`, [a.id]);
    await db.query('DELETE FROM webhooks WHERE id = $1', [hook.rows[0].id]);
  });

  it('a rollout waits for the OTA window instead of failing devices', async () => {
    const fw = await createFirmware(a.id, { version: '1.4.0' });
    await db.query(`UPDATE devices SET online = true, last_state = NULL WHERE id = $1`, [devA1.id]);
    const cur = otaSvc.__test.localMinutes('Europe/Kyiv');
    await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: (cur + 120) % 1440, ota_window_to: (cur + 180) % 1440 });
    const res = await request(app).post('/api/ota/rollout').set(authHeader(adminA, a.id)).send({ firmware_id: fw.id, device_ids: [devA1.mqtt_device_id], batch_size: 5, batch_interval_s: 60 });
    expect(res.status).toBe(201);
    const { rows } = await db.query(`SELECT status, deferrals FROM ota_jobs WHERE rollout_id = $1`, [res.body.data.rollout_id]);
    expect(rows[0]).toEqual({ status: 'queued', deferrals: 0 });
    expect(sent).toHaveLength(0);
    await request(app).patch(`/api/tenants/${a.id}/settings`).set(authHeader(adminA, a.id)).send({ ota_window_from: null, ota_window_to: null });
    await otaSvc.__test.processRolloutBatch(res.body.data.rollout_id, 'lib-a');
    expect(sent).toHaveLength(1);
    await request(app).post(`/api/ota/rollouts/${res.body.data.rollout_id}/cancel`).set(authHeader(adminA, a.id));
    await db.query(`UPDATE ota_jobs SET status = 'cancelled', completed_at = now() WHERE rollout_id = $1 AND status = 'sent'`, [res.body.data.rollout_id]);
  });
});
