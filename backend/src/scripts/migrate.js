#!/usr/bin/env node
'use strict';

/**
 * Migration runner with a tracking table.
 *
 * Applies every src/db/migrations/*.sql that has not yet been recorded in the
 * schema_migrations table, each inside its own transaction, in filename order.
 * Already-applied files are skipped. Safe to run repeatedly.
 *
 * Usage:
 *   node backend/src/scripts/migrate.js            # apply pending migrations
 *   node backend/src/scripts/migrate.js --dry-run  # list pending, apply nothing
 *   node backend/src/scripts/migrate.js --baseline # record all files as applied
 *                                                  #   WITHOUT executing them
 *                                                  #   (use once on a pre-existing
 *                                                  #    prod DB already migrated by hand)
 *
 * CI: run against a clean DB to catch ordering / idempotency regressions.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');

const DRY_RUN  = process.argv.includes('--dry-run');
const BASELINE = process.argv.includes('--baseline');

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(pool) {
  const { rows } = await pool.query('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => r.id));
}

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function main() {
  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });

  try {
    await ensureTable(pool);
    const applied = await getApplied(pool);
    const files   = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log(`Up to date — ${applied.size} migration(s) already applied.`);
      return;
    }

    if (DRY_RUN) {
      console.log(`Pending migration(s):\n  ${pending.join('\n  ')}`);
      return;
    }

    if (BASELINE) {
      for (const file of pending) {
        await pool.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        console.log(`baseline  ${file}`);
      }
      console.log(`Baselined ${pending.length} file(s) without executing.`);
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`applied   ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`FAILED    ${file}: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`Done — applied ${pending.length} migration(s).`);
  } catch (err) {
    console.error('Migration run failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
