'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('./setup');

const DEFAULT_PASSWORD = 'Test1234!';

function randomHex(len = 6) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

/**
 * Create a tenant in the DB.
 */
async function createTenant(overrides = {}) {
  const slug = overrides.slug || `test-${randomHex(8)}`;
  const name = overrides.name || slug;
  const plan = overrides.plan || 'free';

  const { rows } = await db.query(
    `INSERT INTO tenants (name, slug, plan, active) VALUES ($1, $2, $3, true) RETURNING *`,
    [name, slug, plan]
  );
  return rows[0];
}

/**
 * Create a user in the DB, linked to a tenant.
 */
async function createUser(tenantId, overrides = {}) {
  const email = overrides.email || `user-${randomHex(8)}@test.local`;
  const password = overrides.password || DEFAULT_PASSWORD;
  const role = overrides.role || 'viewer';
  const active = overrides.active !== undefined ? overrides.active : true;

  const passwordHash = await bcrypt.hash(password, 4); // fast rounds for tests

  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, email, passwordHash, role, active]
  );
  const user = rows[0];

  // Link user to tenant via user_tenants
  await db.query(
    `INSERT INTO user_tenants (user_id, tenant_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [user.id, tenantId]
  );

  // Attach plaintext password for test login
  user._password = password;
  return user;
}

/**
 * Create a device in the DB.
 */
async function createDevice(tenantId, overrides = {}) {
  const mqttId = overrides.mqttId || randomHex(6).toUpperCase();
  const name = overrides.name || `Device ${mqttId}`;

  const { rows } = await db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, name, status, online)
     VALUES ($1, $2, $3, 'active', false) RETURNING *`,
    [tenantId, mqttId, name]
  );
  return rows[0];
}

/**
 * Grant device access to a user.
 */
async function grantDeviceAccess(userId, deviceId, grantedBy) {
  await db.query(
    `INSERT INTO user_devices (user_id, device_id, granted_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, deviceId, grantedBy]
  );
}

/**
 * Generate an Authorization header with a valid JWT for the given user.
 */
function authHeader(user, tenantId) {
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tenantId },
    process.env.JWT_SECRET,
    { expiresIn: 900 }
  );
  return { Authorization: `Bearer ${token}` };
}

/**
 * Create a firmware record in the DB.
 */
async function createFirmware(tenantId, overrides = {}) {
  const version = overrides.version || `1.0.${randomHex(4)}`;
  const filename = overrides.filename || `${tenantId}_${version}_test.bin`;

  const { rows } = await db.query(
    `INSERT INTO firmwares (tenant_id, version, filename, original_name, size_bytes, checksum, notes, board_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      tenantId, version, filename,
      overrides.original_name || 'test.bin',
      overrides.size_bytes || 1024,
      overrides.checksum || `sha256:${randomHex(32)}`,
      overrides.notes || null,
      overrides.board_type || null,
    ]
  );
  return rows[0];
}

module.exports = { createTenant, createUser, createDevice, createFirmware, grantDeviceAccess, authHeader };
