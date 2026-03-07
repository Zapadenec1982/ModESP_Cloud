'use strict';

const { verifyAccessToken } = require('../services/auth');

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
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      tenantId: payload.tenantId,
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
 * @param {...string} roles - Allowed roles (e.g. 'admin', 'technician')
 * @returns {function} Express middleware
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Insufficient permissions',
        status: 403,
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
