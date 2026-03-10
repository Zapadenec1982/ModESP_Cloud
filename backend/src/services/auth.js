'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password.
 * @param {string} plain
 * @returns {Promise<string>}
 */
function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Compare plaintext against hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Sign a short-lived access token.
 * @param {{ id: string, email: string, role: string, tenantId: string }} user
 * @returns {string}
 */
function generateAccessToken(user) {
  const secret    = process.env.JWT_SECRET;
  const expiresIn = parseInt(process.env.JWT_EXPIRES_IN, 10) || 900;

  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId },
    secret,
    { expiresIn }
  );
}

/**
 * Generate a random refresh token (64-byte hex string).
 * @returns {string}
 */
function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * SHA-256 hash of a refresh token (for DB storage).
 * @param {string} token
 * @returns {string}
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify and decode an access token.
 * @param {string} token
 * @returns {{ sub: string, email: string, role: string, tenantId: string }}
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError}
 */
function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

/**
 * Sign a short-lived pending token (no tenantId, for tenant selection flow).
 * @param {{ id: string, email: string, role: string }} user
 * @returns {string}
 */
function generatePendingToken(user) {
  const secret = process.env.JWT_SECRET;
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, pending: true },
    secret,
    { expiresIn: 300 } // 5 minutes
  );
}

/**
 * Verify and decode a pending token.
 * @param {string} token
 * @returns {{ sub: string, email: string, role: string, pending: true }}
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError}
 */
function verifyPendingToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!payload.pending) throw new jwt.JsonWebTokenError('Not a pending token');
  return payload;
}

module.exports = {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  generatePendingToken,
  verifyPendingToken,
};
