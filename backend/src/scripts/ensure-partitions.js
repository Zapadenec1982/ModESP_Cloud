#!/usr/bin/env node
'use strict';

/**
 * Ensure telemetry partitions exist for the current month and the next
 * PARTITION_MONTHS_AHEAD months (default 6).
 *
 * Uses create_telemetry_partition(year, month) — a SECURITY DEFINER function
 * since migration 023, so this runs with the ordinary DB_USER credentials from
 * backend/.env. Idempotent (CREATE TABLE IF NOT EXISTS): safe to run repeatedly.
 *
 * Usage:
 *   node backend/src/scripts/ensure-partitions.js
 *
 * Production: modesp-telemetry-partition.timer (25th of every month, 03:00).
 * Six months of headroom means a timer that silently fails still leaves half a
 * year before telemetry INSERTs start failing with "no partition of relation".
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const DEFAULT_MONTHS_AHEAD = 6;

/**
 * @param {object} opts
 * @param {(sql: string, params?: any[]) => Promise<any>} opts.query
 * @param {Date}   [opts.now=new Date()]
 * @param {number} [opts.monthsAhead]
 * @returns {Promise<string[]>} partition names ensured, oldest first
 */
async function run({ query, now = new Date(), monthsAhead }) {
  const parsed = parseInt(monthsAhead ?? process.env.PARTITION_MONTHS_AHEAD, 10);
  const ahead = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHS_AHEAD;
  const ensured = [];

  for (let offset = 0; offset <= ahead; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year  = d.getFullYear();
    const month = d.getMonth() + 1;
    await query('SELECT create_telemetry_partition($1, $2)', [year, month]);
    ensured.push(`telemetry_${year}_${String(month).padStart(2, '0')}`);
  }
  return ensured;
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });

  try {
    const ensured = await run({ query: (sql, params) => pool.query(sql, params) });
    console.log('Partitions ensured:', ensured.join(', '));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Failed to ensure partitions:', err.message);
    process.exit(1);
  });
}

module.exports = { run, DEFAULT_MONTHS_AHEAD };
