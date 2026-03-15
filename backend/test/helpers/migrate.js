'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../../src/db/schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations');

/**
 * Apply schema.sql + all numbered migrations to the given pool.
 * Skips telemetry partition creation (test DB uses default partition).
 */
async function applySchema(pool) {
  // 1. Schema
  let schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // Remove telemetry partitions (not needed for tests, and dates may be past)
  schema = schema.replace(/CREATE TABLE telemetry_\d{4}_\d{2} PARTITION OF[\s\S]*?;/g, '');
  // Create a catch-all default partition for tests
  schema += `\nCREATE TABLE IF NOT EXISTS telemetry_default PARTITION OF telemetry DEFAULT;\n`;
  await pool.query(schema);

  // 2. Migrations (sorted by number)
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Skip GRANT/REVOKE to roles that don't exist in test DB
    sql = sql.replace(/^(GRANT|REVOKE)\b.*$/gm, '-- [test-skip] $&');
    try {
      await pool.query(sql);
    } catch (err) {
      // Ignore "already exists" and "does not exist" errors from migrations
      if (err.code === '42710' || err.code === '42704' || err.code === '42P07') continue;
      throw err;
    }
  }
}

/**
 * Drop all tables (for clean re-creation).
 */
async function dropAll(pool) {
  await pool.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO modesp_cloud;
  `);
}

module.exports = { applySchema, dropAll };
