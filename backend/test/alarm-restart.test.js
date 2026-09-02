'use strict';

// globals: true in vitest.config.js
//
// Restart safety for nuisance-delayed alarms (door, pulldown). The message
// handlers are driven directly — no broker — through mqtt.__test, and the
// nuisance delay is a fake timer. Fake timers are limited to setTimeout so
// node-postgres I/O keeps flowing.

const pino = require('pino');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');
const mqttSvc = require('../src/services/mqtt');

const T = mqttSvc.__test;
const SLUG = 'restart-test';
const DEV  = 'RST001';
const KEY  = 'protection.door_alarm';
const DOOR_DELAY = T.NUISANCE_DELAY.door_alarm;

async function activeAlarms(code) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM alarms WHERE device_id = $1 AND alarm_code = $2 AND active = true',
    [DEV, code]
  );
  return rows[0].n;
}

/** Yield to the event loop until cond() holds (I/O completes between iterations). */
async function waitFor(cond, iterations = 200) {
  for (let i = 0; i < iterations; i++) {
    if (await cond()) return true;
    await new Promise(r => setImmediate(r));
  }
  return false;
}

afterAll(async () => {
  await shutdownDb();
});

/** Simulate the next process: empty state map, rehydrate from DB, re-arm timers. */
async function restart() {
  T.reset();
  await T.bootstrapStateMap();
  return T.rearmPendingAlarms();
}

describe('nuisance alarms across a backend restart', () => {
  let tenant;

  beforeAll(async () => {
    await cleanDatabase();
    T.setLogger(pino({ level: 'silent' }));
    tenant = await createTenant({ slug: SLUG });
    await createDevice(tenant.id, { mqttId: DEV });
    await mqttSvc.refreshRegistries();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    T.reset();
    await db.query('DELETE FROM alarms WHERE device_id = $1', [DEV]);
    await db.query('UPDATE devices SET last_state = NULL WHERE mqtt_device_id = $1', [DEV]);
  });

  afterEach(() => {
    T.reset();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('a door open at shutdown is persisted and its timer re-armed on the next start', async () => {
    // First process: door closes, then opens → nuisance timer pending, no row yet
    await T.handleStateKey(SLUG, DEV, KEY, 'false', false);
    await T.handleStateKey(SLUG, DEV, KEY, 'true', false);
    expect(T.pendingAlarms.has(`${DEV}:door_alarm`)).toBe(true);
    expect(await activeAlarms('door_alarm')).toBe(0);

    // Shutdown: the state is flushed regardless of the debounce window, timers dropped
    await mqttSvc.shutdown();
    const { rows } = await db.query('SELECT last_state FROM devices WHERE mqtt_device_id = $1', [DEV]);
    expect(rows[0].last_state[KEY]).toBe(true);
    expect(T.pendingAlarms.size).toBe(0);

    // Next process: rehydrated state says the door is open → timer re-armed
    const armed = await restart();
    expect(armed).toBe(1);
    expect(T.stateMap.get(DEV)[KEY]).toBe(true);
    expect(T.pendingAlarms.has(`${DEV}:door_alarm`)).toBe(true);

    // The device keeps reporting true: not a transition, must not arm a second timer
    await T.handleStateKey(SLUG, DEV, KEY, 'true', false);
    expect(T.pendingAlarms.size).toBe(1);

    // Delay elapses → exactly one alarm raised
    await vi.advanceTimersByTimeAsync(DOOR_DELAY + 10);
    expect(await waitFor(async () => (await activeAlarms('door_alarm')) === 1)).toBe(true);
    expect(T.pendingAlarms.size).toBe(0);
  });

  it('does not re-arm when an active alarm row already exists', async () => {
    await db.query(
      `UPDATE devices SET last_state = $2::jsonb WHERE mqtt_device_id = $1`,
      [DEV, JSON.stringify({ [KEY]: true })]
    );
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active)
       VALUES ($1, $2, 'door_alarm', 'warning', true)`,
      [tenant.id, DEV]
    );

    const armed = await restart();
    expect(armed).toBe(0);
    expect(T.pendingAlarms.size).toBe(0);
    expect(await activeAlarms('door_alarm')).toBe(1);
  });

  it('a door closed before the re-armed delay elapses stays a transient (no alarm)', async () => {
    await db.query(
      `UPDATE devices SET last_state = $2::jsonb WHERE mqtt_device_id = $1`,
      [DEV, JSON.stringify({ [KEY]: true })]
    );
    expect(await restart()).toBe(1);

    await T.handleStateKey(SLUG, DEV, KEY, 'false', false);
    expect(T.pendingAlarms.size).toBe(0);

    await vi.advanceTimersByTimeAsync(DOOR_DELAY + 10);
    await waitFor(async () => false, 20);
    expect(await activeAlarms('door_alarm')).toBe(0);
  });

  it('keys without a nuisance delay are never re-armed or re-raised', async () => {
    await db.query(
      `UPDATE devices SET last_state = $2::jsonb WHERE mqtt_device_id = $1`,
      [DEV, JSON.stringify({ 'protection.high_temp_alarm': true })]
    );
    expect(await restart()).toBe(0);
    expect(await activeAlarms('high_temp_alarm')).toBe(0);
  });
});

describe('stateWriter(force) — shutdown flush inside the debounce window', () => {
  const SLUG2 = 'restart-flush';
  const DEV2  = 'RST002';

  beforeAll(async () => {
    const t = await createTenant({ slug: SLUG2 });
    await createDevice(t.id, { mqttId: DEV2 });
    await mqttSvc.refreshRegistries();
  });

  afterAll(() => T.reset());

  async function lastTemp() {
    const { rows } = await db.query('SELECT last_state FROM devices WHERE mqtt_device_id = $1', [DEV2]);
    return rows[0].last_state ? rows[0].last_state['equipment.air_temp'] : undefined;
  }

  it('a plain stateWriter() holds a fresh change back, a forced one writes it', async () => {
    T.reset();
    await T.handleStateKey(SLUG2, DEV2, 'equipment.air_temp', '-18.5', false);
    await T.stateWriter();                         // first write: nothing to debounce against
    expect(await lastTemp()).toBe(-18.5);

    await T.handleStateKey(SLUG2, DEV2, 'equipment.air_temp', '-12.0', false);
    await T.stateWriter();                         // inside STATE_DEBOUNCE → held
    expect(await lastTemp()).toBe(-18.5);
    expect(T.stateMap.get(DEV2)._dirty).toBe(true);

    await T.stateWriter(true);                     // what shutdown() does
    expect(await lastTemp()).toBe(-12.0);
    expect(T.stateMap.get(DEV2)._dirty).toBe(false);
  });
});
