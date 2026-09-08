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
 * Sign a short-lived access token. `sid` is the session (refresh-token
 * family) the token belongs to (plan epic 2.9).
 * @param {{ id: string, email: string, role: string, tenantId: string, sid?: string }} user
 * @param {{ expiresIn?: number, impersonator?: { id: string, email: string } }} [opts]
 * @returns {string}
 */
function generateAccessToken(user, opts = {}) {
  const secret    = process.env.JWT_SECRET;
  const expiresIn = opts.expiresIn || parseInt(process.env.JWT_EXPIRES_IN, 10) || 900;

  const claims = { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId };
  if (user.sid) claims.sid = user.sid;
  // Support impersonation (plan epic 2.13): who is really behind this token
  if (opts.impersonator) claims.imp = { id: opts.impersonator.id, email: opts.impersonator.email };
  return jwt.sign(claims, secret, { expiresIn });
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

/**
 * Sign the token that carries a login from "password accepted" to "second
 * factor accepted" (plan epic 2.9). Five minutes, useless for the API.
 * @param {{ id: string, email: string, role: string }} user
 */
function generateMfaToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, mfa: true },
    process.env.JWT_SECRET,
    { expiresIn: 300 }
  );
}

function verifyMfaToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  if (!payload.mfa) throw new jwt.JsonWebTokenError('Not an MFA token');
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
  generateMfaToken,
  verifyMfaToken,
};
