'use strict';

const { Pool } = require('pg');

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

let pool = null;
let logger = null;

/**
 * Initialise the DB pool. Call once at startup.
 * @param {import('pino').Logger} log
 */
function init(log) {
  logger = log;
  pool = new Pool({
    host:            process.env.DB_HOST || 'localhost',
    port:            parseInt(process.env.DB_PORT, 10) || 5432,
    database:        process.env.DB_NAME || 'modesp_cloud',
    user:            process.env.DB_USER || 'modesp_cloud',
    password:        process.env.DB_PASS || '',
    max:             parseInt(process.env.DB_POOL_MAX, 10) || 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,   // 30s safety net per query
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected DB pool error');
  });
}

/**
 * Execute a SQL query. Logs slow queries (>1 s).
 * @param {string} sql
 * @param {any[]}  params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(sql, params) {
  const start = Date.now();
  const result = await pool.query(sql, params);
  const ms = Date.now() - start;
  if (ms > 1000) {
    logger.warn({ sql: sql.slice(0, 120), ms }, 'Slow DB query');
  }
  return result;
}

/**
 * Run a callback inside a transaction.
 * @param {(client: import('pg').PoolClient) => Promise<any>} cb
 */
async function transaction(cb) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await cb(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health-check: returns true if a SELECT 1 succeeds.
 */
async function healthy() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully drain the pool.
 */
async function shutdown() {
  if (pool) {
    logger.info('Draining DB pool');
    await pool.end();
  }
}

module.exports = { init, query, transaction, healthy, shutdown, SYSTEM_TENANT_ID };
