'use strict';

const crypto = require('crypto');

const SECRET    = process.env.JWT_SECRET;
const EXPIRY_SEC = 30 * 60; // 30 minutes

/**
 * Generate HMAC-SHA256 signed download URL for a firmware file.
 * @param {string} filename - firmware binary filename (e.g. "uuid_1.0.0_ts.bin")
 * @returns {string} signed path: /api/firmware/dl?file=...&expires=...&sig=...
 */
function generateSignedUrl(filename) {
  const expires = Math.floor(Date.now() / 1000) + EXPIRY_SEC;
  const sig = crypto.createHmac('sha256', SECRET)
    .update(`${filename}:${expires}`).digest('hex').slice(0, 32);
  return `/api/firmware/dl?file=${encodeURIComponent(filename)}&expires=${expires}&sig=${sig}`;
}

/**
 * Verify HMAC signature and expiry for a firmware download request.
 */
function verifySignature(filename, expires, sig) {
  if (!filename || !expires || !sig || typeof sig !== 'string') return false;
  if (Date.now() / 1000 > Number(expires)) return false;
  if (sig.length !== 32) return false;

  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${filename}:${expires}`).digest('hex').slice(0, 32);

  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
}

module.exports = { generateSignedUrl, verifySignature };
