'use strict';

// globals: true in vitest.config.js
//
// Retention and partition lifecycle: the three maintenance scripts the systemd
// timers run (ensure-partitions, cleanup-telemetry, cleanup-weather/aux) and the
// SECURITY DEFINER guards of migration 023 that stand between a misconfigured
// retention and the live month of telemetry.

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice } = require('./helpers/factories');

const ensurePartitions = require('../src/scripts/ensure-partitions');
const cleanupTelemetry = require('../scripts/cleanup-telemetry');
const cleanupWeather   = require('../scripts/cleanup-weather');
const cleanupAux       = require('../scripts/cleanup-aux');

const query = (sql, params) => db.query(sql, params);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const daysAhead = (n) => new Date(Date.now() + n * DAY);

function partitionName(date) {
  return `telemetry_${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function attachedPartitions() {
  const { rows } = await db.query(`
    SELECT inhrelid::regclass::text AS name
      FROM pg_inherits
     WHERE inhparent = 'telemetry'::regclass
     ORDER BY 1`);
  return rows.map(r => r.name);
}

async function dropPartitionIfExists(name) {
  await db.query(`DROP TABLE IF EXISTS ${name}`);
}

const now = new Date();
const CURRENT = partitionName(new Date(now.getFullYear(), now.getMonth(), 1));

beforeAll(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  // Leave the test DB the way the other suites expect it: only telemetry_default.
  for (const name of await attachedPartitions()) {
    if (name !== 'telemetry_default') await dropPartitionIfExists(name);
  }
  await shutdownDb();
});

describe('ensure-partitions.js', () => {
  it('creates the current month plus N months ahead and is idempotent', async () => {
    const ensured = await ensurePartitions.run({ query, now, monthsAhead: 6 });
    expect(ensured).toHaveLength(7);
    expect(ensured[0]).toBe(CURRENT);

    const attached = await attachedPartitions();
    for (const name of ensured) expect(attached).toContain(name);

    // Second run: nothing to create, nothing thrown.
    const again = await ensurePartitions.run({ query, now, monthsAhead: 6 });
    expect(again).toEqual(ensured);

    // Every partition carries the dedup index used by ON CONFLICT DO NOTHING.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = $1`,
      [`idx_${ensured[6]}_unique`]
    );
    expect(rows[0].n).toBe(1);
  });

  it('falls back to the default horizon on a bad PARTITION_MONTHS_AHEAD', async () => {
    const ensured = await ensurePartitions.run({ query, now, monthsAhead: 'nope' });
    expect(ensured).toHaveLength(ensurePartitions.DEFAULT_MONTHS_AHEAD + 1);
  });

  it('rejects an impossible month', async () => {
    await expect(db.query('SELECT create_telemetry_partition(2030, 13)'))
      .rejects.toThrow(/invalid year\/month/);
  });
});

describe('cleanup-telemetry.js', () => {
  beforeAll(async () => {
    await db.query('SELECT create_telemetry_partition(2021, 1)');
    await db.query('SELECT create_telemetry_partition(2021, 2)');
    await db.query('SELECT create_telemetry_partition($1, $2)', [now.getFullYear(), now.getMonth() + 1]);
  });

  it('dry run lists the old partitions and drops nothing', async () => {
    const r = await cleanupTelemetry.run({ query, now, retentionDays: 90 });
    expect(r.retentionDays).toBe(90);
    expect(r.drop).toEqual(expect.arrayContaining(['telemetry_2021_01', 'telemetry_2021_02']));
    expect(r.keep).toContain(CURRENT);
    expect(r.skipped).toContain('telemetry_default');
    expect(r.dropped).toEqual([]);

    const attached = await attachedPartitions();
    expect(attached).toContain('telemetry_2021_01');
  });

  it('--apply drops only the partitions past retention', async () => {
    const r = await cleanupTelemetry.run({ query, now, retentionDays: 90, apply: true });
    expect(r.dropped.sort()).toEqual(['telemetry_2021_01', 'telemetry_2021_02']);

    const attached = await attachedPartitions();
    expect(attached).not.toContain('telemetry_2021_01');
    expect(attached).not.toContain('telemetry_2021_02');
    expect(attached).toContain(CURRENT);
    expect(attached).toContain('telemetry_default');
  });

  it('a nonsensical TELEMETRY_RETENTION_DAYS falls back to the default', async () => {
    const r = await cleanupTelemetry.run({ query, now, retentionDays: '-5' });
    expect(r.retentionDays).toBe(cleanupTelemetry.DEFAULT_RETENTION_DAYS);
  });
});

describe('drop_telemetry_partition() guards (migration 023)', () => {
  it('refuses to drop the partition of the current month whatever the caller asks', async () => {
    await expect(db.query('SELECT drop_telemetry_partition($1)', [CURRENT]))
      .rejects.toThrow(/younger than 7 days/);
    expect(await attachedPartitions()).toContain(CURRENT);
  });

  it('refuses anything that is not a telemetry_YYYY_MM name', async () => {
    await expect(db.query('SELECT drop_telemetry_partition($1)', ['users']))
      .rejects.toThrow(/not a telemetry_YYYY_MM/);
    await expect(db.query('SELECT drop_telemetry_partition($1)', ['telemetry_default']))
      .rejects.toThrow(/not a telemetry_YYYY_MM/);
    await expect(db.query('SELECT drop_telemetry_partition($1)', ['telemetry_2021_13']))
      .rejects.toThrow(/invalid month/);
  });

  it('returns false for an old partition that is not attached (idempotent re-runs)', async () => {
    const { rows } = await db.query('SELECT drop_telemetry_partition($1) AS dropped', ['telemetry_2019_05']);
    expect(rows[0].dropped).toBe(false);
  });
});

describe('cleanup-weather.js', () => {
  let tenant, siteId;

  beforeAll(async () => {
    tenant = await createTenant();
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name) VALUES ($1, 'Retention site') RETURNING id`,
      [tenant.id]
    );
    siteId = rows[0].id;
    await db.query(
      `INSERT INTO weather_observations (site_id, tenant_id, observed_at, temp_c)
       VALUES ($1, $2, $3, 1.0), ($1, $2, $4, 2.0), ($1, $2, $5, 3.0)`,
      [siteId, tenant.id, daysAgo(400), daysAgo(396), daysAgo(10)]
    );
  });

  it('dry run counts, --apply deletes only observations past retention', async () => {
    const dry = await cleanupWeather.run({ query, now, retentionDays: 395 });
    expect(dry.candidates).toBe(2);
    expect(dry.deleted).toBe(0);

    const applied = await cleanupWeather.run({ query, now, retentionDays: 395, apply: true });
    expect(applied.deleted).toBe(2);

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM weather_observations WHERE site_id = $1', [siteId]);
    expect(rows[0].n).toBe(1);
  });
});

describe('cleanup-aux.js', () => {
  let tenant, user, device;

  beforeAll(async () => {
    tenant = await createTenant();
    user   = await createUser(tenant.id, { role: 'admin' });
    device = await createDevice(tenant.id);

    // events: one past the 365-day default, one recent
    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, time)
       VALUES ($1, $2, 'compressor_on', $3), ($1, $2, 'compressor_off', $4)`,
      [tenant.id, device.mqtt_device_id, daysAgo(400), daysAgo(3)]
    );
    // notification_log: one past 90 days, one recent
    await db.query(
      `INSERT INTO notification_log (tenant_id, channel, status, created_at)
       VALUES ($1, 'telegram', 'sent', $2), ($1, 'telegram', 'sent', $3)`,
      [tenant.id, daysAgo(100), daysAgo(1)]
    );
    // alarms: old cleared (sweep), old still ACTIVE (keep), recently cleared (keep)
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at) VALUES
         ($1, $2, 'HI_TEMP', 'critical', false, $3, $4),
         ($1, $2, 'DOOR',    'warning',  true,  $3, NULL),
         ($1, $2, 'LO_TEMP', 'warning',  false, $5, $6)`,
      [tenant.id, device.mqtt_device_id, daysAgo(410), daysAgo(400), daysAgo(6), daysAgo(5)]
    );
    // refresh_tokens: one expired, one valid
    await db.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, 'expired-hash', $3), ($1, $2, 'valid-hash', $4)`,
      [user.id, tenant.id, daysAgo(1), daysAhead(20)]
    );
  });

  it('dry run reports candidates per table and deletes nothing', async () => {
    const r = await cleanupAux.run({ query, now, env: {} });
    expect(r.events.candidates).toBe(1);
    expect(r.notification_log.candidates).toBe(1);
    expect(r.alarms.candidates).toBe(1);
    expect(r.refresh_tokens.candidates).toBe(1);
    expect(Object.values(r).every(x => x.deleted === 0)).toBe(true);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM alarms WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].n).toBe(3);
  });

  it('a retention of 0 disables that sweep only', async () => {
    const r = await cleanupAux.run({ query, now, env: { EVENT_RETENTION_DAYS: '0' } });
    expect(r.events.disabled).toBe(true);
    expect(r.events.candidates).toBe(0);
    expect(r.notification_log.disabled).toBe(false);
    expect(r.notification_log.candidates).toBe(1);
  });

  it('--apply removes exactly the expired rows and keeps active alarms', async () => {
    const r = await cleanupAux.run({ query, now, env: {}, apply: true });
    expect(r.events.deleted).toBe(1);
    expect(r.notification_log.deleted).toBe(1);
    expect(r.alarms.deleted).toBe(1);
    expect(r.refresh_tokens.deleted).toBe(1);

    const counts = {};
    for (const t of ['events', 'notification_log', 'alarms', 'refresh_tokens']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [tenant.id]);
      counts[t] = rows[0].n;
    }
    expect(counts).toEqual({ events: 1, notification_log: 1, alarms: 2, refresh_tokens: 1 });

    const { rows: alarms } = await db.query(
      'SELECT alarm_code, active FROM alarms WHERE tenant_id = $1 ORDER BY alarm_code', [tenant.id]);
    expect(alarms).toEqual([
      { alarm_code: 'DOOR', active: true },
      { alarm_code: 'LO_TEMP', active: false },
    ]);

    const { rows: tokens } = await db.query(
      'SELECT token_hash FROM refresh_tokens WHERE user_id = $1', [user.id]);
    expect(tokens.map(t => t.token_hash)).toEqual(['valid-hash']);
  });
});
