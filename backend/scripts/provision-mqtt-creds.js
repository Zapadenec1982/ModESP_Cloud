#!/usr/bin/env node
'use strict';

/**
 * provision-mqtt-creds.js
 *
 * Migration script for Phase 4: MQTT Dynamic Auth.
 * Generates unique MQTT credentials for existing active devices
 * that don't have mqtt_password_hash set yet.
 *
 * Usage:
 *   node scripts/provision-mqtt-creds.js           # dry-run (shows what would be provisioned)
 *   node scripts/provision-mqtt-creds.js --apply   # generate and store credentials
 *
 * After running with --apply:
 *   - Credentials are printed in a table for manual entry (pilot devices)
 *   - Or sent via MQTT cmd/_set_mqtt_creds if firmware supports it (Stage B)
 *
 * Safe to run multiple times (only provisions devices without credentials).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BCRYPT_ROUNDS = 12;
const apply = process.argv.includes('--apply');

const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'modesp_cloud',
  user:     process.env.DB_USER || 'modesp_cloud',
  password: process.env.DB_PASS || '',
});

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

async function main() {
  console.log(`\n=== MQTT Credentials Provisioning (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // Find active devices without MQTT credentials
  const { rows } = await pool.query(
    `SELECT d.id, d.mqtt_device_id, d.status, d.mqtt_username, d.mqtt_password_hash,
            t.slug AS tenant_slug, t.name AS tenant_name
     FROM devices d
     LEFT JOIN tenants t ON t.id = d.tenant_id
     WHERE d.status = 'active' AND d.mqtt_password_hash IS NULL
     ORDER BY t.slug, d.mqtt_device_id`
  );

  if (rows.length === 0) {
    console.log('All active devices already have MQTT credentials. Nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Found ${rows.length} active device(s) without MQTT credentials:\n`);

  const results = [];

  for (const device of rows) {
    const username = `device_${device.mqtt_device_id}`;
    const password = generatePassword();

    if (apply) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await pool.query(
        `UPDATE devices SET mqtt_username = $1, mqtt_password_hash = $2 WHERE id = $3`,
        [username, hash, device.id]
      );
    }

    results.push({
      tenant: device.tenant_slug || '(system)',
      device_id: device.mqtt_device_id,
      username,
      password: apply ? password : '(dry-run)',
    });
  }

  // Print table
  console.log('Tenant          | Device  | Username        | Password');
  console.log('----------------|---------|-----------------|------------------');
  for (const r of results) {
    console.log(
      `${r.tenant.padEnd(16)}| ${r.device_id.padEnd(8)}| ${r.username.padEnd(16)}| ${r.password}`
    );
  }

  if (apply) {
    console.log(`\n✅ ${results.length} device(s) provisioned.`);
    console.log('⚠️  Save the passwords above — they are shown only once!');
    console.log('   For pilot devices: enter credentials via ESP32 local WebUI.');
    console.log('   After Stage B firmware: credentials will be sent via MQTT automatically.');
  } else {
    console.log(`\nDry-run complete. Run with --apply to generate actual credentials.`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
