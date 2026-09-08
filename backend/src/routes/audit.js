'use strict';

/**
 * Audit log (plan epic 2.13).
 *   GET /audit-log              page of records; an organisation's admin sees
 *                               their own organisation only, a superadmin every
 *                               organisation (tenant_id filter optional)
 *   GET /audit-log/facets       distinct entity types and actions of the scope (last 90 days)
 *   GET /audit-log/export.csv   the same filters as a CSV file (audited as an export)
 */

const { Router } = require('express');
const { z } = require('zod');
const { stringify } = require('csv-stringify');
const db = require('../services/db');

const router = Router();

const EXPORT_MAX_ROWS = 50_000;

const filterSchema = z.object({
  tenant_id:    z.string().uuid().optional(),
  entity_type:  z.string().max(32).optional(),
  action:       z.string().max(64).optional(),
  user_id:      z.string().uuid().optional(),
  user_email:   z.string().trim().max(256).optional(),      // prefix / substring, case-insensitive
  impersonated: z.enum(['true', 'false']).optional(),       // only records made by support as the user
  status:       z.enum(['ok', 'error']).optional(),         // 2xx–3xx | 4xx–5xx
  from:         z.string().datetime({ offset: true }).optional(),
  to:           z.string().datetime({ offset: true }).optional(),
});

const querySchema = filterSchema.extend({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const isSuperadmin = (req) => req.user && req.user.role === 'superadmin';

/** WHERE clause of a request: the organisation is forced for everyone but a superadmin. */
function buildWhere(req, f) {
  const conditions = [];
  const params = [];
  let idx = 1;
  const add = (sql, v) => { conditions.push(sql.replace('?', `$${idx++}`)); params.push(v); };

  if (isSuperadmin(req)) {
    if (f.tenant_id) add('tenant_id = ?', f.tenant_id);
  } else {
    add('tenant_id = ?', req.tenantId);
  }
  if (f.entity_type) add('entity_type = ?', f.entity_type);
  if (f.action)      add('action = ?', f.action);
  if (f.user_id)     add('user_id = ?', f.user_id);
  if (f.user_email)  add('user_email ILIKE ?', `%${f.user_email.replace(/[%_\\]/g, '\\$&')}%`);
  if (f.impersonated === 'true')  conditions.push('impersonator_id IS NOT NULL');
  if (f.impersonated === 'false') conditions.push('impersonator_id IS NULL');
  if (f.status === 'ok')    conditions.push('status_code < 400');
  if (f.status === 'error') conditions.push('status_code >= 400');
  if (f.from) add('created_at >= ?', f.from);
  if (f.to)   add('created_at <= ?', f.to);

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params, idx };
}

const COLUMNS = `id, tenant_id, user_id, user_email, user_role, impersonator_id, impersonator_email,
                 action, entity_type, entity_id, method, endpoint, status_code, ip, user_agent,
                 changes, error, duration_ms, created_at`;

router.get('/', async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten(), status: 400 });
  }
  try {
    const { page, limit, ...filters } = parsed.data;
    const { where, params, idx } = buildWhere(req, filters);
    const offset = (page - 1) * limit;

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM audit_log ${where}`, params),
      db.query(`SELECT ${COLUMNS} FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]),
    ]);

    res.json({
      data: dataResult.rows,
      meta: { total: countResult.rows[0].total, page, limit, scope: isSuperadmin(req) ? 'platform' : 'tenant' },
    });
  } catch (err) {
    next(err);
  }
});

// The dropdowns of the page: what kinds of records this scope has seen lately
router.get('/facets', async (req, res, next) => {
  try {
    const tenantId = isSuperadmin(req) ? (req.query.tenant_id || null) : req.tenantId;
    const params = [];
    let where = `WHERE created_at > now() - interval '90 days'`;
    if (tenantId) { params.push(tenantId); where += ` AND tenant_id = $1`; }
    const [types, actions] = await Promise.all([
      db.query(`SELECT DISTINCT entity_type FROM audit_log ${where} AND entity_type IS NOT NULL ORDER BY 1`, params),
      db.query(`SELECT DISTINCT action FROM audit_log ${where} ORDER BY 1`, params),
    ]);
    res.json({ data: { entity_types: types.rows.map(r => r.entity_type), actions: actions.rows.map(r => r.action) } });
  } catch (err) {
    next(err);
  }
});

// ── GET /audit-log/export.csv ───────────────────────────
// Same filters, no paging, at most EXPORT_MAX_ROWS (newest first). A CSV of
// the audit trail leaving the system is itself an audit event (the middleware
// records every GET …/export.csv).
router.get('/export.csv', async (req, res, next) => {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten(), status: 400 });
  }
  req.auditContext = { action: 'export.audit_csv', changes: { filters: parsed.data } };
  try {
    const { where, params, idx } = buildWhere(req, parsed.data);
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${idx}`,
      [...params, EXPORT_MAX_ROWS]);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${stamp}.csv"`);
    res.setHeader('X-Row-Count', String(rows.length));
    res.write('﻿');   // BOM: Excel opens UTF-8 correctly

    const csv = stringify({
      header: true,
      columns: ['created_at', 'user_email', 'user_role', 'impersonator_email', 'action', 'entity_type', 'entity_id',
                'method', 'endpoint', 'status_code', 'ip', 'changes', 'error', 'duration_ms'],
    });
    csv.pipe(res);
    for (const r of rows) {
      csv.write({
        created_at: new Date(r.created_at).toISOString(),
        user_email: r.user_email || '', user_role: r.user_role || '', impersonator_email: r.impersonator_email || '',
        action: r.action, entity_type: r.entity_type || '', entity_id: r.entity_id || '',
        method: r.method, endpoint: r.endpoint, status_code: r.status_code, ip: r.ip || '',
        changes: r.changes ? JSON.stringify(r.changes) : '', error: r.error || '',
        duration_ms: r.duration_ms == null ? '' : r.duration_ms,
      });
    }
    csv.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
