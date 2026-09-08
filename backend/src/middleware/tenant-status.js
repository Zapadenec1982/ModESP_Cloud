'use strict';

/**
 * A closed organisation is read-only (plan epic 2.10): for CLOSED_RETENTION_DAYS
 * its people can still sign in, look at everything and take their data out,
 * but nothing changes any more. Reads pass; so do the auth routes, the own
 * profile, and the data-export endpoints; a superadmin is never held back
 * (they reopen organisations through the same API).
 */

const planMw = require('./plan');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/profile(\/|$)/,
  /^\/api\/ws-ticket$/,
  /^\/api\/tenants\/[^/]+\/exports?(\/|$)/,
];

function readOnlyWhenClosed() {
  return async (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || !req.tenantId || !req.user || req.user.role === 'superadmin') return next();
    const url = String(req.originalUrl || req.url || '').split('?')[0];
    if (ALLOWED.some(re => re.test(url))) return next();
    try {
      const limits = await planMw.getPlanLimits(req.tenantId);
      if (limits && limits.status === 'closed') {
        return res.status(423).json({
          error: 'organisation_closed',
          message: 'This organisation is closed: its data can be read and exported, but not changed',
          status: 423,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { readOnlyWhenClosed };
