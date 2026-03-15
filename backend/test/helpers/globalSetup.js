'use strict';

const { Pool } = require('pg');
const { applySchema, dropAll } = require('./migrate');

module.exports = async function globalSetup() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5433,
    database: process.env.DB_NAME || 'modesp_cloud_test',
    user: process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || 'test_password',
  });

  try {
    await dropAll(pool);
    await applySchema(pool);
    console.log('[globalSetup] Schema applied to test DB');
  } finally {
    await pool.end();
  }
};
