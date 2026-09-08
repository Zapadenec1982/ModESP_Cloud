'use strict';

/**
 * API keys (plan epic 2.6): machine-to-machine access to one organisation.
 *
 * A key looks like `modesp_<43 url-safe characters>`; only its SHA-256 is
 * stored, the key itself is shown once at creation. It travels in the same
 * `Authorization: Bearer` header as a JWT and the auth middleware tells the
 * two apart by the prefix. The scope maps onto the existing roles — read →
 * viewer, write → technician, admin → admin — so every route keeps its
 * authorisation as it is; what a key can never reach is the account and
 * organisation management surface (auth, profile, users, keys, billing).
 *
 * Keys work while the organisation is open, or closed and read-only; they
 * stop with the plan feature `api`, when revoked, or past `expires_at`.
 */

const crypto = require('crypto');
const db     = require('./db');
const planMw = require('../middleware/plan');

const PREFIX = 'modesp_';
const SCOPES = ['read', 'write', 'admin'];
const ROLE_FOR = { read: 'viewer', write: 'technician', admin: 'admin' };
const KEY_STATUSES = ['trial', 'active', 'past_due', 'closed'];

// Routes an API key may never call, whatever its scope
const DENIED = [
  /^\/api\/auth(\/|$)/, /^\/api\/profile(\/|$)/, /^\/api\/api-keys(\/|$)/, /^\/api\/users(\/|$)/,
  /^\/api\/tenants(\/|$)/, /^\/api\/billing(\/|$)/, /^\/api\/audit-log(\/|$)/, /^\/api\/pilot-requests(\/|$)/,
  /^\/api\/partner(\/|$)/, /^\/api\/onboarding(\/|$)/, /^\/api\/ws-ticket$/,
];

function looksLikeKey(token) { return typeof token === 'string' && token.startsWith(PREFIX); }
function hash(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function generate() { return PREFIX + crypto.randomBytes(32).toString('base64url'); }
function isDeniedPath(url) { const p = String(url || '').split('?')[0]; return DENIED.some(re => re.test(p)); }

const KEY_COLUMNS = 'id, tenant_id, name, prefix, scope, created_by, created_at, last_used_at, expires_at, revoked_at';

async function create({ tenantId, name, scope = 'read', expiresAt = null, createdBy = null }) {
  if (!SCOPES.includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  const key = generate();
  const { rows } = await db.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scope, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${KEY_COLUMNS}`,
    [tenantId, name, key.slice(0, 15), hash(key), scope, expiresAt, createdBy]);
  return { key, row: rows[0] };
}

async function list(tenantId) {
  const { rows } = await db.query(
    `SELECT ${KEY_COLUMNS}, (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows;
}

async function revoke(tenantId, id) {
  const { rows } = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING ${KEY_COLUMNS}`,
    [id, tenantId]);
  return rows[0] || null;
}

/**
 * Resolve a presented key. Throws with code `invalid_key` (unknown, revoked,
 * expired, organisation suspended) or `api_disabled` (plan without `api`).
 */
async function authenticate(key) {
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const { rows } = await db.query(
    `SELECT k.id, k.tenant_id, k.name, k.scope, k.expires_at, k.revoked_at, t.status AS tenant_status
       FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = $1`, [hash(key)]);
  const k = rows[0];
  if (!k || k.revoked_at) fail('invalid_key', 'Invalid API key');
  if (k.expires_at && new Date(k.expires_at) <= new Date()) fail('invalid_key', 'API key expired');
  if (!KEY_STATUSES.includes(k.tenant_status)) fail('invalid_key', 'Organisation is suspended');
  if (!await planMw.hasFeature(k.tenant_id, 'api')) fail('api_disabled', 'API access is not included in the organisation plan');
  db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [k.id])
    .catch(() => {});
  return { id: k.id, tenantId: k.tenant_id, name: k.name, scope: k.scope, role: ROLE_FOR[k.scope] };
}

module.exports = { PREFIX, SCOPES, ROLE_FOR, looksLikeKey, isDeniedPath, generate, hash, create, list, revoke, authenticate };
