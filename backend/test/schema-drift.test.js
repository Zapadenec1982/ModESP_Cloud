'use strict';

// globals: true in vitest.config.js
//
// Migration 049 and the drift it closes.
//
// A production database is created from whatever schema.sql said on its install
// day and carried forward by migrations. Five unique indexes were written
// straight into schema.sql with no migration behind them, so a fresh install has
// them and every database in the field does not. Both back an
// `ON CONFLICT DO NOTHING` written without a conflict target, which means the
// absence throws nothing — it just stops deduplicating.
//
// These tests recreate that state (drop the index, insert the duplicates a
// retrying controller would produce) and run the migration against it.

const fs   = require('fs');
const path = require('path');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createDevice } = require('./helpers/factories');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../src/db/migrations/049_restore_missing_unique_indexes.sql'), 'utf8');

const indexExists = async (name) => {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'`, [name]);
  return rows.length === 1;
};

afterAll(async () => { await shutdownDb(); });

describe('Migration 049: unique indexes that existed only in schema.sql', () => {
  let tenant;
  const DEV = 'DRIFT01';

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'schema-drift' });
    await createDevice(tenant.id, { mqttId: DEV });
  });

  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS telemetry_2019_11');
    await cleanDatabase();
  });

  it('dedupes events and rebuilds the index a field database never got', async () => {
    await db.query('DROP INDEX IF EXISTS idx_events_dedup');
    expect(await indexExists('idx_events_dedup')).toBe(false);

    // What a controller re-sending its buffer looks like without the index:
    // the same event over and over, plus one that is genuinely different.
    const t = '2026-05-01T10:00:00Z';
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO events (tenant_id, device_id, event_type, payload, time)
         VALUES ($1, $2, 'compressor_on', $3, $4) ON CONFLICT DO NOTHING`,
        [tenant.id, DEV, JSON.stringify({ attempt: i }), t]);
    }
    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, time)
       VALUES ($1, $2, 'compressor_off', $3) ON CONFLICT DO NOTHING`,
      [tenant.id, DEV, '2026-05-01T10:05:00Z']);

    const before = await db.query('SELECT id, payload FROM events WHERE device_id = $1 ORDER BY id', [DEV]);
    expect(before.rows).toHaveLength(4);          // three of them the same event
    const firstId = before.rows[0].id;

    await db.query(MIGRATION);

    const after = await db.query('SELECT id, event_type, payload FROM events WHERE device_id = $1 ORDER BY id', [DEV]);
    expect(after.rows).toHaveLength(2);
    expect(after.rows.map(r => r.event_type)).toEqual(['compressor_on', 'compressor_off']);
    // The first row seen is the one kept, so the payload is the original.
    expect(after.rows[0].id).toBe(firstId);
    expect(after.rows[0].payload).toEqual({ attempt: 0 });
    expect(await indexExists('idx_events_dedup')).toBe(true);

    // And now the ON CONFLICT the code has always written actually bites.
    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, time)
       VALUES ($1, $2, 'compressor_on', $3) ON CONFLICT DO NOTHING`, [tenant.id, DEV, t]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM events WHERE device_id = $1', [DEV]);
    expect(rows[0].n).toBe(2);
  });

  it('gives every attached telemetry partition the unique index, not only the four named in schema.sql', async () => {
    // A partition as a field database carries it: created before the function
    // built the index, or by hand.
    await db.query(`CREATE TABLE telemetry_2019_11 PARTITION OF telemetry
                    FOR VALUES FROM ('2019-11-01') TO ('2019-12-01')`);
    expect(await indexExists('idx_telemetry_2019_11_unique')).toBe(false);

    const t = '2019-11-15T08:00:00Z';
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
         VALUES ($1, $2, $3, 'air', $4) ON CONFLICT DO NOTHING`,
        [t, tenant.id, DEV, -18 - i]);
    }
    const before = await db.query(`SELECT count(*)::int AS n FROM telemetry_2019_11`);
    expect(before.rows[0].n).toBe(3);            // no index, so nothing deduped

    await db.query(MIGRATION);

    const after = await db.query(`SELECT count(*)::int AS n, min(value) AS v FROM telemetry_2019_11`);
    expect(after.rows[0].n).toBe(1);
    expect(Number(after.rows[0].v)).toBe(-18);   // the first row survives
    expect(await indexExists('idx_telemetry_2019_11_unique')).toBe(true);

    await db.query(
      `INSERT INTO telemetry (time, tenant_id, device_id, channel, value)
       VALUES ($1, $2, $3, 'air', -30) ON CONFLICT DO NOTHING`, [t, tenant.id, DEV]);
    const dedup = await db.query(`SELECT count(*)::int AS n FROM telemetry_2019_11`);
    expect(dedup.rows[0].n).toBe(1);
  });

  it('runs again on an already-migrated database without touching anything', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM events');
    await db.query(MIGRATION);
    await db.query(MIGRATION);
    const after = await db.query('SELECT count(*)::int AS n FROM events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await indexExists('idx_events_dedup')).toBe(true);
    expect(await indexExists('idx_telemetry_2019_11_unique')).toBe(true);
  });
});
