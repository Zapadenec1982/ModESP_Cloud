#!/usr/bin/env node
'use strict';

/**
 * cleanup-telemetry.js
 *
 * Drops telemetry partitions older than a configurable retention period
 * (TELEMETRY_RETENTION_DAYS, default 90). Without retention, 5000 devices ×
 * 6 channels × 5 min = ~3 billion rows/year (~315 GB).
 *
 * The script lists the telemetry_YYYY_MM partitions and drops those whose
 * end-date is older than the retention threshold through
 * drop_telemetry_partition() (migration 023): a SECURITY DEFINER function, so
 * the script runs with the ordinary DB_USER credentials from backend/.env and
 * the function itself refuses to drop anything younger than 7 days.
 *
 * Usage:
 *   node scripts/cleanup-telemetry.js           # dry-run (shows what would be dropped)
 *   node scripts/cleanup-telemetry.js --apply    # actually drop partitions
 *
 * Production: modesp-telemetry-cleanup.timer (1st of every month, 03:00) runs
 * this with --apply. Safe to run repeatedly.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEFAULT_RETENTION_DAYS = 90;
const PARTITION_RE = /^telemetry_(\d{4})_(\d{2})$/;

function parseRetention(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * List partitions, decide which are past retention, drop them when apply=true.
 *
 * @param {object} opts
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} opts.query
 * @param {boolean} [opts.apply=false]
 * @param {Date}    [opts.now=new Date()]
 * @param {number}  [opts.retentionDays]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{retentionDays:number, cutoff:Date, keep:string[], drop:string[], dropped:string[], skipped:string[]}>}
 */
async function run({ query, apply = false, now = new Date(), retentionDays, log = () => {} }) {
  const days = parseRetention(retentionDays ?? process.env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  log(`Retention: ${days} days`);
  log(`Cutoff date: ${cutoff.toISOString().slice(0, 10)}`);
  log('Partitions whose end-date is before the cutoff will be dropped.\n');

  const { rows } = await query(`
    SELECT inhrelid::regclass::text AS partition_name
      FROM pg_inherits
     WHERE inhparent = 'telemetry'::regclass
     ORDER BY inhrelid::regclass::text
  `);
  log(`Found ${rows.length} telemetry partition(s)\n`);

  const result = { retentionDays: days, cutoff, keep: [], drop: [], dropped: [], skipped: [] };

  for (const { partition_name } of rows) {
    const match = partition_name.match(PARTITION_RE);
    if (!match) {
      result.skipped.push(partition_name);
      log(`  SKIP ${partition_name} (not a monthly partition)`);
      continue;
    }
    const year  = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    // Partition covers [YYYY-MM-01, YYYY-(MM+1)-01); compare its END with the cutoff.
    const partitionEnd = new Date(year, month, 1);
    const label = `${year}-${String(month).padStart(2, '0')}`;

    if (partitionEnd >= cutoff) {
      result.keep.push(partition_name);
      log(`  KEEP ${partition_name} (covers ${label})`);
      continue;
    }

    result.drop.push(partition_name);
    log(`  DROP ${partition_name} (covers ${label}, ends ${partitionEnd.toISOString().slice(0, 10)})`);
    if (!apply) continue;

    try {
      const res = await query('SELECT drop_telemetry_partition($1) AS dropped', [partition_name]);
      if (res.rows[0].dropped) {
        result.dropped.push(partition_name);
        log('    ✓ Dropped');
      } else {
        log('    – Already gone');
      }
    } catch (err) {
      log(`    ✗ Failed: ${err.message}`);
      throw err;
    }
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
      console.log(`\nDone. Dropped ${r.dropped.length} partition(s), kept ${r.keep.length}.`);
    } else {
      console.log(`\n=== DRY RUN COMPLETE === ${r.drop.length} partition(s) would be dropped. Run with --apply to execute.`);
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
