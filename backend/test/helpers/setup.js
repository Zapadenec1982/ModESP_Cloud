'use strict';

// Set env vars BEFORE any app code is required
process.env.AUTH_ENABLED = 'true';
process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '900';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5433';
process.env.DB_NAME = process.env.DB_NAME || 'modesp_cloud_test';
process.env.DB_USER = process.env.DB_USER || 'modesp_cloud';
process.env.DB_PASS = process.env.DB_PASS || 'test_password';

const pino = require('pino');
const silentLogger = pino({ level: 'silent' });

// Init DB service with silent logger
const db = require('../../src/services/db');
db.init(silentLogger);

/**
 * TRUNCATE all tables for test isolation.
 */
async function cleanDatabase() {
  // Wait for any async audit inserts to complete
  await new Promise(r => setTimeout(r, 150));

  // Disable audit immutability trigger temporarily
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable');

  await db.query(`
    TRUNCATE TABLE
      audit_log,
      notification_log,
      notification_subscribers,
      push_subscriptions,
      events,
      alarms,
      telemetry,
      service_records,
      user_devices,
      refresh_tokens,
      user_tenants,
      devices,
      users,
      tenants
    CASCADE
  `);

  // Re-enable trigger
  await db.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable');

  // Re-create system tenant (many things depend on it)
  await db.query(`
    INSERT INTO tenants (id, name, slug, plan, active)
    VALUES ('00000000-0000-0000-0000-000000000000', 'System', 'system', 'system', true)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function shutdownDb() {
  await db.shutdown();
}

module.exports = { cleanDatabase, shutdownDb, db };
