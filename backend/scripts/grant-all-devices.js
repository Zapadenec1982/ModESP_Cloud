#!/usr/bin/env node
'use strict';

/**
 * grant-all-devices.js
 *
 * One-time migration script for Phase 7a RBAC rollout.
 * Grants all existing active devices to all non-admin users within each tenant.
 * This preserves backward compatibility: before RBAC, everyone saw everything.
 *
 * Run BEFORE deploying Phase 7a code when AUTH_ENABLED=true.
 *
 * Usage:
 *   node scripts/grant-all-devices.js           # dry-run (shows what would be inserted)
 *   node scripts/grant-all-devices.js --apply    # actually insert rows
 *
 * Safe to run multiple times (ON CONFLICT DO NOTHING).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'modesp_cloud',
  user:     process.env.DB_USER || 'modesp_cloud',
  password: process.env.DB_PASS || '',
});

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('=== DRY RUN === (use --apply to execute)\n');
  }

  // Get all real tenants (exclude system tenant)
  const tenants = await pool.query(
    `SELECT id, name, slug FROM tenants WHERE id != $1 AND active = true`,
    [SYSTEM_TENANT_ID]
  );

  console.log(`Found ${tenants.rows.length} tenant(s)\n`);

  let totalInserted = 0;

  for (const tenant of tenants.rows) {
    // Get all active devices for this tenant
    const devices = await pool.query(
      `SELECT id, mqtt_device_id FROM devices WHERE tenant_id = $1 AND status = 'active'`,
      [tenant.id]
    );

    // Get all non-admin active users for this tenant
    const users = await pool.query(
      `SELECT id, email, role FROM users WHERE tenant_id = $1 AND role != 'admin' AND active = true`,
      [tenant.id]
    );

    if (devices.rows.length === 0 || users.rows.length === 0) {
      console.log(`Tenant "${tenant.name}" (${tenant.slug}): ${devices.rows.length} devices, ${users.rows.length} non-admin users — skipping`);
      continue;
    }

    console.log(`Tenant "${tenant.name}" (${tenant.slug}): ${devices.rows.length} devices × ${users.rows.length} non-admin users`);

    // Build multi-row INSERT for all user-device pairs
    const pairs = [];
    for (const user of users.rows) {
      for (const device of devices.rows) {
        pairs.push({ userId: user.id, deviceId: device.id });
      }
    }

    console.log(`  → ${pairs.length} user_devices pairs to insert`);

    if (!dryRun && pairs.length > 0) {
      // Batch INSERT (chunks of 1000 to avoid query size limits)
      const CHUNK_SIZE = 1000;
      for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
        const chunk = pairs.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map((_, idx) =>
          `($${idx * 2 + 1}, $${idx * 2 + 2})`
        );
        const values = chunk.flatMap(p => [p.userId, p.deviceId]);

        const result = await pool.query(
          `INSERT INTO user_devices (user_id, device_id)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );

        totalInserted += result.rowCount;
        console.log(`  → Chunk ${Math.floor(i / CHUNK_SIZE) + 1}: inserted ${result.rowCount} new rows`);
      }
    }
  }

  if (dryRun) {
    console.log('\n=== DRY RUN COMPLETE === Run with --apply to execute');
  } else {
    console.log(`\nDone. Total new user_devices rows: ${totalInserted}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
