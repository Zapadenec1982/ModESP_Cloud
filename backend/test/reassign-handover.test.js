'use strict';

// globals: true in vitest.config.js
//
// What a device leaves behind when it changes organisation.
//
// Alarms, hints, OTA jobs and work orders are keyed by the controller's id, which
// follows it across organisations, and carry the tenant that owned it at the time.
// Reassignment moved only the devices row and the grants, so the previous owner's
// open rows stayed open — and could never close again, because the controller now
// publishes into another organisation's space and the message that would clear
// them never arrives there. An alarm raised the day before a handover counted in
// that organisation's dashboard for ever, and its technician kept a work order for
// a cabinet the company no longer owned.
//
// Nothing moves to the new owner: the contents are the previous organisation's.
// What changes is that the open rows are settled and the history stays put.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const mqttSvc = require('../src/services/mqtt');

const app = createTestApp();

afterAll(async () => { await shutdownDb(); });

describe('Reassignment settles what the previous organisation can no longer close (H8)', () => {
  let from, to, superadmin, device, other, firmware;
  let openAlarm, oldAlarm, openHint, closedHint, queuedJob, doneJob, openOrder, doneOrder, otherAlarm;

  const row = async (table, id) => (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await cleanDatabase();
    from = await createTenant({ slug: 'handover-from' });
    to   = await createTenant({ slug: 'handover-to' });
    superadmin = await createUser(from.id, { role: 'superadmin', email: 'super@handover.test' });

    device = await createDevice(from.id, { mqttId: 'HAND01', name: 'Бонета, що переїжджає' });
    other  = await createDevice(from.id, { mqttId: 'HAND02', name: 'Та, що лишається' });

    firmware = (await db.query(
      `INSERT INTO firmwares (tenant_id, version, filename, original_name, size_bytes, checksum)
       VALUES ($1, '1.0.0', 'f.bin', 'f.bin', 4, 'sha256:x') RETURNING id`, [from.id])).rows[0];

    const alarm = async (dev, active, code) => (await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, $2, $3, 'critical', $4, now() - interval '2 hours', $5) RETURNING id`,
      [from.id, dev, code, active, active ? null : new Date()])).rows[0];
    openAlarm  = await alarm('HAND01', true,  'high_temp_alarm');
    oldAlarm   = await alarm('HAND01', false, 'door_alarm');       // history — must not move
    otherAlarm = await alarm('HAND02', true,  'high_temp_alarm');  // a different cabinet

    const hint = async (dev, closed, key) => (await db.query(
      `INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, severity, value, threshold, window_hours, closed_at, closed_reason)
       VALUES ($1, $2, $3, 'warning', 1, 1, 24, $4, $5) RETURNING id`,
      [from.id, dev, key, closed ? new Date() : null, closed ? 'resolved' : null])).rows[0];
    openHint   = await hint('HAND01', false, 'short_cycle');
    closedHint = await hint('HAND01', true,  'continuous_run');

    const job = async (status) => (await db.query(
      `INSERT INTO ota_jobs (tenant_id, firmware_id, device_id, status) VALUES ($1, $2, 'HAND01', $3) RETURNING id`,
      [from.id, firmware.id, status])).rows[0];
    queuedJob = await job('queued');
    doneJob   = await job('succeeded');

    const order = async (status) => (await db.query(
      `INSERT INTO work_orders (tenant_id, device_id, device_mqtt_id, title, status)
       VALUES ($1, $2, 'HAND01', 'Замінити вентилятор', $3) RETURNING id`,
      [from.id, device.id, status])).rows[0];
    openOrder = await order('in_progress');
    doneOrder = await order('done');

    mqttSvc.sendCommand = () => {};
    mqttSvc.sendJsonCommand = () => {};
    mqttSvc.setPendingTenantHint = () => {};
  });

  afterAll(async () => { await cleanDatabase(); });

  it('closes the alarms, hints, OTA jobs and work orders the old owner had open', async () => {
    const res = await request(app)
      .post(`/api/devices/${device.id}/reassign`)
      .set(authHeader(superadmin, from.id))
      .send({ tenant_id: to.id });

    expect(res.status).toBe(200);
    expect(res.body.data.closed_for_old_tenant).toEqual({
      alarms: 1, hints: 1, ota_jobs: 1, work_orders: 1,
    });

    const a = await row('alarms', openAlarm.id);
    expect(a.active).toBe(false);
    expect(a.cleared_at).not.toBeNull();
    expect(a.tenant_id).toBe(from.id);           // it stays theirs — only its state changed

    const h = await row('maintenance_hints', openHint.id);
    expect(h.closed_at).not.toBeNull();
    expect(h.closed_reason).toBe('dismissed');

    expect((await row('ota_jobs', queuedJob.id)).status).toBe('cancelled');

    const o = await row('work_orders', openOrder.id);
    expect(o.status).toBe('cancelled');
    expect(o.closed_reason).toMatch(/іншу організацію/);
  });

  it('leaves the history alone — it belongs to the organisation that lived it', async () => {
    const a = await row('alarms', oldAlarm.id);
    expect(a.tenant_id).toBe(from.id);
    expect(a.active).toBe(false);

    const h = await row('maintenance_hints', closedHint.id);
    expect(h.closed_reason).toBe('resolved');    // not overwritten with 'dismissed'
    expect(h.tenant_id).toBe(from.id);

    expect((await row('ota_jobs', doneJob.id)).status).toBe('succeeded');
    expect((await row('work_orders', doneOrder.id)).status).toBe('done');
  });

  it('does not touch another cabinet of the same organisation', async () => {
    const a = await row('alarms', otherAlarm.id);
    expect(a.active).toBe(true);
    expect(a.cleared_at).toBeNull();
  });

  it('and the new owner starts clean — none of it followed the device', async () => {
    const admin = await createUser(to.id, { role: 'admin', email: 'admin@handover-to.test' });

    const alarms = await request(app).get('/api/alarms').set(authHeader(admin, to.id));
    expect(alarms.status).toBe(200);
    expect(alarms.body.data.filter(x => x.device_id === 'HAND01')).toEqual([]);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM maintenance_hints WHERE tenant_id = $1`, [to.id]);
    expect(rows[0].n).toBe(0);

    // The device itself did move, and its alarm counter starts at zero.
    const dev = await request(app).get('/api/devices/HAND01').set(authHeader(admin, to.id));
    expect(dev.status).toBe(200);
    expect(dev.body.data.alarms_open).toBe(0);
  });
});

// ── deleting the device the handover gave you ──────────────
//
// The handover above is only worth anything if the previous owner's history
// survives what the new owner does next. Deleting a device purged alarms,
// telemetry, events and OTA jobs by the controller id alone, with no tenant_id:
// the new owner's delete reached straight into the previous owner's HACCP
// evidence and erased it — the exact rows the handover had just been careful to
// leave in place. (The same missing column also costs the delete its index:
// telemetry is keyed (tenant_id, device_id, channel, time), so without the
// leading column the statement scans every monthly partition and, on a real
// fleet, dies on the 30 s timeout — the device then refuses to delete at all.)
describe('The new owner deleting a device leaves the previous owner\'s history alone (M6)', () => {
  let prev, next, prevAdmin, nextAdmin, dev;

  beforeAll(async () => {
    await cleanDatabase();
    prev = await createTenant({ slug: 'purge-prev' });
    next = await createTenant({ slug: 'purge-next' });
    prevAdmin = await createUser(prev.id, { role: 'admin', email: 'a@purge-prev.test' });
    nextAdmin = await createUser(next.id, { role: 'admin', email: 'a@purge-next.test' });

    // The controller now belongs to `next`; `prev` kept the history from before
    // the handover, exactly as the reassignment leaves it.
    dev = await createDevice(next.id, { mqttId: 'PURGE1', name: 'Камера після передачі' });

    for (const tenant of [prev, next]) {
      await db.query(
        `INSERT INTO telemetry (tenant_id, device_id, channel, value, time)
         VALUES ($1, 'PURGE1', 'air', 4.2, now() - interval '10 days')`, [tenant.id]);
      await db.query(
        `INSERT INTO events (tenant_id, device_id, event_type, time)
         VALUES ($1, 'PURGE1', 'compressor_on', now() - interval '10 days')`, [tenant.id]);
      await db.query(
        `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
         VALUES ($1, 'PURGE1', 'high_temp_alarm', 'critical', false, now() - interval '10 days', now() - interval '9 days')`,
        [tenant.id]);
    }

    mqttSvc.sendCommand = () => {};
    mqttSvc.sendJsonCommand = () => {};
    mqttSvc.setPendingTenantHint = () => {};
  });

  const count = async (table, tenantId) => (await db.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND device_id = 'PURGE1'`, [tenantId])).rows[0].n;

  it('purges its own rows and none of the previous owner\'s', async () => {
    const res = await request(app).delete(`/api/devices/${dev.id}`).set(authHeader(nextAdmin, next.id));
    expect(res.status).toBe(200);

    for (const table of ['telemetry', 'events', 'alarms']) {
      expect(await count(table, next.id)).toBe(0);
      expect(await count(table, prev.id)).toBe(1);
    }
  });

  it('leaves the previous owner still able to read its own history', async () => {
    const { rows } = await db.query(
      `SELECT channel, value FROM telemetry WHERE tenant_id = $1 AND device_id = 'PURGE1'`, [prev.id]);
    expect(rows).toEqual([{ channel: 'air', value: 4.2 }]);
    void prevAdmin;
  });
});
