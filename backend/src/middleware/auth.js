'use strict';

const { verifyAccessToken } = require('../services/auth');
const apiKeys = require('../services/api-keys');

/**
 * JWT authentication middleware.
 * Extracts "Bearer <token>" from Authorization header,
 * verifies it, and sets req.user + req.tenantId.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid Authorization header',
      status: 401,
    });
  }

  const token = header.slice(7);

  // An API key (plan epic 2.6): the organisation's machine identity, scoped
  // onto a role; the account and organisation surface is out of its reach.
  if (apiKeys.looksLikeKey(token)) {
    return apiKeys.authenticate(token).then((k) => {
      if (apiKeys.isDeniedPath(req.originalUrl || req.url)) {
        return res.status(403).json({ error: 'api_key_scope', message: 'This endpoint is not available to API keys', status: 403 });
      }
      req.user = { id: null, email: `apikey:${k.name}`, role: k.role, tenantId: k.tenantId, sid: null, apiKey: { id: k.id, name: k.name, scope: k.scope } };
      req.tenantId = k.tenantId;
      next();
    }).catch((err) => {
      if (err.code === 'api_disabled') return res.status(402).json({ error: 'plan_feature', message: err.message, status: 402, feature: 'api' });
      if (err.code === 'invalid_key') return res.status(401).json({ error: 'unauthorized', message: err.message, status: 401 });
      next(err);
    });
  }

  try {
    const payload = verifyAccessToken(token);
    // Block pending tokens (tenant selection flow) from accessing API routes
    if (payload.pending) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Tenant selection required',
        status: 401,
      });
    }
    // …and the token that only carries a login to its second factor (plan epic 2.9)
    if (payload.mfa) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Second factor required',
        status: 401,
      });
    }
    req.user = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      tenantId: payload.tenantId,
      sid:      payload.sid || null,   // the session the token belongs to (plan epic 2.9)
    };
    req.tenantId = payload.tenantId;
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({
      error: 'unauthorized',
      message,
      status: 401,
    });
  }
}

/**
 * Role-based authorization middleware factory.
 * superadmin inherits all admin permissions automatically.
 * @param {...string} roles - Allowed roles (e.g. 'admin', 'technician')
 * @returns {function} Express middleware
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Insufficient permissions',
        status: 403,
      });
    }
    // superadmin inherits admin permissions
    const effectiveRole = req.user.role === 'superadmin' ? 'admin' : req.user.role;
    if (!roles.includes(req.user.role) && !roles.includes(effectiveRole)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Insufficient permissions',
        status: 403,
      });
    }
    next();
  };
}

/**
 * Require superadmin role. Returns 403 for any other role.
 */
function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Superadmin access required',
      status: 403,
    });
  }
  next();
}

module.exports = { authenticate, authorize, requireSuperadmin };
