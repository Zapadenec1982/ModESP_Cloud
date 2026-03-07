'use strict';

const { SYSTEM_TENANT_ID } = require('../services/db');

/**
 * Dev-mode tenant middleware.
 *
 * Reads X-Tenant-ID header (UUID), defaults to SYSTEM_TENANT_ID.
 * Phase 4 will replace this with JWT-based tenant extraction.
 */
function tenant(req, _res, next) {
  req.tenantId = req.headers['x-tenant-id'] || SYSTEM_TENANT_ID;
  next();
}

module.exports = tenant;
