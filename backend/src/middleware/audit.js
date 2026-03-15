'use strict';

const db = require('../services/db');

const SKIP_METHODS = new Set(['GET', 'OPTIONS', 'HEAD']);
const SKIP_AUTH_PATHS = new Set(['/refresh', '/select-tenant', '/switch-tenant']);

/**
 * Auto-audit middleware for mutation endpoints.
 * Mount BEFORE authenticate so login/logout are captured too.
 */
function createAuditMiddleware(logger) {
  return function auditMiddleware(req, res, next) {
    if (SKIP_METHODS.has(req.method)) return next();

    // Skip noisy auth paths but audit login/logout
    const subPath = req.path;
    if (req.baseUrl === '/api/auth' && SKIP_AUTH_PATHS.has(subPath)) return next();

    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;

      try {
        const { action, entityType, entityId } = deriveAction(req);
        const user = req.user || {};
        const auditCtx = req.auditContext || {};

        const record = {
          tenant_id: user.tenantId || req.tenantId || null,
          user_id: user.id || null,
          user_email: user.email || tryExtractEmail(req),
          user_role: user.role || null,
          action: auditCtx.action || action,
          entity_type: entityType,
          entity_id: auditCtx.entityId || entityId || null,
          method: req.method,
          endpoint: req.originalUrl.split('?')[0].substring(0, 256),
          status_code: res.statusCode,
          ip: req.ip || req.connection?.remoteAddress || null,
          user_agent: (req.headers['user-agent'] || '').substring(0, 512) || null,
          changes: auditCtx.changes || null,
          error: res.statusCode >= 400 ? (res.statusMessage || null) : null,
          duration_ms: duration,
        };

        // Fire-and-forget INSERT
        insertAuditLog(record).catch(err => {
          if (logger) logger.error({ err, record }, 'audit insert failed');
        });
      } catch (err) {
        if (logger) logger.error({ err }, 'audit middleware error');
      }
    });

    next();
  };
}

function deriveAction(req) {
  const methodMap = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
  const verb = methodMap[req.method] || req.method.toLowerCase();

  // Use req.route if available (matched route), otherwise parse originalUrl
  let basePath = req.baseUrl || '';
  let routePath = req.route?.path || '';

  // Extract entity type from base URL: /api/devices -> devices -> device
  const baseSegments = basePath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  let entityType = baseSegments[0] || 'unknown';

  // Singularize simple cases
  if (entityType.endsWith('s') && entityType !== 'status') {
    entityType = entityType.slice(0, -1);
  }

  // Handle auth routes specially
  if (entityType === 'auth') {
    const authAction = routePath.replace(/^\//, '') || req.path.replace(/^\//, '');
    return { action: `auth.${authAction}`, entityType: 'auth', entityId: null };
  }

  // Extract entity ID from route params
  let entityId = req.params?.id || null;

  // Handle sub-resources: /devices/:id/command -> device.command
  let action = `${entityType}.${verb}`;
  if (routePath && routePath !== '/' && routePath !== '/:id') {
    const sub = routePath.replace(/^\/:id\//, '').replace(/^\//, '').replace(/-/g, '_');
    if (sub && sub !== ':id') {
      action = `${entityType}.${sub}`;
    }
  }

  // Fallback when req.route is undefined (404 or unmatched)
  if (!req.route) {
    const urlPath = req.originalUrl.split('?')[0];
    const segments = urlPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    entityType = segments[0] || 'unknown';
    if (entityType.endsWith('s') && entityType !== 'status') {
      entityType = entityType.slice(0, -1);
    }
    action = `${entityType}.${verb}`;
    entityId = segments[1] || null;
  }

  return { action, entityType, entityId };
}

function tryExtractEmail(req) {
  // For login attempts, capture the email from body
  if (req.body?.email) return req.body.email;
  return null;
}

async function insertAuditLog(record) {
  const sql = `
    INSERT INTO audit_log (
      tenant_id, user_id, user_email, user_role, action, entity_type, entity_id,
      method, endpoint, status_code, ip, user_agent, changes, error, duration_ms
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `;
  const vals = [
    record.tenant_id, record.user_id, record.user_email, record.user_role,
    record.action, record.entity_type, record.entity_id,
    record.method, record.endpoint, record.status_code,
    record.ip, record.user_agent,
    record.changes ? JSON.stringify(record.changes) : null,
    record.error, record.duration_ms,
  ];
  await db.query(sql, vals);
}

module.exports = createAuditMiddleware;
