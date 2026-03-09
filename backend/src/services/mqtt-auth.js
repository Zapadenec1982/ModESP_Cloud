'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db     = require('./db');

const BCRYPT_ROUNDS = 12;  // matches auth.js

/**
 * Generate a random password: 16 chars base64url (96 bits entropy).
 * Short enough for manual entry as fallback.
 */
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Provision MQTT credentials for a device.
 * Generates username + password, stores bcrypt hash in DB.
 * @param {string} tenantId
 * @param {string} mqttDeviceId  e.g. "A4CF12"
 * @returns {Promise<{username: string, password: string}>}
 */
async function provisionDevice(tenantId, mqttDeviceId) {
  const username = `device_${mqttDeviceId}`;
  const password = generatePassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await db.query(
    `UPDATE devices SET mqtt_username = $1, mqtt_password_hash = $2
     WHERE tenant_id = $3 AND mqtt_device_id = $4`,
    [username, hash, tenantId, mqttDeviceId]
  );

  return { username, password };
}

/**
 * Rotate MQTT password for a device.
 * Generates new password, keeps same username.
 * @param {string} tenantId
 * @param {string} mqttDeviceId
 * @returns {Promise<{username: string, password: string}>}
 */
async function rotatePassword(tenantId, mqttDeviceId) {
  const password = generatePassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { rowCount } = await db.query(
    `UPDATE devices SET mqtt_password_hash = $1
     WHERE tenant_id = $2 AND mqtt_device_id = $3 AND mqtt_password_hash IS NOT NULL`,
    [hash, tenantId, mqttDeviceId]
  );

  if (rowCount === 0) {
    throw new Error('Device has no MQTT credentials to rotate');
  }

  return { username: `device_${mqttDeviceId}`, password };
}

/**
 * Revoke MQTT credentials — device can no longer connect.
 * @param {string} tenantId
 * @param {string} mqttDeviceId
 */
async function revokeCredentials(tenantId, mqttDeviceId) {
  await db.query(
    `UPDATE devices SET mqtt_password_hash = NULL
     WHERE tenant_id = $1 AND mqtt_device_id = $2`,
    [tenantId, mqttDeviceId]
  );
}

/**
 * Set bootstrap credentials for a newly discovered device.
 * Uses shared bootstrap hash from env — all devices start with same password.
 * @param {string} mqttDeviceId
 * @param {string} bootstrapHash  pre-computed bcrypt hash of bootstrap password
 */
async function setBootstrapCredentials(mqttDeviceId, bootstrapHash) {
  await db.query(
    `UPDATE devices SET mqtt_username = 'device_' || $1, mqtt_password_hash = $2
     WHERE mqtt_device_id = $1 AND mqtt_password_hash IS NULL`,
    [mqttDeviceId, bootstrapHash]
  );
}

module.exports = {
  generatePassword,
  provisionDevice,
  rotatePassword,
  revokeCredentials,
  setBootstrapCredentials,
};
