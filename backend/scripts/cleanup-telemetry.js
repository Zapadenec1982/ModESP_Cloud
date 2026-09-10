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
 *                    Then the hours a controller filled by catching up after an
 *                    outage (telemetry_dirty_hours, migration 050), whatever
 *                    their age — the window alone would let them expire out of
 *                    raw telemetry without ever reaching the archive.
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
// Shared with services/haccp-report.js, which prints this number to the inspector:
// the sweep and the document must never disagree about how long the archive lives.
const { HOURLY_RETENTION_DAYS } = require('../src/lib/platform-defaults');
const DOWNSAMPLE_LOOKBACK_DAYS = parseInt(process.env.DOWNSAMPLE_LOOKBACK_DAYS, 10) || 3;

// Raw retention is split by what the channel is for.
//
// air and defrost answer the inspector: the HACCP journal charts air against the
// critical limit, and it needs defrost to know which peaks are a defrost cycle
// rather than a product excursion (services/haccp-report.js fetchRaw reads both).
// Delete defrost early and a report over an older period starts flagging every
// defrost peak as an excursion — a false claim in a compliance document.
//
// The other four are read by exactly one thing, the technician's service report,
// where they matter for the weeks around a fault, not for years. At a 5-minute
// step they are two thirds of every row written.
//
// Anything else a future firmware sends keeps the full plan retention: losing
// data costs more than keeping it.
const ENGINEERING_CHANNELS = ['evap', 'cond', 'setpoint', 'comp'];
const DEFAULT_ENGINEERING_RETENTION_DAYS = 30;
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

// One pass takes DIRTY_HOUR_BATCH hours; DIRTY_HOUR_MAX_BATCHES caps a single
// nightly run so a fleet coming back from a long outage cannot hold the other
// three steps hostage. Oldest hours go first — those are the ones closest to
// being deleted by raw retention.
const DIRTY_HOUR_BATCH       = 2000;
const DIRTY_HOUR_MAX_BATCHES = 500;

/**
 * Fold the hours a backfill filled, whatever their age.
 *
 * The window pass above only reaches back DOWNSAMPLE_LOOKBACK_DAYS. A controller
 * returning from an outage sends up to 90 days at once, and everything older than
 * the window used to wait in `telemetry` for the plan's raw retention to delete it,
 * never reaching the archive — a break in the record over exactly the stretch the
 * equipment ran on its own.
 *
 * Each row is folded and then deleted, so a run that dies leaves the hour queued
 * for the next one. An hour whose raw rows retention already took folds to nothing
 * and is dropped all the same: there is nothing left to save, and keeping the
 * marker would only make the queue grow forever.
 *
 * @returns {Promise<{hours:number, upserted:number, remaining:number}>}
 */
async function downsampleDirtyHours({ query, log = () => {} }) {
  let hours = 0, upserted = 0, batches = 0;
  for (; batches < DIRTY_HOUR_MAX_BATCHES; batches++) {
    const { rows } = await query(
      `SELECT tenant_id, device_id, hour FROM telemetry_dirty_hours
        ORDER BY hour LIMIT ${DIRTY_HOUR_BATCH}`);
    if (rows.length === 0) break;

    const tenants = rows.map(r => r.tenant_id);
    const devices = rows.map(r => r.device_id);
    const marks   = rows.map(r => r.hour);

    const res = await query(
      `INSERT INTO telemetry_hourly (tenant_id, device_id, channel, hour, min, max, avg, samples)
       SELECT t.tenant_id, t.device_id, t.channel, date_trunc('hour', t.time),
              MIN(t.value), MAX(t.value), AVG(t.value), COUNT(*)::int
         FROM telemetry t
         JOIN unnest($1::uuid[], $2::varchar[], $3::timestamptz[]) AS d(tenant_id, device_id, hour)
           ON d.tenant_id = t.tenant_id AND d.device_id = t.device_id
          AND t.time >= d.hour AND t.time < d.hour + interval '1 hour'
        GROUP BY t.tenant_id, t.device_id, t.channel, date_trunc('hour', t.time)
       ON CONFLICT (tenant_id, device_id, channel, hour) DO UPDATE
         SET min = EXCLUDED.min, max = EXCLUDED.max, avg = EXCLUDED.avg, samples = EXCLUDED.samples`,
      [tenants, devices, marks]);
    upserted += res.rowCount;

    await query(
      `DELETE FROM telemetry_dirty_hours d
        USING unnest($1::uuid[], $2::varchar[], $3::timestamptz[]) AS q(tenant_id, device_id, hour)
        WHERE d.tenant_id = q.tenant_id AND d.device_id = q.device_id AND d.hour = q.hour`,
      [tenants, devices, marks]);
    hours += rows.length;
  }

  const { rows: left } = await query('SELECT count(*)::int AS n FROM telemetry_dirty_hours');
  const remaining = left[0].n;
  if (hours > 0 || remaining > 0) {
    log(`Backfilled hours: ${hours} folded into ${upserted} hourly row(s)`
      + (remaining > 0 ? `, ${remaining} left for the next run` : ''));
  }
  return { hours, upserted, remaining };
}

/**
 * Per-organisation raw retention from plan_limits.retention_days.
 * @returns {Promise<Array<{tenant_id:string, slug:string, retention_days:number, cutoff:Date, candidates:number, deleted:number}>>}
 */
async function purgeRaw({ query, apply = false, now = new Date(), defaultRetentionDays, engineeringRetentionDays, log = () => {} }) {
  const fallback = parseRetention(defaultRetentionDays ?? process.env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const engFallback = parseRetention(
    engineeringRetentionDays ?? process.env.RAW_ENGINEERING_RETENTION_DAYS, DEFAULT_ENGINEERING_RETENTION_DAYS);
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
    // Never keep an engineering channel longer than the plan keeps anything.
    const engDays = Math.min(engFallback, t.retention_days);
    const engCutoff = new Date(now.getTime() - engDays * 86400 * 1000);

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM telemetry WHERE tenant_id = $1 AND time < $2', [t.tenant_id, cutoff]);
    // Counted between the two cutoffs: what pass one below leaves behind.
    const { rows: engRows } = await query(
      `SELECT count(*)::int AS n FROM telemetry
        WHERE tenant_id = $1 AND time >= $2 AND time < $3 AND channel = ANY($4)`,
      [t.tenant_id, cutoff, engCutoff, ENGINEERING_CHANNELS]);

    const entry = { ...t, cutoff, candidates: rows[0].n, deleted: 0,
                    engineering_retention_days: engDays, engineering_cutoff: engCutoff,
                    engineering_candidates: engRows[0].n, engineering_deleted: 0 };
    report.push(entry);

    if (entry.engineering_candidates > 0) {
      log(`${t.slug}: ${entry.engineering_candidates} engineering row(s) older than ${engDays} days (${engCutoff.toISOString().slice(0, 10)})`);
      if (apply) {
        for (;;) {
          const res = await query(
            `DELETE FROM telemetry WHERE (tableoid, ctid) IN (
               SELECT tableoid, ctid FROM telemetry
                WHERE tenant_id = $1 AND time >= $2 AND time < $3 AND channel = ANY($4) LIMIT ${BATCH_SIZE})`,
            [t.tenant_id, cutoff, engCutoff, ENGINEERING_CHANNELS]);
          if (res.rowCount === 0) break;
          entry.engineering_deleted += res.rowCount;
        }
      }
    }

    if (entry.candidates === 0) continue;
    log(`${t.slug}: ${entry.candidates} raw row(s) older than ${t.retention_days} days (${cutoff.toISOString().slice(0, 10)})`);
    if (!apply) continue;
    for (;;) {
      // (tableoid, ctid), not ctid alone: telemetry is partitioned by month and a
      // ctid is unique only inside one partition, so a bare `ctid IN (...)` also
      // matches rows at the same physical address in every other partition — i.e.
      // it deletes live measurements of other organisations.
      const res = await query(
        `DELETE FROM telemetry WHERE (tableoid, ctid) IN (
           SELECT tableoid, ctid FROM telemetry WHERE tenant_id = $1 AND time < $2 LIMIT ${BATCH_SIZE})`,
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
      `DELETE FROM telemetry_hourly WHERE (tableoid, ctid) IN (
         SELECT tableoid, ctid FROM telemetry_hourly WHERE hour < $1 LIMIT ${BATCH_SIZE})`, [cutoff]);
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
    // Both folds run before any purge: an hour still has to have its raw rows.
    if (apply) {
      await downsampleHourly({ query, lookbackDays: backfillDays || DOWNSAMPLE_LOOKBACK_DAYS, log });
      await downsampleDirtyHours({ query, log });
    } else {
      log(`Downsample: would fold the last ${backfillDays || DOWNSAMPLE_LOOKBACK_DAYS} day(s) into telemetry_hourly`);
      const { rows } = await query('SELECT count(*)::int AS n FROM telemetry_dirty_hours');
      log(`Backfilled hours: ${rows[0].n} queued by controllers catching up, would be folded whatever their age`);
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

module.exports = { run, downsampleHourly, downsampleDirtyHours, purgeRaw, purgeHourly,
  DEFAULT_RETENTION_DAYS, HOURLY_RETENTION_DAYS, DEFAULT_ENGINEERING_RETENTION_DAYS, ENGINEERING_CHANNELS };
