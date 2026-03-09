#!/usr/bin/env node
'use strict';

/**
 * Seed an admin or superadmin user for a given tenant.
 *
 * Usage:
 *   node src/db/seed-admin.js --email admin@example.com --password secret123
 *   node src/db/seed-admin.js --email super@example.com --password secret123 --role superadmin
 *
 * Options:
 *   --tenant-id  UUID (default: SYSTEM_TENANT_ID)
 *   --role       admin | superadmin (default: admin)
 */

require('dotenv').config();

const { Pool } = require('pg');
const { hashPassword } = require('../services/auth');

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const email    = get('--email');
  const password = get('--password');
  const tenantId = get('--tenant-id') || '00000000-0000-0000-0000-000000000000';
  const role     = get('--role') || 'admin';

  if (!email || !password) {
    console.error('Usage: node src/db/seed-admin.js --email <email> --password <password> [--tenant-id <uuid>] [--role admin|superadmin]');
    process.exit(1);
  }

  if (!['admin', 'superadmin'].includes(role)) {
    console.error('Role must be "admin" or "superadmin"');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }

  const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'modesp_cloud',
    user:     process.env.DB_USER || 'modesp_cloud',
    password: process.env.DB_PASS || '',
  });

  try {
    const hash = await hashPassword(password);

    const { rows } = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     role = EXCLUDED.role,
                     active = true
       RETURNING id, email, role`,
      [tenantId, email, hash, role]
    );

    console.log(`${role} user seeded:`, rows[0]);
  } catch (err) {
    console.error('Failed to seed admin:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
