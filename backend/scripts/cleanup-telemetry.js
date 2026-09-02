#!/usr/bin/env node
'use strict';

/**
 * cleanup-telemetry.js — telemetry retention (plan epics 1.3 and 1.9)
 *
 * Runs daily from modesp-retention-cleanup.timer with --apply. Four steps:
 *
 *   1. downsample  — fold raw telemetry of the last DOWNSAMPLE_LOOKBACK_DAYS
 *                    (3) into telemetry_hourly (min/max/avg/samples per hour);
 *                    idempotent (ON CONFLICT DO UPDATE). --backfill-days N folds
 *                    N days once, e.g. after upgrading to migration 028.
 *   2. purge raw   — delete raw rows of every organisation older than its plan's
 *                    retention_days (plan_limits), in batches of 20 000 rows.
 *   3. partitions  — drop telemetry_YYYY_MM partitions whose end lies before
 *                    the longest retention of any plan in use (falls back to
 *                    TELEMETRY_RETENTION_DAYS, default 90) through
 *                    drop_telemetry_partition() — SECURITY DEFINER, refuses
 *                    anything younger than 7 days.
 *   4. purge hourly — delete telemetry_hourly older than HOURLY_RETENTION_DAYS
 *                    (1095: three years, the HACCP archive promise).
 *
 * Usage:
 *   node scripts/cleanup-telemetry.js                     # dry-run
 *   node scripts/cleanup-telemetry.js --apply             # do it
 *   node scripts/cleanup-telemetry.js --apply --backfill-days 400
 *
 * Safe to run repeatedly.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEFAULT_RETENTION_DAYS   = 90;
const HOURLY_RETENTION_DAYS    = parseInt(process.env.HOURLY_RETENTION_DAYS, 10) || 1095;
const DOWNSAMPLE_LOOKBACK_DAYS = parseInt(process.env.DOWNSAMPLE_LOOKBACK_DAYS, 10) || 3;
const PARTITION_RE = /^telemetry_(\d{4})_(\d{2})$/;
const BATCH_SIZE   = 20000;

function parseRetention(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Fold raw telemetry into telemetry_hourly for [now - lookbackDays, start of current hour).
 * @returns {Promise<{from:Date, to:Date, upserted:number}>}
 */
async function downsampleHourly({ query, now = new Date(), lookbackDays = DOWNSAMPLE_LOOKBACK_DAYS, log = () => {} }) {
  const to = new Date(now); to.setUTCMinutes(0, 0, 0);
  const from = new Date(to.getTime() - lookbackDays * 86400 * 1000);
  const res = await query(
    `INSERT INTO telemetry_hourly (tenant_id, device_id, channel, hour, min, max, avg, samples)
     SELECT tenant_id, device_id, channel, date_trunc('hour', time), MIN(value), MAX(value), AVG(value), COUNT(*)::int
       FROM telemetry
      WHERE time >= $1 AND time < $2
      GROUP BY tenant_id, device_id, channel, date_trunc('hour', time)
     ON CONFLICT (tenant_id, device_id, channel, hour) DO UPDATE
       SET min = EXCLUDED.min, max = EXCLUDED.max, avg = EXCLUDED.avg, samples = EXCLUDED.samples`,
    [from, to]
  );
  log(`Downsample: ${res.rowCount} hourly row(s) upserted for ${from.toISOString()} … ${to.toISOString()}`);
  return { from, to, upserted: res.rowCount };
}

/**
 * Per-organisation raw retention from plan_limits.retention_days.
 * @returns {Promise<Array<{tenant_id:string, slug:string, retention_days:number, cutoff:Date, candidates:number, deleted:number}>>}
 */
async function purgeRaw({ query, apply = false, now = new Date(), defaultRetentionDays, log = () => {} }) {
  const fallback = parseRetention(defaultRetentionDays ?? process.env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const { rows: tenants } = await query(
    `SELECT t.id AS tenant_id, t.slug, COALESCE(s.raw_retention_days, p.retention_days, $1) AS retention_days
       FROM tenants t
       LEFT JOIN plan_limits p ON p.plan = t.plan
       LEFT JOIN tenant_settings s ON s.tenant_id = t.id
      ORDER BY t.slug`,
    [fallback]
  );
  const report = [];
  for (const t of tenants) {
    const cutoff = new Date(now.getTime() - t.retention_days * 86400 * 1000);
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM telemetry WHERE tenant_id = $1 AND time < $2', [t.tenant_id, cutoff]);
    const entry = { ...t, cutoff, candidates: rows[0].n, deleted: 0 };
    report.push(entry);
    if (entry.candidates === 0) continue;
    log(`${t.slug}: ${entry.candidates} raw row(s) older than ${t.retention_days} days (${cutoff.toISOString().slice(0, 10)})`);
    if (!apply) continue;
    for (;;) {
      const res = await query(
        `DELETE FROM telemetry WHERE ctid IN (
           SELECT ctid FROM telemetry WHERE tenant_id = $1 AND time < $2 LIMIT ${BATCH_SIZE})`,
        [t.tenant_id, cutoff]
      );
      if (res.rowCount === 0) break;
      entry.deleted += res.rowCount;
      log(`  ${t.slug}: deleted ${entry.deleted}/${entry.candidates}`);
    }
  }
  return report;
}

/** Longest retention any organisation is entitled to (plan or override) — partitions may not be dropped before it. */
async function maxRetentionDays({ query, fallback }) {
  const { rows } = await query(
    `SELECT GREATEST(MAX(p.retention_days), MAX(s.raw_retention_days))::int AS days
       FROM tenants t
       JOIN plan_limits p ON p.plan = t.plan
       LEFT JOIN tenant_settings s ON s.tenant_id = t.id
      WHERE t.plan <> 'system'`);
  const days = rows[0] && rows[0].days;
  return Math.max(days || 0, fallback);
}

/**
 * Drop whole partitions past retention. Kept API-compatible with the original
 * script: `retentionDays` is the (fallback) horizon; when omitted the longest
 * plan retention in use is taken.
 */
async function run({ query, apply = false, now = new Date(), retentionDays, log = () => {} }) {
  const fallback = parseRetention(retentionDays ?? process.env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const days = retentionDays !== undefined ? fallback : await maxRetentionDays({ query, fallback });
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  log(`Partition retention: ${days} days (cutoff ${cutoff.toISOString().slice(0, 10)})`);
  const { rows } = await query(`
    SELECT inhrelid::regclass::text AS partition_name
      FROM pg_inherits
     WHERE inhparent = 'telemetry'::regclass
     ORDER BY inhrelid::regclass::text
  `);
  const result = { retentionDays: days, cutoff, keep: [], drop: [], dropped: [], skipped: [] };
  for (const { partition_name } of rows) {
    const match = partition_name.match(PARTITION_RE);
    if (!match) { result.skipped.push(partition_name); continue; }
    const year = parseInt(match[1], 10), month = parseInt(match[2], 10);
    const partitionEnd = new Date(year, month, 1);
    if (partitionEnd >= cutoff) { result.keep.push(partition_name); log(`  KEEP ${partition_name}`); continue; }
    result.drop.push(partition_name);
    log(`  DROP ${partition_name} (ends ${partitionEnd.toISOString().slice(0, 10)})`);
    if (!apply) continue;
    const res = await query('SELECT drop_telemetry_partition($1) AS dropped', [partition_name]);
    if (res.rows[0].dropped) { result.dropped.push(partition_name); log('    ✓ Dropped'); }
    else log('    – Already gone');
  }
  return result;
}

async function purgeHourly({ query, apply = false, now = new Date(), retentionDays = HOURLY_RETENTION_DAYS, log = () => {} }) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400 * 1000);
  const { rows } = await query('SELECT count(*)::int AS n FROM telemetry_hourly WHERE hour < $1', [cutoff]);
  const result = { retentionDays, cutoff, candidates: rows[0].n, deleted: 0 };
  log(`Hourly archive: ${result.candidates} row(s) older than ${retentionDays} days`);
  if (!apply || result.candidates === 0) return result;
  for (;;) {
    const res = await query(
      `DELETE FROM telemetry_hourly WHERE ctid IN (SELECT ctid FROM telemetry_hourly WHERE hour < $1 LIMIT ${BATCH_SIZE})`, [cutoff]);
    if (res.rowCount === 0) break;
    result.deleted += res.rowCount;
  }
  return result;
}

async function main() {
  const { Pool } = require('pg');
  const apply = process.argv.includes('--apply');
  const bfIdx = process.argv.indexOf('--backfill-days');
  const backfillDays = bfIdx >= 0 ? parseInt(process.argv[bfIdx + 1], 10) : null;
  if (!apply) console.log('=== DRY RUN === (use --apply to execute)\n');

  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });
  const query = (sql, params) => pool.query(sql, params);
  const log = console.log;

  try {
    if (apply) {
      await downsampleHourly({ query, lookbackDays: backfillDays || DOWNSAMPLE_LOOKBACK_DAYS, log });
    } else {
      log(`Downsample: would fold the last ${backfillDays || DOWNSAMPLE_LOOKBACK_DAYS} day(s) into telemetry_hourly`);
    }
    const raw = await purgeRaw({ query, apply, log });
    const parts = await run({ query, apply, log });
    const hourly = await purgeHourly({ query, apply, log });
    const rawTotal = raw.reduce((s, r) => s + (apply ? r.deleted : r.candidates), 0);
    console.log(apply
      ? `\nDone. Raw rows deleted: ${rawTotal}; partitions dropped: ${parts.dropped.length}; hourly rows deleted: ${hourly.deleted}.`
      : `\n=== DRY RUN COMPLETE === raw rows: ${rawTotal}; partitions: ${parts.drop.length}; hourly rows: ${hourly.candidates}. Run with --apply to execute.`);
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

module.exports = { run, downsampleHourly, purgeRaw, purgeHourly, DEFAULT_RETENTION_DAYS, HOURLY_RETENTION_DAYS };
