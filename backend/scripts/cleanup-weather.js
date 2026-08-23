#!/usr/bin/env node
'use strict';

/**
 * cleanup-weather.js
 *
 * Deletes weather_observations older than a configurable retention period
 * (default 395 days — a year plus a month, so year-over-year comparison on the
 * telemetry chart still works).
 *
 * weather_observations is a plain table, not partitioned: one row per site per
 * hour is ~8.8k rows/site/year, which does not justify partition management.
 * The delete is therefore batched so it never holds a long transaction.
 *
 * Usage:
 *   node scripts/cleanup-weather.js            # dry-run (shows what would go)
 *   node scripts/cleanup-weather.js --apply    # actually delete
 *
 * Cron (1st of every month, 03:30 — half an hour after cleanup-telemetry.js):
 *   30 3 1 * * node /opt/modesp-cloud/backend/scripts/cleanup-weather.js --apply
 *
 * Safe to run multiple times.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

const RETENTION_DAYS = parseInt(process.env.WEATHER_RETENTION_DAYS, 10) || 395;
const BATCH_SIZE     = 10000;

const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'modesp_cloud',
  user:     process.env.DB_USER || 'modesp_cloud',
  password: process.env.DB_PASS || '',
});

async function main() {
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('=== DRY RUN === (use --apply to execute)\n');
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  console.log(`Retention: ${RETENTION_DAYS} days`);
  console.log(`Cutoff: ${cutoff.toISOString()}`);

  // idx_weather_obs_time covers this scan — the PK leads with site_id.
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM weather_observations WHERE observed_at < $1',
    [cutoff]
  );
  const total = rows[0].n;
  console.log(`Observations older than the cutoff: ${total}\n`);

  if (dryRun || total === 0) {
    console.log(dryRun ? '=== DRY RUN COMPLETE === Run with --apply to execute'
                       : 'Nothing to delete.');
    await pool.end();
    return;
  }

  let deleted = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM weather_observations
        WHERE ctid IN (
          SELECT ctid FROM weather_observations
           WHERE observed_at < $1
           LIMIT ${BATCH_SIZE}
        )`,
      [cutoff]
    );
    if (res.rowCount === 0) break;
    deleted += res.rowCount;
    console.log(`  deleted ${deleted}/${total}`);
  }

  console.log(`\nDone. Deleted ${deleted} observation(s).`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
