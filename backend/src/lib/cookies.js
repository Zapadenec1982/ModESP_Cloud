'use strict';

/**
 * The one cookie the backend uses (plan epic 2.9): the refresh token.
 *
 * Reading: Express does not parse Cookie headers by itself and the only
 * cookie we ever look at is this one, so a ten-line parser beats a dependency.
 * Writing goes through res.cookie(), which Express serialises itself.
 *
 * The cookie is httpOnly (no script can read it), SameSite=Strict (no
 * cross-site request carries it) and scoped to /api/auth (no other route ever
 * sees it). `Secure` follows NODE_ENV=production unless COOKIE_SECURE says
 * otherwise — a plain-http LAN install sets COOKIE_SECURE=false.
 */

const REFRESH_COOKIE = 'modesp_rt';
const COOKIE_PATH = '/api/auth';

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

function cookieSecure() {
  const v = process.env.COOKIE_SECURE;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** The refresh token from the request cookie, or null. */
function readRefreshCookie(req) {
  const v = parseCookies(req.headers && req.headers.cookie)[REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function setRefreshCookie(res, token, maxAgeSeconds) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure:   cookieSecure(),
    sameSite: 'strict',
    path:     COOKIE_PATH,
    maxAge:   maxAgeSeconds * 1000,
  });
}

function clearRefreshCookie(res) {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure:   cookieSecure(),
    sameSite: 'strict',
    path:     COOKIE_PATH,
    maxAge:   0,
  });
}

module.exports = { REFRESH_COOKIE, COOKIE_PATH, parseCookies, cookieSecure, readRefreshCookie, setRefreshCookie, clearRefreshCookie };
