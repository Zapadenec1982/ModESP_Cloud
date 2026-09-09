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

afterAll(async () => { await shutdownDb(); });

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

// The way a fridge actually goes down.
//
// Losing power or the link kills the MQTT session, and the broker publishes the
// device's will on .../status. That path wrote the event and stopped there: it
// never started the clock the alarm counts down, and the detector skipped the
// device in both passes — the first because it is already offline, the second
// because there was no _offlineSince. So the commonest outage of all produced no
// alarm, while the rarer one (session alive, data stopped) did. Both now do.
describe('device_offline alarm after the broker publishes the will', () => {
  const WDEV = 'OFFW01';
  let tenant;

  beforeAll(async () => {
    await cleanDatabase();
    T.setLogger(pino({ level: 'silent' }));
    tenant = await createTenant({ slug: SLUG });
    await createDevice(tenant.id, { mqttId: WDEV });
    await mqttSvc.refreshRegistries();
  });

  afterAll(async () => {
    T.reset();
    vi.useRealTimers();
    await cleanDatabase();
  });

  const willAlarms = async () => {
    const { rows } = await db.query(
      `SELECT id, active FROM alarms WHERE device_id = $1 AND alarm_code = 'device_offline' ORDER BY id`, [WDEV]);
    return rows;
  };

  it('raises after the delay and closes when the device comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    T.reset();

    await T.handleStateKey(SLUG, WDEV, 'equipment.air_temp', '-18', false);
    expect(T.stateMap.get(WDEV)._online).toBe(true);

    // Power cut: the broker publishes the will. No detector pass in between —
    // this is the only thing the platform hears.
    T.handleStatus(SLUG, WDEV, 'offline', false);
    expect(T.stateMap.get(WDEV)._online).toBe(false);
    expect(T.stateMap.get(WDEV)._offlineSince).toBe(t0);
    expect(await willAlarms()).toHaveLength(0);       // the delay has not run out

    vi.setSystemTime(t0 + T.OFFLINE_ALARM_DELAY + 1000);
    await T.offlineDetector();
    const raised = await willAlarms();
    expect(raised).toHaveLength(1);
    expect(raised[0].active).toBe(true);

    await T.offlineDetector();
    expect(await willAlarms()).toHaveLength(1);       // no duplicate

    T.handleStatus(SLUG, WDEV, 'online', false);
    expect(T.stateMap.get(WDEV)._offlineSince).toBe(0);
    expect(await waitFor(async () => (await willAlarms())[0].active === false)).toBe(true);
  });

  it('a will arriving after the detector already noticed does not restart the clock', async () => {
    // The real sequence when a point loses power: the data stops, the detector
    // notices at the threshold, and only when the broker's keepalive runs out —
    // a good while later — does the will land. Taking the later moment would push
    // the deadline back every time and delay the alarm by that much.
    T.reset();
    const t0 = Date.now();
    await T.handleStateKey(SLUG, WDEV, 'equipment.air_temp', '-18', false);

    vi.setSystemTime(t0 + 100_000);                 // past OFFLINE_THRESHOLD (90 s)
    await T.offlineDetector();
    const since = T.stateMap.get(WDEV)._offlineSince;
    expect(since).toBe(t0 + 100_000);

    vi.setSystemTime(t0 + 160_000);
    T.handleStatus(SLUG, WDEV, 'offline', false);
    expect(T.stateMap.get(WDEV)._offlineSince).toBe(since);
  });
});
