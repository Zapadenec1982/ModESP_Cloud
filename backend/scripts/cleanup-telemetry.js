#!/usr/bin/env node
'use strict';

/**
 * cleanup-telemetry.js
 *
 * Drops telemetry partitions older than a configurable retention period (default 90 days).
 * Without retention, 5000 devices × 6 channels × 5 min = ~3 billion rows/year (~315 GB).
 *
 * The script lists existing telemetry_YYYY_MM partitions and drops those whose
 * end-date is older than the retention threshold.
 *
 * Usage:
 *   node scripts/cleanup-telemetry.js           # dry-run (shows what would be dropped)
 *   node scripts/cleanup-telemetry.js --apply    # actually drop partitions
 *
 * Cron (1st of every month, 03:00):
 *   0 3 1 * * node /opt/modesp-cloud/backend/scripts/cleanup-telemetry.js --apply
 *
 * Safe to run multiple times. DROP IF EXISTS is idempotent.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

const RETENTION_DAYS = parseInt(process.env.TELEMETRY_RETENTION_DAYS, 10) || 90;

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
  console.log(`Cutoff date: ${cutoff.toISOString().slice(0, 10)}`);
  console.log(`Partitions whose end-date is before cutoff will be dropped.\n`);

  // List all child partitions of the telemetry table
  const { rows } = await pool.query(`
    SELECT inhrelid::regclass::text AS partition_name
    FROM pg_inherits
    WHERE inhparent = 'telemetry'::regclass
    ORDER BY inhrelid::regclass::text
  `);

  console.log(`Found ${rows.length} telemetry partition(s)\n`);

  let dropped = 0;

  for (const { partition_name } of rows) {
    // Extract year and month from partition name: telemetry_YYYY_MM
    const match = partition_name.match(/telemetry_(\d{4})_(\d{2})/);
    if (!match) {
      console.log(`  Skipping ${partition_name} (unexpected name format)`);
      continue;
    }

    const year  = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    // Partition covers [YYYY-MM-01, YYYY-(MM+1)-01)
    // Drop if the END of the partition range is before cutoff
    const partitionEnd = new Date(year, month, 1); // first day of next month

    if (partitionEnd < cutoff) {
      console.log(`  DROP ${partition_name} (covers ${year}-${String(month).padStart(2, '0')}, ends ${partitionEnd.toISOString().slice(0, 10)})`);

      if (!dryRun) {
        // DETACH first (non-blocking in PG 14+), then DROP
        try {
          await pool.query(`ALTER TABLE telemetry DETACH PARTITION ${partition_name}`);
          await pool.query(`DROP TABLE IF EXISTS ${partition_name}`);
          dropped++;
          console.log(`    ✓ Dropped`);
        } catch (err) {
          console.error(`    ✗ Failed: ${err.message}`);
        }
      }
    } else {
      console.log(`  KEEP ${partition_name} (covers ${year}-${String(month).padStart(2, '0')}, ends ${partitionEnd.toISOString().slice(0, 10)})`);
    }
  }

  if (dryRun) {
    console.log('\n=== DRY RUN COMPLETE === Run with --apply to execute');
  } else {
    console.log(`\nDone. Dropped ${dropped} partition(s).`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
