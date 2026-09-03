'use strict';

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');
const mqttService = require('../src/services/mqtt');

/**
 * Records everything the service logs so a swallowed flush failure is visible.
 * flushEvents() catches its own errors, so "did not throw" alone would pass even
 * when the whole batch was discarded — the empty error log is the real check.
 */
function recordingLogger() {
  const errors = [];
  const noop = () => {};
  return {
    errors,
    error: (...args) => errors.push(args),
    warn: noop, info: noop, debug: noop, trace: noop, fatal: noop,
  };
}

describe('MQTT event buffer', () => {
  const log = recordingLogger();
  let tenant, deviceA, deviceB;

  async function eventsFor(mqttDeviceId) {
    const { rows } = await db.query(
      `SELECT event_type, payload, time FROM events
        WHERE tenant_id = $1 AND device_id = $2
        ORDER BY time, event_type`,
      [tenant.id, mqttDeviceId]
    );
    return rows;
  }

  beforeAll(async () => {
    await cleanDatabase();
    // The logger seam: no MQTT broker, no start(), just an injected logger.
    mqttService.setLogger(log);
    tenant  = await createTenant({ slug: 'mqtt-events' });
    deviceA = await createDevice(tenant.id, { name: 'Freezer A', mqttId: 'EVTA01' });
    deviceB = await createDevice(tenant.id, { name: 'Freezer B', mqttId: 'EVTB02' });
  });

  beforeEach(() => {
    log.errors.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await mqttService.flushEvents();   // drain anything a failing test left buffered
    await db.query('DELETE FROM events');
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Duplicate handling ──

  it('inserts the rest of the batch when one event is a duplicate', async () => {
    // Two identical (tenant, device, event_type, time) tuples collide on
    // idx_events_dedup. Without ON CONFLICT the whole multi-row INSERT aborts
    // and every event in the batch is lost.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T04:00:00.000Z'));
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'compressor_on');
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'compressor_on');

    vi.setSystemTime(new Date('2026-08-23T04:00:30.000Z'));
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'compressor_off');

    vi.setSystemTime(new Date('2026-08-23T04:01:00.000Z'));
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'defrost_start');
    vi.useRealTimers();

    await expect(mqttService.flushEvents()).resolves.toBeUndefined();
    expect(log.errors).toEqual([]);

    const rows = await eventsFor(deviceA.mqtt_device_id);
    expect(rows.map(r => r.event_type)).toEqual([
      'compressor_on', 'compressor_off', 'defrost_start',
    ]);
  });

  it('keeps unrelated events in a batch that contains a duplicate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T04:10:00.000Z'));

    // Colliding pair on device A...
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'compressor_on');
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'compressor_on');
    // ...and bystanders stamped at the very same instant.
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'door_open');
    mqttService.insertEvent(tenant.id, deviceB.mqtt_device_id, 'door_open', { reason: 'delivery' });
    vi.useRealTimers();

    await mqttService.flushEvents();
    expect(log.errors).toEqual([]);

    expect((await eventsFor(deviceA.mqtt_device_id)).map(r => r.event_type))
      .toEqual(['compressor_on', 'door_open']);

    const bRows = await eventsFor(deviceB.mqtt_device_id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].event_type).toBe('door_open');
    expect(bRows[0].payload).toEqual({ reason: 'delivery' });
  });

  // ── Timestamps ──

  it('stamps each event when it is buffered, not when the batch is flushed', async () => {
    const anchor = Date.now();
    const opened = new Date(anchor - 10 * 60_000);
    const closed = new Date(anchor -  5 * 60_000);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(opened);
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'door_open');
    vi.setSystemTime(closed);
    // Same (tenant, device, event_type) as the first — under flush-time NOW()
    // both rows collided instead of recording two separate door openings.
    mqttService.insertEvent(tenant.id, deviceA.mqtt_device_id, 'door_open');
    vi.useRealTimers();

    const flushedAt = Date.now();
    await mqttService.flushEvents();
    expect(log.errors).toEqual([]);

    const rows = await eventsFor(deviceA.mqtt_device_id);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.time.getTime())).toEqual([opened.getTime(), closed.getTime()]);
    // Both predate the flush, so neither was stamped with NOW() at INSERT time.
    expect(rows[1].time.getTime()).toBeLessThan(flushedAt);
  });
});
