'use strict';

/**
 * GET /api/devices fields the dashboard's «Потребують уваги» block and the cards
 * read (audit item 1): the open alarm codes, when the product went out of its
 * temperature range, and the live operating mode.
 */

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();
const mqttSvc = require('../src/services/mqtt');

describe('GET /api/devices — attention fields', () => {
  let tenant, other, admin, prevState, prevMeta;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'attention' });
    other  = await createTenant({ slug: 'attention-other' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@attention.test' });
    await createDevice(tenant.id, { mqttId: 'ATT001', name: 'Бонета' });
    await createDevice(tenant.id, { mqttId: 'ATT002', name: 'Вітрина' });
    await createDevice(tenant.id, { mqttId: 'ATT003', name: 'Камера' });

    prevState = mqttSvc.getDeviceState;
    prevMeta  = mqttSvc.getDeviceMeta;
    mqttSvc.getDeviceState = (id) => ({
      // publishes both mode keys, compressor as a number the way a 0/1 firmware does
      ATT001: { 'equipment.air_temp': -12.4, 'equipment.compressor': 1, 'defrost.active': false },
      // older firmware: no mode keys at all
      ATT002: { 'equipment.air_temp': 3.1 },
    }[id] || null);
    mqttSvc.getDeviceMeta = (id) => (id === 'ATT001' || id === 'ATT002' ? { online: true, lastSeen: Date.now() } : null);
  });

  afterAll(async () => {
    mqttSvc.getDeviceState = prevState;
    mqttSvc.getDeviceMeta  = prevMeta;
    await cleanDatabase();
    await shutdownDb();
  });

  const byId = async () => {
    const res = await request(app).get('/api/devices').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.data.map(d => [d.mqtt_device_id, d]));
  };

  it('a device with nothing open reports an empty code list and null everywhere', async () => {
    const d = (await byId()).ATT003;
    expect(d.alarms_open).toBe(0);
    expect(d.alarm_codes).toEqual([]);
    expect(d.temp_alarm_since).toBeNull();
    expect(d.compressor).toBeNull();
    expect(d.defrost).toBeNull();
    expect(d.air_temp).toBeNull();
  });

  it('operating mode comes from live state, null when the key was never published', async () => {
    const all = await byId();
    expect(all.ATT001.compressor).toBe(true);
    expect(all.ATT001.defrost).toBe(false);
    expect(all.ATT002.compressor).toBeNull();
    expect(all.ATT002.defrost).toBeNull();
  });

  it('alarm_codes lists each open code once, oldest first; cleared rows do not count', async () => {
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at) VALUES
         ($1, 'ATT001', 'door_alarm',      'warning',  true,  now() - interval '30 minutes'),
         ($1, 'ATT001', 'high_temp_alarm', 'critical', true,  now() - interval '20 minutes'),
         ($1, 'ATT001', 'high_temp_alarm', 'critical', true,  now() - interval '5 minutes'),
         ($1, 'ATT001', 'low_temp_alarm',  'critical', false, now() - interval '3 hours')`,
      [tenant.id]);
    const d = (await byId()).ATT001;
    expect(d.alarms_open).toBe(3);
    expect(d.alarm_codes).toEqual(['door_alarm', 'high_temp_alarm']);
  });

  it('temp_alarm_since is the oldest open temperature alarm, not the door alarm', async () => {
    const d = (await byId()).ATT001;
    expect(d.temp_alarm_since).not.toBeNull();
    const ageMin = (Date.now() - new Date(d.temp_alarm_since).getTime()) / 60000;
    // the 20-minute high_temp_alarm, not the 30-minute door alarm nor the 5-minute repeat
    expect(ageMin).toBeGreaterThan(19);
    expect(ageMin).toBeLessThan(21);
  });

  it('a door alarm alone leaves temp_alarm_since null', async () => {
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'ATT002', 'door_alarm', 'warning', true, now() - interval '10 minutes')`,
      [tenant.id]);
    const d = (await byId()).ATT002;
    expect(d.alarms_open).toBe(1);
    expect(d.alarm_codes).toEqual(['door_alarm']);
    expect(d.temp_alarm_since).toBeNull();
  });

  it('clearing the temperature alarms empties temp_alarm_since and drops the code', async () => {
    await db.query(
      `UPDATE alarms SET active = false, cleared_at = now() WHERE tenant_id = $1 AND device_id = 'ATT001' AND alarm_code = 'high_temp_alarm'`,
      [tenant.id]);
    const d = (await byId()).ATT001;
    expect(d.alarms_open).toBe(1);
    expect(d.alarm_codes).toEqual(['door_alarm']);
    expect(d.temp_alarm_since).toBeNull();
  });

  // Alarm rows are keyed by mqtt id and survive a move to another organisation;
  // the aggregate joins on the tenant leg so the previous owner's rows stay theirs.
  it('another organisation\'s alarm rows under the same controller id do not leak', async () => {
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at)
       VALUES ($1, 'ATT003', 'low_temp_alarm', 'critical', true, now() - interval '1 hour')`,
      [other.id]);
    const d = (await byId()).ATT003;
    expect(d.alarms_open).toBe(0);
    expect(d.alarm_codes).toEqual([]);
    expect(d.temp_alarm_since).toBeNull();
  });
});
