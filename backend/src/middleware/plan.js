'use strict';

/**
 * Plan enforcement (plan epic 1.8).
 *
 * plan_limits says what an organisation's plan allows; this module answers
 * "may this organisation add one more device / user / site?" and "does the
 * plan include feature X?". Limits are looked up per organisation and cached
 * for a minute — a plan change shows up on the next request, not the next
 * restart. A refused request is a 402 with the limit, the current usage and
 * the plan, so the WebUI can show "plan limit reached" with an upgrade link.
 *
 * Superadmins are not exempt from capacity limits (a device assigned into an
 * organisation counts against that organisation whoever assigns it) but they
 * bypass feature gates: the platform operator may always look at everything.
 */

const db = require('../services/db');

const CACHE_MS = 60_000;
const cache = new Map();   // tenantId → { at, limits }

const RESOURCE_SQL = {
  devices: `SELECT COUNT(*)::int AS n FROM devices WHERE tenant_id = $1 AND status = 'active'`,
  users:   `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND active = true`,
  sites:   `SELECT COUNT(*)::int AS n FROM sites WHERE tenant_id = $1`,
};
const LIMIT_COLUMN = { devices: 'max_devices', users: 'max_users', sites: 'max_sites' };

async function getPlanLimits(tenantId, { fresh = false } = {}) {
  const hit = cache.get(tenantId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.limits;
  const { rows } = await db.query(
    `SELECT t.plan, t.status, p.name AS plan_name, p.max_devices, p.max_sites, p.max_users,
            p.retention_days, p.sampling_sec, p.features
       FROM tenants t LEFT JOIN plan_limits p ON p.plan = t.plan
      WHERE t.id = $1`,
    [tenantId]
  );
  const limits = rows[0] || null;
  cache.set(tenantId, { at: Date.now(), limits });
  return limits;
}

function invalidate(tenantId) {
  if (tenantId) cache.delete(tenantId); else cache.clear();
}

/**
 * @param {string} tenantId
 * @param {'devices'|'users'|'sites'} resource
 * @param {number} [adding=1] how many the caller wants to add
 * @returns {Promise<{ok:boolean, limit:number|null, current:number, plan:string, resource:string}>}
 */
async function checkCapacity(tenantId, resource, adding = 1) {
  if (!RESOURCE_SQL[resource]) throw new Error(`Unknown plan resource: ${resource}`);
  const limits = await getPlanLimits(tenantId);
  const { rows } = await db.query(RESOURCE_SQL[resource], [tenantId]);
  const current = rows[0].n;
  const limit = limits ? limits[LIMIT_COLUMN[resource]] : null;
  const plan = limits ? limits.plan : null;
  if (limit === null || limit === undefined) return { ok: true, limit: null, current, plan, resource };
  return { ok: current + adding <= limit, limit, current, plan, resource };
}

function planLimitResponse(res, cap) {
  return res.status(402).json({
    error:    'plan_limit',
    message:  `Plan "${cap.plan}" allows ${cap.limit} ${cap.resource}; ${cap.current} in use. Ask for an upgrade.`,
    status:   402,
    resource: cap.resource,
    limit:    cap.limit,
    current:  cap.current,
    plan:     cap.plan,
  });
}

async function hasFeature(tenantId, feature) {
  const limits = await getPlanLimits(tenantId);
  if (!limits) return false;
  const features = Array.isArray(limits.features) ? limits.features : [];
  return features.includes(feature);
}

/**
 * Express middleware: the caller's organisation (req.tenantId) must have the
 * feature on its plan. Superadmins pass.
 */
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      if (!req.user || req.user.role === 'superadmin' || !req.tenantId) return next();
      if (await hasFeature(req.tenantId, feature)) return next();
      const limits = await getPlanLimits(req.tenantId);
      res.status(402).json({
        error:   'plan_feature',
        message: `Feature "${feature}" is not included in plan "${limits ? limits.plan : 'unknown'}". Ask for an upgrade.`,
        status:  402,
        feature,
        plan:    limits ? limits.plan : null,
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { getPlanLimits, checkCapacity, planLimitResponse, hasFeature, requireFeature, invalidate };
