'use strict';

/**
 * Support impersonation (plan epic 2.13): a superadmin signs in as a user of
 * an organisation to see what they see and to fix what they cannot.
 *
 * What it is: a short-lived access token for the target user in one
 * organisation, carrying the role the user holds there and an `imp` claim
 * naming the support engineer. It is NOT a session — no refresh token, no
 * cookie, nothing to revoke: it dies at `exp` (IMPERSONATION_TTL_MIN, default
 * 60 minutes) and the WebUI returns to the engineer's own session.
 *
 * What it may not do: obtain secrets, change the account's own security or
 * take data out. Those paths answer 403 `impersonation_scope`. Every other
 * request is recorded in audit_log with the user AND the impersonator, so the
 * organisation's administrator sees "done by support" in their own audit log.
 */

const authSvc = require('./auth');

const DEFAULT_TTL_MIN = 60;

function ttlMinutes() {
  const n = parseInt(process.env.IMPERSONATION_TTL_MIN, 10);
  return Number.isFinite(n) ? Math.min(240, Math.max(5, n)) : DEFAULT_TTL_MIN;
}

const WRITE = (m) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
const ANY   = () => true;

/** [path regex, method predicate] — refused while impersonating. */
const DENIED = [
  // The engineer's session, not the user's: no refresh, no logout, no tenant
  // switch (it would open a real session as the user), no MFA or session changes.
  [/^\/api\/auth(\/|$)/, WRITE],
  // Own credentials and own delivery endpoints of the account
  [/^\/api\/profile\/(password|telegram-link|push-subscription)(\/|$)/, WRITE],
  // Secrets shown once: API keys, webhook signing secrets, MQTT credentials of an import
  [/^\/api\/api-keys(\/|$)/, WRITE],
  [/^\/api\/webhooks(\/|$)/, WRITE],
  [/^\/api\/imports\/[^/]+\/credentials\.csv$/, ANY],
  // Account takeovers by proxy: another impersonation, a reset code, a session or MFA wipe
  [/^\/api\/users\/[^/]+\/(impersonate|password-reset|sessions|mfa)(\/|$)/, ANY],
  // Data leaving the organisation
  [/^\/api\/tenants\/[^/]+\/exports?(\/|$)/, ANY],
];

/** Whether an impersonated request may proceed. */
function isDenied(method, url) {
  const path = String(url || '').split('?')[0];
  return DENIED.some(([re, when]) => re.test(path) && when(method));
}

/**
 * The token for `target` inside `tenantId` with `role`, signed by `impersonator`.
 * @returns {{ token: string, expiresAt: Date }}
 */
function issue({ target, tenantId, role, impersonator }) {
  const expiresIn = ttlMinutes() * 60;
  const token = authSvc.generateAccessToken(
    { id: target.id, email: target.email, role, tenantId },
    { expiresIn, impersonator: { id: impersonator.id, email: impersonator.email } }
  );
  return { token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

module.exports = { ttlMinutes, isDenied, issue, DENIED };
