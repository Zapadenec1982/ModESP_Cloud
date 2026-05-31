'use strict';

const crypto = require('crypto');

const EXPIRY_SEC = 30 * 60; // 30 minutes

/**
 * Secret for signing firmware download URLs. Prefers a dedicated
 * FIRMWARE_URL_SECRET; falls back to JWT_SECRET only if unset. Read at call
 * time (not module load) so config/tests can set it after require.
 */
function secret() {
  return process.env.FIRMWARE_URL_SECRET || process.env.JWT_SECRET;
}

function sign(filename, deviceId, expires) {
  return crypto.createHmac('sha256', secret())
    .update(`${filename}:${deviceId}:${expires}`)
    .digest('hex');
}

/**
 * Generate an HMAC-SHA256 signed, device-scoped download URL for a firmware file.
 * The signature binds filename + device_id + expiry, so a URL minted for one
 * device cannot be replayed to fetch firmware for another.
 * @param {string} filename - firmware binary filename (e.g. "uuid_1.0.0_ts.bin")
 * @param {string} deviceId - target device's mqtt_device_id
 * @returns {string} signed path: /api/firmware/dl?file=...&device=...&expires=...&sig=...
 */
function generateSignedUrl(filename, deviceId) {
  const expires = Math.floor(Date.now() / 1000) + EXPIRY_SEC;
  const sig = sign(filename, deviceId, expires);
  return `/api/firmware/dl?file=${encodeURIComponent(filename)}`
    + `&device=${encodeURIComponent(deviceId)}`
    + `&expires=${expires}&sig=${sig}`;
}

/**
 * Verify HMAC signature, device binding and expiry for a firmware download request.
 */
function verifySignature(filename, deviceId, expires, sig) {
  if (!filename || !deviceId || !expires || !sig || typeof sig !== 'string') return false;
  if (Date.now() / 1000 > Number(expires)) return false;

  const expected = sign(filename, deviceId, expires);
  if (sig.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
}

module.exports = { generateSignedUrl, verifySignature };
