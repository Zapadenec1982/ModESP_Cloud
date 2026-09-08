'use strict';

/**
 * Two-factor authentication with a TOTP authenticator app (plan epic 2.9).
 *
 * Setup is two steps so a mistyped QR can never lock anyone out: `setup`
 * stores the secret as pending and returns the otpauth URL and a QR; `enable`
 * accepts the first code from the app, promotes the secret and hands out ten
 * backup codes — once. From then on login asks for a code after the password
 * (`mfa_token` round trip in routes/auth.js). A code is good once: the
 * 30-second step it came from is remembered and not accepted again.
 *
 * The secret is encrypted at rest (AES-256-GCM) under MFA_ENCRYPTION_KEY,
 * falling back to JWT_SECRET — a database dump alone must not be enough to
 * mint codes. Backup codes are SHA-256 hashes; each is consumed on use.
 */

const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const db = require('./db');

const ISSUER = 'ModESP Cloud';
const BACKUP_CODES = 10;
const STEP_SECONDS = 30;

function applyOptions(epochMs = null) {
  authenticator.options = { step: STEP_SECONDS, window: [1, 1], ...(epochMs ? { epoch: epochMs } : {}) };
}
applyOptions();

/** Now, or the clock the tests pinned through __test.setEpoch(). */
function nowMs() {
  const e = authenticator.options && authenticator.options.epoch;
  return typeof e === 'number' ? e : Date.now();
}

// ── Secret encryption ─────────────────────────────────────

function key() {
  const material = process.env.MFA_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(`mfa:${material}`).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const [v, iv, tag, enc] = String(stored).split(':');
  if (v !== 'v1') return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

// ── Backup codes ──────────────────────────────────────────

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/** "ab12-cd34" style, unambiguous alphabet, 40 bits each. */
function newBackupCodes(n = BACKUP_CODES) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (let j = 0; j < 8; j++) s += alphabet[bytes[j] % alphabet.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codes;
}

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase().replace(/\s+/g, '');
}

// ── Setup / enable / disable ──────────────────────────────

async function status(userId) {
  const { rows } = await db.query(
    `SELECT mfa_enabled_at, mfa_pending_secret IS NOT NULL AS pending, jsonb_array_length(mfa_backup_codes) AS backup_codes_left
       FROM users WHERE id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  return { enabled: !!r.mfa_enabled_at, enabled_at: r.mfa_enabled_at, pending: r.pending, backup_codes_left: r.backup_codes_left };
}

/** Start (or restart) a setup: a fresh pending secret, the otpauth URL and a QR data URL. */
async function setup(userId, email) {
  const secret = authenticator.generateSecret(20);
  await db.query('UPDATE users SET mfa_pending_secret = $2 WHERE id = $1', [userId, encrypt(secret)]);
  const otpauth = authenticator.keyuri(email, ISSUER, secret);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
  return { secret, otpauth_url: otpauth, qr };
}

/** The first code from the app promotes the pending secret. Resolves the backup codes, or null when the code is wrong. */
async function enable(userId, code) {
  const { rows } = await db.query('SELECT mfa_pending_secret FROM users WHERE id = $1', [userId]);
  const secret = decrypt(rows[0] && rows[0].mfa_pending_secret);
  if (!secret) { const e = new Error('No MFA setup in progress'); e.code = 'no_setup'; throw e; }
  if (!authenticator.check(normalizeCode(code), secret)) return null;
  const codes = newBackupCodes();
  await db.query(
    `UPDATE users SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL, mfa_enabled_at = now(),
                      mfa_backup_codes = $2::jsonb, mfa_last_step = $3
      WHERE id = $1`,
    [userId, JSON.stringify(codes.map(sha256)), currentStep()]);
  return codes;
}

async function disable(userId) {
  await db.query(
    `UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL,
                      mfa_backup_codes = '[]'::jsonb, mfa_last_step = NULL
      WHERE id = $1`, [userId]);
}

/** New backup codes; the old ones stop working. */
async function regenerateBackupCodes(userId) {
  const codes = newBackupCodes();
  await db.query('UPDATE users SET mfa_backup_codes = $2::jsonb WHERE id = $1 AND mfa_enabled_at IS NOT NULL', [userId, JSON.stringify(codes.map(sha256))]);
  return codes;
}

// ── Verification ──────────────────────────────────────────

function currentStep(now = nowMs()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Check a TOTP code or a backup code for a user with MFA enabled.
 * Resolves { ok, method: 'totp' | 'backup' } — false when wrong, replayed, or
 * MFA is not enabled. A TOTP code is accepted from the previous, current or
 * next step, and a step is accepted once.
 */
async function verify(userId, code) {
  const { rows } = await db.query(
    'SELECT mfa_secret, mfa_backup_codes, mfa_last_step FROM users WHERE id = $1 AND mfa_enabled_at IS NOT NULL', [userId]);
  const u = rows[0];
  if (!u) return { ok: false };
  const normalized = normalizeCode(code);

  if (/^\d{6}$/.test(normalized)) {
    const secret = decrypt(u.mfa_secret);
    if (!secret) return { ok: false };
    const delta = authenticator.checkDelta(normalized, secret);   // null when wrong; -1/0/1 for the accepted step
    if (delta === null) return { ok: false };
    const step = currentStep() + delta;
    if (u.mfa_last_step !== null && Number(u.mfa_last_step) >= step) return { ok: false, replayed: true };
    await db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [userId, step]);
    return { ok: true, method: 'totp' };
  }

  // Backup code: constant-time over the whole list, consumed on success
  const hashes = Array.isArray(u.mfa_backup_codes) ? u.mfa_backup_codes : [];
  const presented = Buffer.from(sha256(normalized), 'utf8');
  let matched = -1;
  for (let i = 0; i < hashes.length; i++) {
    const h = Buffer.from(String(hashes[i]), 'utf8');
    if (h.length === presented.length && crypto.timingSafeEqual(h, presented)) matched = i;
  }
  if (matched < 0) return { ok: false };
  hashes.splice(matched, 1);
  await db.query('UPDATE users SET mfa_backup_codes = $2::jsonb WHERE id = $1', [userId, JSON.stringify(hashes)]);
  return { ok: true, method: 'backup', backup_codes_left: hashes.length };
}

module.exports = {
  ISSUER, BACKUP_CODES, STEP_SECONDS,
  status, setup, enable, disable, regenerateBackupCodes, verify,
  // the same at-rest encryption serves webhook secrets (plan epic 2.6)
  encryptSecret: encrypt, decryptSecret: decrypt,
  __test: { encrypt, decrypt, newBackupCodes, currentStep, authenticator, setEpoch: applyOptions },
};
