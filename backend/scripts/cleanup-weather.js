#!/usr/bin/env node
'use strict';

/**
 * cleanup-weather.js
 *
 * Deletes weather_observations older than a configurable retention period
 * (WEATHER_RETENTION_DAYS, default 395 — a year plus a month, so year-over-year
 * comparison on the telemetry chart still works).
 *
 * weather_observations is a plain table, not partitioned: one row per site per
 * hour is ~8.8k rows/site/year, which does not justify partition management.
 * The delete is therefore batched so it never holds a long transaction.
 *
 * Usage:
 *   node scripts/cleanup-weather.js            # dry-run (shows what would go)
 *   node scripts/cleanup-weather.js --apply    # actually delete
 *
 * Production: modesp-retention-cleanup.timer (daily, 03:30) runs this with
 * --apply, followed by cleanup-aux.js. Safe to run repeatedly.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEFAULT_RETENTION_DAYS = 395;
const BATCH_SIZE = 10000;

function parseRetention(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {object} opts
 * @param {(sql: string, params?: any[]) => Promise<{rows:any[], rowCount:number}>} opts.query
 * @param {boolean} [opts.apply=false]
 * @param {Date}    [opts.now=new Date()]
 * @param {number}  [opts.retentionDays]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{retentionDays:number, cutoff:Date, candidates:number, deleted:number}>}
 */
async function run({ query, apply = false, now = new Date(), retentionDays, log = () => {} }) {
  const days = parseRetention(retentionDays ?? process.env.WEATHER_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  log(`Retention: ${days} days`);
  log(`Cutoff: ${cutoff.toISOString()}`);

  // idx_weather_obs_time covers this scan — the PK leads with site_id.
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM weather_observations WHERE observed_at < $1',
    [cutoff]
  );
  const candidates = rows[0].n;
  log(`Observations older than the cutoff: ${candidates}\n`);

  const result = { retentionDays: days, cutoff, candidates, deleted: 0 };
  if (!apply || candidates === 0) return result;

  for (;;) {
    const res = await query(
      `DELETE FROM weather_observations
        WHERE ctid IN (
          SELECT ctid FROM weather_observations
           WHERE observed_at < $1
           LIMIT ${BATCH_SIZE}
        )`,
      [cutoff]
    );
    if (res.rowCount === 0) break;
    result.deleted += res.rowCount;
    log(`  deleted ${result.deleted}/${candidates}`);
  }
  return result;
}

async function main() {
  const { Pool } = require('pg');
  const apply = process.argv.includes('--apply');
  if (!apply) console.log('=== DRY RUN === (use --apply to execute)\n');

  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });

  try {
    const r = await run({ query: (sql, params) => pool.query(sql, params), apply, log: console.log });
    if (apply) {
      console.log(`\nDone. Deleted ${r.deleted} observation(s).`);
    } else {
      console.log(`=== DRY RUN COMPLETE === ${r.candidates} observation(s) would be deleted. Run with --apply to execute.`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { run, DEFAULT_RETENTION_DAYS };
