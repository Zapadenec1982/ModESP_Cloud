#!/usr/bin/env node
'use strict';

/**
 * cleanup-aux.js
 *
 * Row retention for the tables that are neither partitioned (telemetry) nor
 * handled by cleanup-weather.js. Each sweep deletes in batches of 10 000 rows
 * so it never holds a long transaction on a live table.
 *
 *   table            column      env variable                      default
 *   events           time        EVENT_RETENTION_DAYS              365
 *   notification_log created_at  NOTIFICATION_LOG_RETENTION_DAYS   90
 *   alarms           cleared_at  ALARM_RETENTION_DAYS              365 (only active = false) · evidence
 *   refresh_tokens   expires_at  —                                 expired rows only
 *   maintenance_hints closed_at  MAINTENANCE_HINT_RETENTION_DAYS   365 (closed hints only) · evidence
 *
 * A retention value of 0 (or anything that is not a positive integer) disables
 * that sweep — nothing is ever deleted by accident because of a typo in .env.
 * audit_log is immutable by design and is intentionally not listed here.
 *
 * The two tables marked «evidence» are read by report generators, which serve
 * any period the hourly archive still covers — HOURLY_RETENTION_DAYS, 1095 by
 * default, while these swept at a flat 365. So a plan selling 800 days of
 * retention produced, for a period 13 months back, a PDF with a full temperature
 * log and the line «No alarms during the period» — not because there were none,
 * but because the alarm history had been deleted. A document handed to an
 * inspector must not say that.
 *
 * These two therefore have a floor: whatever the env variable says, they keep at
 * least as long as the archive they describe. To keep less, lower
 * HOURLY_RETENTION_DAYS — that shortens what a report may claim in the first
 * place, which is the honest knob.
 *
 * `events` is deliberately not among them. It is the same kind of evidence — the
 * service report draws its cloud-connectivity section from device_offline /
 * device_online rows — but it is an order of magnitude larger than the other two
 * (a compressor cycling several times an hour writes two rows each time), so
 * tripling its retention is a real storage decision rather than a correction.
 * Instead the service report states when a period predates EVENT_RETENTION_DAYS,
 * rather than printing «no connectivity losses» about days it cannot see. Raising
 * EVENT_RETENTION_DAYS to 1095 is then a one-line choice, not a silent default.
 *
 * Usage:
 *   node scripts/cleanup-aux.js            # dry-run (counts only)
 *   node scripts/cleanup-aux.js --apply    # actually delete
 *
 * Production: modesp-retention-cleanup.timer (daily, 03:30) runs this with
 * --apply right after cleanup-weather.js. Safe to run repeatedly.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { HOURLY_RETENTION_DAYS } = require('../src/lib/platform-defaults');

const BATCH_SIZE = 10000;

const SWEEPS = [
  { table: 'events',           column: 'time',       envKey: 'EVENT_RETENTION_DAYS',            defaultDays: 365 },
  { table: 'notification_log', column: 'created_at', envKey: 'NOTIFICATION_LOG_RETENTION_DAYS', defaultDays: 90 },
  { table: 'alarms',           column: 'cleared_at', envKey: 'ALARM_RETENTION_DAYS',            defaultDays: 365, extraWhere: 'active = false', evidence: true },
  // Expired refresh tokens carry no security value: reuse detection only needs a
  // revoked token until it would have expired anyway.
  { table: 'refresh_tokens',   column: 'expires_at', envKey: null,                              defaultDays: 0 },
  // Closed maintenance hints (plan epic 2.4); open ones have closed_at NULL and never match.
  { table: 'maintenance_hints', column: 'closed_at', envKey: 'MAINTENANCE_HINT_RETENTION_DAYS', defaultDays: 365, evidence: true },
];

/**
 * Days this sweep keeps. An `evidence` table never keeps less than the hourly
 * archive: a report may be asked for any period the archive still covers, and
 * it must not print «no alarms» for a period whose alarms this script deleted.
 * A disabled sweep (retention 0) stays disabled — the floor raises a horizon,
 * it does not start deleting where the operator switched deletion off.
 */
function retentionFor(sweep, env) {
  const floor = sweep.evidence ? HOURLY_RETENTION_DAYS : 0;
  if (!sweep.envKey) return sweep.defaultDays;
  const raw = env[sweep.envKey];
  if (raw === undefined || raw === '') return Math.max(sweep.defaultDays, floor);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(n, floor);
}

/**
 * @param {object} opts
 * @param {(sql: string, params?: any[]) => Promise<{rows:any[], rowCount:number}>} opts.query
 * @param {boolean} [opts.apply=false]
 * @param {Date}    [opts.now=new Date()]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Record<string, {retentionDays:number, cutoff:Date|null, candidates:number, deleted:number, disabled:boolean}>>}
 */
async function run({ query, apply = false, now = new Date(), env = process.env, log = () => {} }) {
  const report = {};

  for (const sweep of SWEEPS) {
    const days = retentionFor(sweep, env);
    const entry = { retentionDays: days, cutoff: null, candidates: 0, deleted: 0, disabled: false };
    report[sweep.table] = entry;

    if (sweep.envKey && days <= 0) {
      entry.disabled = true;
      log(`${sweep.table}: retention disabled (${sweep.envKey}=${env[sweep.envKey]}), skipping`);
      continue;
    }

    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    entry.cutoff = cutoff;

    const where = `${sweep.column} < $1` + (sweep.extraWhere ? ` AND ${sweep.extraWhere}` : '');
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${sweep.table} WHERE ${where}`, [cutoff]);
    entry.candidates = rows[0].n;
    const floored = sweep.evidence && days === HOURLY_RETENTION_DAYS;
    log(`${sweep.table}: ${entry.candidates} row(s) older than ${cutoff.toISOString().slice(0, 10)}` +
        (sweep.envKey ? ` (${days} days${floored ? ', the hourly archive horizon' : ''})` : ' (expired)'));

    if (!apply || entry.candidates === 0) continue;

    for (;;) {
      const res = await query(
        `DELETE FROM ${sweep.table}
          WHERE (tableoid, ctid) IN (
            SELECT tableoid, ctid FROM ${sweep.table}
             WHERE ${where}
             LIMIT ${BATCH_SIZE}
          )`,
        [cutoff]
      );
      if (res.rowCount === 0) break;
      entry.deleted += res.rowCount;
      log(`  ${sweep.table}: deleted ${entry.deleted}/${entry.candidates}`);
    }
  }

  return report;
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
    const report = await run({ query: (sql, params) => pool.query(sql, params), apply, log: console.log });
    const total = Object.values(report).reduce((s, r) => s + (apply ? r.deleted : r.candidates), 0);
    console.log(apply
      ? `\nDone. Deleted ${total} row(s) in total.`
      : `\n=== DRY RUN COMPLETE === ${total} row(s) would be deleted. Run with --apply to execute.`);
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

module.exports = { run, SWEEPS };
