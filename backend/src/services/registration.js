'use strict';

/**
 * Self-registration (plan epic 2.1).
 *
 * POST /auth/register creates an organisation on the free plan together with
 * its first administrator. What happens next depends on two switches:
 *
 *   REGISTRATION_MODE   off      — the endpoint answers 403 and the WebUI hides
 *                                  the link; organisations are created by a
 *                                  superadmin or a partner, as before.
 *                       open     — the organisation starts its trial at once.
 *                       approve  — the organisation stays suspended (no login,
 *                                  no broker topics) until a superadmin
 *                                  approves it on the Organisations page; the
 *                                  trial starts at approval. This is the
 *                                  default: nothing self-served goes live on a
 *                                  server whose owner has not decided so.
 *
 *   e-mail channel      With RESEND_API_KEY set, the administrator must follow
 *                       the verification link before the first login. Without
 *                       it there is nothing to send, so the address is taken as
 *                       is and a warning is logged at boot in open mode.
 *
 * A registration is also reported to REGISTRATION_NOTIFY_EMAIL (falls back to
 * PILOT_REQUEST_EMAIL), whichever mode is on — a new customer is worth a look.
 */

const crypto = require('crypto');
const db       = require('./db');
const authSvc  = require('./auth');
const emailSvc = require('./email');
const planMw   = require('../middleware/plan');
const { uniqueSlug } = require('../lib/slug');
const { pickLocale } = require('../lib/locale');
const { deleteTenant } = require('./tenant-delete');

const MODES = ['off', 'open', 'approve'];
// Slugs POST /tenants refuses, plus the hash routes of the WebUI shell.
const RESERVED_SLUGS = new Set(['__system__', 'pending', 'system', 'admin', 'api', 'public', 'register', 'invite', 'login']);
const VERIFY_HOURS = 24;

function mode() {
  const m = String(process.env.REGISTRATION_MODE || 'approve').trim().toLowerCase();
  return MODES.includes(m) ? m : 'approve';
}

function trialDays() {
  const n = parseInt(process.env.REGISTRATION_TRIAL_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

/** The address is verified by e-mail only when there is an e-mail channel to do it with. */
function verificationRequired() {
  return emailSvc.isConfigured();
}

function appBaseUrl() {
  return (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/+$/, '');
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function newVerification() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: sha256(token), expires: new Date(Date.now() + VERIFY_HOURS * 3600 * 1000) };
}

function verifyLink(email, token) {
  return `${appBaseUrl()}/#/verify?email=${encodeURIComponent(email)}&code=${token}`;
}

function trialEnd(from = new Date()) {
  return new Date(from.getTime() + trialDays() * 86_400_000);
}

async function refreshBroker(log) {
  try { await require('./mqtt').refreshRegistries(); }
  catch (err) { log?.warn?.({ err }, 'Broker registry refresh failed'); }
}

/** Administrators of an organisation with the language each should be written in. */
async function adminRecipients(tenantId) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email, COALESCE(u.locale, s.locale, 'uk') AS locale, t.name AS tenant_name
       FROM tenants t
       LEFT JOIN tenant_settings s ON s.tenant_id = t.id
       JOIN users u ON u.active = true AND u.role <> 'superadmin'
       LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = t.id
      WHERE t.id = $1 AND (ut.role = 'admin' OR (u.tenant_id = t.id AND u.role = 'admin' AND ut.user_id IS NULL))`,
    [tenantId]);
  return rows.map(r => ({ to: r.email, lang: pickLocale(r.locale), tenantName: r.tenant_name }));
}

// ── Registration ──────────────────────────────────────────

/**
 * Create the organisation and its administrator. Resolves
 * { tenant, user, verificationRequired, approvalRequired, emailSent } or
 * throws an Error whose `code` is `email_taken`.
 */
async function register({ organisation, email, password, lang, ip, log }) {
  const approvalRequired = mode() === 'approve';
  const needVerify = verificationRequired();
  const verification = needVerify ? newVerification() : null;
  const locale = pickLocale(lang);
  const emailLower = String(email).trim().toLowerCase();

  const hash = await authSvc.hashPassword(password);
  const { tenant, user } = await db.transaction(async (client) => {
    const { rows: dup } = await client.query('SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1', [emailLower]);
    if (dup.length) { const e = new Error('An account with this e-mail already exists'); e.code = 'email_taken'; throw e; }

    const slug = await uniqueSlug(organisation,
      async (s) => (await client.query('SELECT 1 FROM tenants WHERE slug = $1', [s])).rows.length > 0,
      { reserved: RESERVED_SLUGS });

    const { rows: tRows } = await client.query(
      `INSERT INTO tenants (name, slug, plan, status, trial_expires_at, registered_at, registered_ip, approved_at)
       VALUES ($1, $2, 'free', $3, $4, now(), $5, $6)
       RETURNING id, name, slug, plan, status, trial_expires_at, registered_at, approved_at, created_at`,
      [organisation, slug, approvalRequired ? 'suspended' : 'trial', approvalRequired ? null : trialEnd(),
       ip || null, approvalRequired ? null : new Date()]);
    const tenant = tRows[0];

    const { rows: uRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, locale, terms_accepted_at,
                          email_verified_at, email_verify_hash, email_verify_expires)
       VALUES ($1, $2, $3, 'admin', $4, now(), $5, $6, $7)
       RETURNING id, email, role, tenant_id, locale, timezone, email_verified_at`,
      [tenant.id, emailLower, hash, locale, needVerify ? null : new Date(),
       verification ? verification.hash : null, verification ? verification.expires : null]);
    const user = uRows[0];

    await client.query('INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)', [user.id, tenant.id, 'admin']);
    await client.query(
      'INSERT INTO tenant_settings (tenant_id, locale) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING',
      [tenant.id, locale]);
    return { tenant, user };
  });

  if (!approvalRequired) await refreshBroker(log);

  let emailSent = false;
  if (verification) {
    try {
      emailSent = await emailSvc.sendEmailVerification({
        to: user.email, link: verifyLink(user.email, verification.token), tenantName: tenant.name, lang: locale, expiresHours: VERIFY_HOURS,
      });
    } catch (err) {
      log?.error?.({ err, tenantId: tenant.id }, 'Verification e-mail failed');
    }
  }

  const notifyTo = process.env.REGISTRATION_NOTIFY_EMAIL || process.env.PILOT_REQUEST_EMAIL;
  try {
    await emailSvc.sendRegistrationNotice({
      to: notifyTo, tenant, email: user.email, mode: mode(), ip, link: `${appBaseUrl()}/#/tenants`,
    });
  } catch (err) {
    log?.warn?.({ err, tenantId: tenant.id }, 'Registration notice e-mail failed');
  }

  return { tenant, user, verificationRequired: needVerify, approvalRequired, emailSent };
}

// ── E-mail verification ───────────────────────────────────

/** True when the organisation registered itself and no superadmin has approved it yet. */
function awaitingApproval(tenant) {
  return !!(tenant && tenant.registered_at && !tenant.approved_at);
}

/**
 * Mark the address verified. Throws with code `invalid_code` or `code_expired`.
 * Resolves the user with its home organisation.
 */
async function verifyEmail({ email, code }) {
  const emailLower = String(email).trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, u.tenant_id, u.locale, u.timezone, u.active,
            u.email_verified_at, u.email_verify_hash, u.email_verify_expires
       FROM users u WHERE lower(u.email) = $1 LIMIT 1`, [emailLower]);
  const user = rows[0];
  const fail = (codeName) => { const e = new Error(codeName === 'code_expired' ? 'Verification link has expired' : 'Invalid verification link'); e.code = codeName; throw e; };
  if (!user || !user.active) fail('invalid_code');
  if (user.email_verified_at) return { user, alreadyVerified: true };
  if (!user.email_verify_hash || typeof code !== 'string' || !/^[0-9a-f]{64}$/.test(code)) fail('invalid_code');
  const a = Buffer.from(user.email_verify_hash, 'utf8');
  const b = Buffer.from(sha256(code), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('invalid_code');
  if (new Date(user.email_verify_expires) < new Date()) fail('code_expired');

  await db.query(
    `UPDATE users SET email_verified_at = now(), email_verify_hash = NULL, email_verify_expires = NULL WHERE id = $1`,
    [user.id]);
  user.email_verified_at = new Date();
  return { user, alreadyVerified: false };
}

/** A fresh link for an unverified address; silently a no-op otherwise. Resolves whether a mail went out. */
async function resendVerification({ email, lang, log }) {
  const emailLower = String(email).trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.locale, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = $1 AND u.active = true AND u.email_verified_at IS NULL LIMIT 1`, [emailLower]);
  if (rows.length === 0 || !verificationRequired()) return false;
  const user = rows[0];
  const v = newVerification();
  await db.query('UPDATE users SET email_verify_hash = $2, email_verify_expires = $3 WHERE id = $1', [user.id, v.hash, v.expires]);
  try {
    return await emailSvc.sendEmailVerification({
      to: user.email, link: verifyLink(user.email, v.token), tenantName: user.tenant_name,
      lang: pickLocale(lang || user.locale), expiresHours: VERIFY_HOURS,
    });
  } catch (err) {
    log?.error?.({ err, userId: user.id }, 'Verification e-mail failed');
    return false;
  }
}

// ── Superadmin approval ───────────────────────────────────

/** Start the trial of a registered organisation. Resolves the tenant, or null when it is not awaiting approval. */
async function approve(tenantId, { approvedBy = null, log } = {}) {
  const { rows } = await db.query(
    `UPDATE tenants SET status = 'trial', trial_expires_at = $2, approved_at = now(), approved_by = $3
      WHERE id = $1 AND registered_at IS NOT NULL AND approved_at IS NULL
      RETURNING id, name, slug, plan, status, trial_expires_at, registered_at, approved_at, created_at`,
    [tenantId, trialEnd(), approvedBy]);
  const tenant = rows[0];
  if (!tenant) return null;
  planMw.invalidate(tenant.id);
  await refreshBroker(log);
  for (const r of await adminRecipients(tenant.id)) {
    try {
      await emailSvc.sendRegistrationApproved({ ...r, link: `${appBaseUrl()}/#/`, trialDays: trialDays() });
    } catch (err) {
      log?.warn?.({ err, tenantId: tenant.id }, 'Approval e-mail failed');
    }
  }
  return tenant;
}

/** Remove a registration that was not approved (its users and settings go with it). */
async function reject(tenantId, { log } = {}) {
  const { rows } = await db.query(
    'SELECT id FROM tenants WHERE id = $1 AND registered_at IS NOT NULL AND approved_at IS NULL', [tenantId]);
  if (rows.length === 0) return null;
  const result = await db.transaction((client) => deleteTenant(client, tenantId));
  await refreshBroker(log);
  return result;
}

module.exports = {
  MODES, VERIFY_HOURS,
  mode, trialDays, verificationRequired, appBaseUrl,
  register, verifyEmail, resendVerification, awaitingApproval, approve, reject, adminRecipients,
};
