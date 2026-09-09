'use strict';

// globals: true in vitest.config.js
//
// A controller that lost its link buffers readings and sends up to 90 days of them
// when it comes back. The nightly fold into telemetry_hourly only covered
// DOWNSAMPLE_LOOKBACK_DAYS — three days — so everything older landed in raw
// telemetry, waited out the plan's retention and was deleted without ever reaching
// the archive. The hole fell exactly over the stretch the equipment ran on its
// own, which is the stretch an inspector asks about, and once retention had passed
// there was nothing left to rebuild it from.
//
// Migration 050 records the hours a backfill filled; the fold takes that table as
// well as its window.

const pino = require('pino');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');
const mqttSvc = require('../src/services/mqtt');
const cleanupTelemetry = require('../scripts/cleanup-telemetry');

const T = mqttSvc.__test;
const query = (sql, params) => db.query(sql, params);
const DAY = 24 * 60 * 60 * 1000;
const SLUG = 'backfill-archive';
const DEV = 'BFA001';

// The device's own payload shape: r = readings, t = unix seconds, values ×10.
const reading = (date, air) => ({ t: Math.floor(date.getTime() / 1000), a: Math.round(air * 10) });

const dirtyHours = async () => (await db.query(
  'SELECT count(*)::int AS n FROM telemetry_dirty_hours')).rows[0].n;
const rawCount = async (channel = null) => (await db.query(
  'SELECT count(*)::int AS n FROM telemetry WHERE device_id = $1' + (channel ? ' AND channel = $2' : ''),
  channel ? [DEV, channel] : [DEV])).rows[0].n;
const archived = async (channel = 'air') => (await db.query(
  `SELECT hour, samples, min, max FROM telemetry_hourly
    WHERE device_id = $1 AND channel = $2 ORDER BY hour`, [DEV, channel])).rows;

// handleBackfill fires the insert and the hour-marking without awaiting either — a
// controller must never wait on the database. So the test waits on the result
// rather than on a fixed number of ticks, which raced.
async function waitFor(cond, iterations = 400) {
  for (let i = 0; i < iterations; i++) {
    if (await cond()) return true;
    await new Promise(r => setImmediate(r));
  }
  return false;
}
// Marking follows the insert, so waiting on the marker implies the rows are in.
const landed = async (rawRows, hours) => {
  expect(await waitFor(async () => await dirtyHours() === hours)).toBe(true);
  expect(await rawCount()).toBe(rawRows);
};

describe('Hours a controller backfills reach the hourly archive', () => {
  let tenant;

  beforeAll(async () => {
    await cleanDatabase();
    T.setLogger(pino({ level: 'silent' }));
    tenant = await createTenant({ slug: SLUG, plan: 'free' });   // 30 days raw retention
    await createDevice(tenant.id, { mqttId: DEV, name: 'Автономна бонета' });
    await mqttSvc.refreshRegistries();
  });

  afterAll(async () => {
    T.reset();
    await cleanDatabase();
    await shutdownDb();
  });

  it('folds an outage 60 days back that the three-day window never reaches', async () => {
    // Two hours of readings from an outage two months ago, six samples an hour.
    const base = new Date(Date.now() - 60 * DAY);
    base.setUTCMinutes(0, 0, 0);
    const records = [];
    for (let h = 0; h < 2; h++) {
      for (let i = 0; i < 6; i++) {
        records.push(reading(new Date(base.getTime() + h * 3600_000 + i * 600_000), -18 - i * 0.1));
      }
    }
    T.handleBackfill(SLUG, DEV, JSON.stringify({ v: 1, r: records }));
    await landed(12, 2);                         // both hours queued for the fold

    // The window alone is blind to them — this is the whole defect.
    await cleanupTelemetry.downsampleHourly({ query, lookbackDays: 3 });
    expect(await archived()).toHaveLength(0);

    const res = await cleanupTelemetry.downsampleDirtyHours({ query });
    expect(res.hours).toBe(2);
    const rows = await archived();
    expect(rows).toHaveLength(2);
    expect(rows[0].samples).toBe(6);
    expect(Number(rows[0].max)).toBeCloseTo(-18, 5);
    expect(Number(rows[0].min)).toBeCloseTo(-18.5, 5);
    expect(await dirtyHours()).toBe(0);          // folded, so the queue is empty again
  });

  it('survives the retention that used to delete the only copy', async () => {
    // The free plan keeps 30 days of raw. Those rows are 60 days old, so the very
    // next purge takes them — and before this fix that was the end of the record.
    const applied = await cleanupTelemetry.purgeRaw({ query, apply: true });
    expect(applied.find(r => r.tenant_id === tenant.id).deleted).toBe(12);
    expect(await rawCount()).toBe(0);

    expect(await archived()).toHaveLength(2);    // the archive still has the outage
  });

  it('folds comp and defrost rebuilt from backfilled events', async () => {
    const at = new Date(Date.now() - 45 * DAY);
    at.setUTCMinutes(0, 0, 0);
    const sec = (offset) => Math.floor((at.getTime() + offset) / 1000);
    T.handleBackfillEvents(SLUG, DEV, JSON.stringify({ v: 1, e: [
      { t: sec(0),       ty: 1 },   // compressor_on
      { t: sec(600_000), ty: 2 },   // compressor_off
      { t: sec(900_000), ty: 3 },   // defrost_start
    ] }));
    await landed(3, 1);

    await cleanupTelemetry.downsampleDirtyHours({ query });
    expect(await archived('comp')).toHaveLength(1);
    expect(await archived('defrost')).toHaveLength(1);
    expect(await dirtyHours()).toBe(0);
  });

  it('drops a marker whose raw rows are already gone instead of queueing it forever', async () => {
    const lost = new Date(Date.now() - 300 * DAY);
    lost.setUTCMinutes(0, 0, 0);
    await db.query(
      'INSERT INTO telemetry_dirty_hours (tenant_id, device_id, hour) VALUES ($1, $2, $3)',
      [tenant.id, DEV, lost]);

    const res = await cleanupTelemetry.downsampleDirtyHours({ query });
    expect(res.hours).toBe(1);
    expect(res.upserted).toBe(0);                // nothing left to fold
    expect(res.remaining).toBe(0);               // and the marker does not linger
  });

  it('re-folding an hour keeps one archive row and updates it', async () => {
    const at = new Date(Date.now() - 20 * DAY);
    at.setUTCMinutes(0, 0, 0);
    const hourly = () => db.query(
      `SELECT samples, max FROM telemetry_hourly WHERE device_id = $1 AND hour = $2 AND channel = 'air'`,
      [DEV, at]);

    // Wait on the marker, not on the row: marking follows the insert, so a wait
    // that stops at the row can beat it to the fold.
    T.handleBackfill(SLUG, DEV, JSON.stringify({ v: 1, r: [reading(at, -19)] }));
    expect(await waitFor(async () => await dirtyHours() === 1)).toBe(true);
    expect(await rawCount('air')).toBe(1);
    await cleanupTelemetry.downsampleDirtyHours({ query });
    expect((await hourly()).rows).toEqual([{ samples: 1, max: -19 }]);

    // The controller sends the rest of that hour on a second pass.
    T.handleBackfill(SLUG, DEV, JSON.stringify({ v: 1, r: [reading(new Date(at.getTime() + 600_000), -15)] }));
    expect(await waitFor(async () => await dirtyHours() === 1)).toBe(true);
    expect(await rawCount('air')).toBe(2);
    await cleanupTelemetry.downsampleDirtyHours({ query });

    expect((await hourly()).rows).toEqual([{ samples: 2, max: -15 }]);
  });
});
