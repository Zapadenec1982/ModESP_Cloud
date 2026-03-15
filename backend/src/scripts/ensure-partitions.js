#!/usr/bin/env node
'use strict';

/**
 * Ensure telemetry partitions exist for the current month + 6 months ahead.
 * Uses the create_telemetry_partition(year, month) function from schema.sql.
 * Safe to run repeatedly (idempotent — uses CREATE TABLE IF NOT EXISTS).
 *
 * Usage:
 *   node backend/src/scripts/ensure-partitions.js
 *
 * Cron (1st of every month):
 *   0 0 1 * * node /opt/modesp-cloud/backend/src/scripts/ensure-partitions.js
 */

require('dotenv').config();

const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });

  try {
    const now = new Date();
    const created = [];

    for (let offset = 0; offset <= 6; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const year  = d.getFullYear();
      const month = d.getMonth() + 1;
      const name  = `telemetry_${year}_${String(month).padStart(2, '0')}`;

      await pool.query('SELECT create_telemetry_partition($1, $2)', [year, month]);
      created.push(name);
    }

    console.log('Partitions ensured:', created.join(', '));
  } catch (err) {
    console.error('Failed to ensure partitions:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
