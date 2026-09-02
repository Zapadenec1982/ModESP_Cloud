'use strict';

/**
 * One password policy for every path that sets a password: user creation,
 * self-service change, admin/self-service reset, invitation acceptance and
 * seed-admin.js. NIST SP 800-63B: length over composition rules; the WebUI adds
 * a HaveIBeenPwned k-anonymity check on top.
 */

const { z } = require('zod');

const MIN_PASSWORD_LENGTH = 15;
// bcrypt hashes the first 72 bytes only; the cap just keeps request bodies sane.
const MAX_PASSWORD_LENGTH = 256;

const passwordSchema = z.string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);

module.exports = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, passwordSchema };
