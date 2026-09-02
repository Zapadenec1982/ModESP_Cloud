'use strict';

// globals: true in vitest.config.js
//
// Offline as an alarm (plan epic 1.6): the offline detector marks a silent
// device offline, and OFFLINE_ALARM_DELAY later raises a device_offline alarm
// row; the first message from the device closes it.

const pino = require('pino');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');
const mqttSvc = require('../src/services/mqtt');

const T = mqttSvc.__test;
const SLUG = 'offline-test';
const DEV  = 'OFF001';

async function waitFor(cond, iterations = 200) {
  for (let i = 0; i < iterations; i++) {
    if (await cond()) return true;
    await new Promise(r => setImmediate(r));
  }
  return false;
}

async function offlineAlarms() {
  const { rows } = await db.query(
    `SELECT id, active FROM alarms WHERE device_id = $1 AND alarm_code = 'device_offline' ORDER BY id`, [DEV]);
  return rows;
}

describe('device_offline alarm', () => {
  let tenant;
  const events = [];

  beforeAll(async () => {
    await cleanDatabase();
    T.setLogger(pino({ level: 'silent' }));
    tenant = await createTenant({ slug: SLUG });
    await createDevice(tenant.id, { mqttId: DEV });
    await mqttSvc.refreshRegistries();
    mqttSvc.on('alarm', (e) => events.push(e));
  });

  afterAll(async () => {
    T.reset();
    vi.useRealTimers();
    await cleanDatabase();
    await shutdownDb();
  });

  it('is raised after the delay, carries the alarm id, and clears on the next message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    T.reset();

    // Device was heard from at t0, then falls silent
    await T.handleStateKey(SLUG, DEV, 'equipment.air_temp', '-18', false);
    expect(T.stateMap.get(DEV)._online).toBe(true);

    vi.setSystemTime(t0 + 100_000);                  // past OFFLINE_THRESHOLD (90 s)
    await T.offlineDetector();
    expect(T.stateMap.get(DEV)._online).toBe(false);
    expect(await offlineAlarms()).toHaveLength(0);   // marked offline, not yet an alarm

    vi.setSystemTime(t0 + 100_000 + T.OFFLINE_ALARM_DELAY + 1000);
    await T.offlineDetector();
    const raised = await offlineAlarms();
    expect(raised).toHaveLength(1);
    expect(raised[0].active).toBe(true);
    const evt = events.find(e => e.alarmCode === 'device_offline' && e.active);
    expect(evt).toMatchObject({ tenantSlug: SLUG, deviceId: DEV, alarmId: raised[0].id, severity: 'warning' });

    // Detector runs again: no duplicate row
    await T.offlineDetector();
    expect(await offlineAlarms()).toHaveLength(1);

    // The device speaks again → alarm closed, clear event with the same id
    await T.handleStateKey(SLUG, DEV, 'equipment.air_temp', '-17.5', false);
    expect(await waitFor(async () => (await offlineAlarms())[0].active === false)).toBe(true);
    expect(await waitFor(async () => events.some(e => e.alarmCode === 'device_offline' && e.active === false && e.alarmId === raised[0].id))).toBe(true);
  });

  it('never alarms for a device that is still pending', async () => {
    T.reset();
    const t0 = Date.now();
    T.stateMap.set('PND001', { _tenantId: db.SYSTEM_TENANT_ID, _tenantSlug: 'pending', _lastSeen: t0, _online: true, _dirty: false, _lastDbWrite: 0 });
    vi.setSystemTime(t0 + 100_000);
    await T.offlineDetector();
    vi.setSystemTime(t0 + 100_000 + T.OFFLINE_ALARM_DELAY + 1000);
    await T.offlineDetector();
    const { rows } = await db.query(`SELECT 1 FROM alarms WHERE device_id = 'PND001'`);
    expect(rows).toHaveLength(0);
  });
});
