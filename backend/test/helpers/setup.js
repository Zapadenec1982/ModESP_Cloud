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

  // geocode_cache is listed explicitly because it is the one new table with no
  // foreign key — TRUNCATE ... CASCADE reaches sites, user_sites,
  // weather_observations and site_public_links through tenants/users/devices,
  // but a cached geocoder response would otherwise survive into the next test
  // file and turn a stubbed provider miss into a silent cache hit.
  await db.query(`
    TRUNCATE TABLE
      geocode_cache,
      audit_log,
      notification_log,
      notification_subscribers,
      push_subscriptions,
      ota_jobs,
      ota_rollouts,
      firmwares,
      work_orders,
      maintenance_hints,
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

  // TRUNCATE tenants CASCADE reaches maintenance_rules through its FK and takes
  // the platform defaults (tenant_id NULL) with it; put back what migration 032 seeds.
  await db.query(`
    INSERT INTO maintenance_rules (tenant_id, rule_key, model, threshold, window_hours, severity) VALUES
      (NULL, 'compressor_starts', NULL, 8,  24, 'info'),
      (NULL, 'compressor_duty',   NULL, 85, 24, 'info'),
      (NULL, 'defrost_timeouts',  NULL, 3,  24, 'info'),
      (NULL, 'door_openings',     NULL, 80, 24, 'info'),
      (NULL, 'cond_temp',         NULL, 55, 24, 'info')
    ON CONFLICT DO NOTHING
  `);
}

async function shutdownDb() {
  await db.shutdown();
}

module.exports = { cleanDatabase, shutdownDb, db };
