'use strict';

/**
 * Sessions (plan epic 2.9).
 *
 * A session is a family of refresh tokens: login opens the family, every
 * refresh rotates the token inside it, logout or a revocation on the Sessions
 * page closes it. The access JWT carries the family id as `sid`, so a request
 * knows which session it belongs to without a database read.
 *
 * Refresh-token delivery
 *   Browser: httpOnly cookie on /api/auth (lib/cookies.js). The body of every
 *            answer that opens or rotates a session also carries `csrf_token`;
 *            a refresh or logout driven by the cookie must send it back as the
 *            X-CSRF-Token header. The token is HMAC(JWT_SECRET, hash of the
 *            refresh token), so nothing has to be stored for it and it is
 *            worthless without the cookie it pairs with.
 *   Other clients (scripts, apps): `refresh_token` in the body, as before;
 *            the CSRF header is not required — there is no cookie to forge.
 *
 * Reuse detection: a refresh token is single-use. A revoked one presented
 * again is the signature of a stolen chain, so the whole family is revoked and
 * the caller gets `token_reused`.
 */

const crypto  = require('crypto');
const db      = require('./db');
const authSvc = require('./auth');
const cookies = require('../lib/cookies');

const CSRF_HEADER = 'x-csrf-token';

function refreshTtlSeconds() {
  return parseInt(process.env.JWT_REFRESH_EXPIRES_IN, 10) || 2_592_000;
}

/** Deterministic CSRF token for one refresh token: nothing stored, nothing guessable without the cookie. */
function csrfFor(tokenHash) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(`csrf:${tokenHash}`).digest('hex');
}

function csrfMatches(tokenHash, presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(csrfFor(tokenHash), 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientInfo(req) {
  if (!req) return { userAgent: null, ip: null };
  const ua = (req.headers && req.headers['user-agent']) || null;
  return { userAgent: ua ? String(ua).slice(0, 256) : null, ip: req.ip || null };
}

/**
 * Open a session (new family) or continue one (familyId given): a refresh
 * token row plus the access token for `tenantId` with `role`.
 */
async function issue({ user, role, tenantId, req, familyId = null, client = db }) {
  const refreshToken = authSvc.generateRefreshToken();
  const tokenHash    = authSvc.hashRefreshToken(refreshToken);
  const expiresAt    = new Date(Date.now() + refreshTtlSeconds() * 1000);
  const { userAgent, ip } = clientInfo(req);
  const { rows } = await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, tenant_id, family_id, user_agent, ip, last_used_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::uuid, gen_random_uuid()), $6, $7, now())
     RETURNING family_id`,
    [user.id, tokenHash, expiresAt, tenantId, familyId, userAgent, ip]);
  const sid = rows[0].family_id;
  const accessToken = authSvc.generateAccessToken({ id: user.id, email: user.email, role, tenantId, sid });
  return { accessToken, refreshToken, csrfToken: csrfFor(tokenHash), role, familyId: sid, expiresAt };
}

/**
 * Look a presented refresh token up. Resolves the row (with the user's
 * account fields joined) or throws with code `invalid_token` /
 * `token_reused` / `token_expired`.
 */
async function lookup(refreshToken) {
  const tokenHash = authSvc.hashRefreshToken(refreshToken);
  const { rows } = await db.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked, rt.family_id,
            COALESCE(rt.tenant_id, u.tenant_id) AS tenant_id,
            u.email, u.role, u.active, u.locale, u.timezone, t.status AS tenant_status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       LEFT JOIN tenants t ON t.id = COALESCE(rt.tenant_id, u.tenant_id)
      WHERE rt.token_hash = $1`,
    [tokenHash]);
  const row = rows[0];
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  if (!row) fail('invalid_token', 'Invalid refresh token');
  if (row.revoked) {
    // Single-use token seen twice: the chain is compromised, close it.
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND family_id = $2', [row.user_id, row.family_id]);
    fail('token_reused', 'Refresh token was already used — the session has been closed');
  }
  if (new Date(row.expires_at) < new Date()) fail('token_expired', 'Refresh token expired');
  return { ...row, tokenHash };
}

/** Retire the presented token (rotation): the next one is issued in the same family by the caller. */
async function retire(row) {
  await db.query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [row.id]);
}

/** Close the family a refresh token belongs to (logout). Resolves the row, or null for an unknown token. */
async function revokeByToken(refreshToken) {
  const tokenHash = authSvc.hashRefreshToken(refreshToken);
  const { rows } = await db.query(
    `UPDATE refresh_tokens SET revoked = true
      WHERE (user_id, family_id) IN (SELECT user_id, family_id FROM refresh_tokens WHERE token_hash = $1)
      RETURNING user_id, tenant_id, family_id`,
    [tokenHash]);
  return rows[0] || null;
}

async function revokeFamily(userId, familyId) {
  const { rowCount } = await db.query(
    'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND family_id = $2 AND revoked = false',
    [userId, familyId]);
  return rowCount;
}

/** Every session of the user except `keepFamilyId` (null keeps none). Resolves the number of sessions closed. */
async function revokeAll(userId, keepFamilyId = null) {
  const { rows } = await db.query(
    `UPDATE refresh_tokens SET revoked = true
      WHERE user_id = $1 AND revoked = false AND expires_at > now() AND ($2::uuid IS NULL OR family_id <> $2::uuid)
      RETURNING family_id`,
    [userId, keepFamilyId]);
  return new Set(rows.map(r => r.family_id)).size;
}

/** Open sessions of a user, one row per family, newest activity first. */
async function list(userId, currentFamilyId = null) {
  const { rows } = await db.query(
    `SELECT rt.family_id AS id, MIN(rt.created_at) AS created_at, MAX(rt.last_used_at) AS last_used_at,
            MAX(rt.expires_at) AS expires_at,
            (array_agg(rt.user_agent ORDER BY rt.created_at DESC) FILTER (WHERE rt.user_agent IS NOT NULL))[1] AS user_agent,
            (array_agg(host(rt.ip) ORDER BY rt.created_at DESC) FILTER (WHERE rt.ip IS NOT NULL))[1] AS ip,
            (array_agg(rt.tenant_id ORDER BY rt.created_at DESC))[1] AS tenant_id,
            (array_agg(t.name ORDER BY rt.created_at DESC))[1] AS tenant_name
       FROM refresh_tokens rt
       LEFT JOIN tenants t ON t.id = rt.tenant_id
      WHERE rt.user_id = $1
      GROUP BY rt.family_id
     HAVING bool_or(rt.revoked = false AND rt.expires_at > now())
      ORDER BY MAX(rt.last_used_at) DESC NULLS LAST, MIN(rt.created_at) DESC`,
    [userId]);
  return rows.map(r => ({ ...r, current: !!currentFamilyId && r.id === currentFamilyId }));
}

// ── HTTP glue ────────────────────────────────────────────

/**
 * The refresh token of a request: body first (API clients), else the cookie —
 * and a cookie-driven request must carry the matching CSRF header.
 * Resolves { token, fromCookie } or throws with code `csrf_required`.
 */
function presentedToken(req) {
  const fromBody = req.body && typeof req.body.refresh_token === 'string' && req.body.refresh_token ? req.body.refresh_token : null;
  if (fromBody) return { token: fromBody, fromCookie: false };
  const fromCookie = cookies.readRefreshCookie(req);
  if (!fromCookie) return { token: null, fromCookie: false };
  const tokenHash = authSvc.hashRefreshToken(fromCookie);
  if (!csrfMatches(tokenHash, req.headers[CSRF_HEADER])) {
    const e = new Error('Missing or invalid CSRF token'); e.code = 'csrf_required'; throw e;
  }
  return { token: fromCookie, fromCookie: true };
}

/** Put the refresh token in the cookie and the CSRF token in the body. */
function attach(res, session, body) {
  cookies.setRefreshCookie(res, session.refreshToken, refreshTtlSeconds());
  return { ...body, refresh_token: session.refreshToken, csrf_token: session.csrfToken };
}

function detach(res) {
  cookies.clearRefreshCookie(res);
}

module.exports = {
  CSRF_HEADER, refreshTtlSeconds, csrfFor, csrfMatches,
  issue, lookup, retire, revokeByToken, revokeFamily, revokeAll, list,
  presentedToken, attach, detach,
};
