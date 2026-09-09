'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

afterAll(async () => { await shutdownDb(); });

// What the word "alarm" counts.
//
// The dashboard used to count devices whose controller had raised its own
// aggregate protection.alarm_active flag, while the Alarms page listed rows of
// the alarms table. The two answer different questions and drifted apart: an open
// door lifts the controller's flag at once, but the platform waits out the
// nuisance delay before recording anything, and records nothing at all if the
// door closes first. GET /devices now carries alarms_open so every surface that
// says "alarm" counts the same rows.
describe('Devices list: alarms_open counts records, not the controller flag', () => {
  let tenant, other, admin, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'alarm-count' });
    other  = await createTenant({ slug: 'alarm-count-old' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@alarmcount.test' });
    device = await createDevice(tenant.id, { mqttId: 'ACNT01', name: 'Вітрина' });
  });

  afterAll(async () => { await cleanDatabase(); });

  const listed = async () => {
    const res = await request(app).get('/api/devices').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    return res.body.data.find(d => d.mqtt_device_id === 'ACNT01');
  };

  it('is zero while the platform has recorded nothing', async () => {
    expect((await listed()).alarms_open).toBe(0);
  });

  it('counts an open record and stops counting once it is cleared', async () => {
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'ACNT01', 'high_temp_alarm', 'critical', true, now()) RETURNING id`, [tenant.id]);
    expect((await listed()).alarms_open).toBe(1);

    await db.query('UPDATE alarms SET active = false, cleared_at = now() WHERE id = $1', [rows[0].id]);
    expect((await listed()).alarms_open).toBe(0);
  });

  it('ignores an alarm left behind by the organisation the device used to belong to', async () => {
    // The row is keyed by mqtt_device_id, which is unique platform-wide, so it
    // survives a move between organisations. Without the tenant leg of the join
    // the new owner would inherit the previous owner's counter forever.
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'ACNT01', 'low_temp_alarm', 'critical', true, now())`, [other.id]);
    expect((await listed()).alarms_open).toBe(0);
  });
});

// The same question asked of the single-device card, the site card and the map.
// The device page raised its red "АВАРІЯ" badge off the controller's live flag
// while its own Аварії tab read "Алармів не зафіксовано" — the badge and the tab
// were reading two different sources. Both now read the alarms table.
describe('Device detail and site detail count the same records', () => {
  const mqttSvc = require('../src/services/mqtt');
  let tenant, admin, site, device, alarmId, prevState;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'alarm-detail' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@alarmdetail.test' });

    const siteRes = await db.query(
      `INSERT INTO sites (tenant_id, name, address_line) VALUES ($1, 'Склад №1', 'вул. Холодна, 1') RETURNING id`,
      [tenant.id]);
    site = siteRes.rows[0];

    device = await createDevice(tenant.id, { mqttId: 'ADET01', name: 'Бонета морозильна' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, device.id]);

    // The controller holds its aggregate flag up — an open door does that long
    // before the 10-minute nuisance delay decides whether it is an alarm.
    prevState = mqttSvc.getDeviceState;
    mqttSvc.getDeviceState = (id) => (id === 'ADET01'
      ? { 'protection.alarm_active': true, 'equipment.door_open': true, 'equipment.air_temp': -18.2 }
      : null);
  });

  afterAll(async () => {
    mqttSvc.getDeviceState = prevState;
    await cleanDatabase();
  });

  const detail = async () => {
    const res = await request(app).get('/api/devices/ADET01').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const siteCard = async () => {
    const res = await request(app).get(`/api/sites/${site.id}`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it('a raised controller flag with nothing recorded is not an alarm', async () => {
    const d = await detail();
    expect(d.alarms_open).toBe(0);
    // The flag itself still reaches the page inside last_state — it is a state
    // readout the parameters tab shows, just not a count of alarms.
    expect(d.last_state['protection.alarm_active']).toBe(true);

    const s = await siteCard();
    expect(s.alarm_count).toBe(0);
    expect(s.devices.find(x => x.mqtt_device_id === 'ADET01').alarm_active).toBe(false);
  });

  it('a recorded alarm counts on both, and stops counting when cleared', async () => {
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'ADET01', 'high_temp_alarm', 'critical', true, now()) RETURNING id`, [tenant.id]);
    alarmId = rows[0].id;

    expect((await detail()).alarms_open).toBe(1);
    expect((await siteCard()).alarm_count).toBe(1);

    await db.query('UPDATE alarms SET active = false, cleared_at = now() WHERE id = $1', [alarmId]);
    expect((await detail()).alarms_open).toBe(0);
    expect((await siteCard()).alarm_count).toBe(0);
  });
});
