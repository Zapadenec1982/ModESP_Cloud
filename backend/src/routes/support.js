'use strict';

/**
 * Support requests (plan epic 2.13): the "Support" link of the sidebar.
 *   GET   /support/info           where to reach support (e-mail, Telegram) — any role
 *   POST  /support/requests       file a request — any role; stored first, mailed second
 *   GET   /support/requests       superadmin: every organisation (filters); admin: own
 *                                 organisation; others: their own requests
 *   PATCH /support/requests/:id   superadmin: status new | open | closed
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const emailSvc   = require('../services/email');

const router = Router();

const CATEGORIES = ['question', 'problem', 'billing', 'feature', 'other'];
const STATUSES   = ['new', 'open', 'closed'];

const createSchema = z.object({
  category: z.enum(CATEGORIES).default('question'),
  subject:  z.string().trim().min(3).max(160),
  message:  z.string().trim().min(10).max(5000),
  context:  z.object({
    page:        z.string().max(256).optional(),
    device_id:   z.string().max(64).optional(),
    user_agent:  z.string().max(512).optional(),
    app_version: z.string().max(32).optional(),
    locale:      z.string().max(8).optional(),
    timezone:    z.string().max(64).optional(),
  }).strict().optional(),
});

const listSchema = z.object({
  status:    z.enum(STATUSES).optional(),
  tenant_id: z.string().uuid().optional(),
  limit:     z.coerce.number().int().min(1).max(200).default(50),
});

const patchSchema = z.object({ status: z.enum(STATUSES) });

/** Where a request goes: SUPPORT_EMAIL, else the platform's reply-to, else the registration inbox. */
function supportAddress() {
  return process.env.SUPPORT_EMAIL || process.env.EMAIL_REPLY_TO || process.env.REGISTRATION_NOTIFY_EMAIL || process.env.PILOT_REQUEST_EMAIL || null;
}

const COLUMNS = `r.id, r.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, r.user_id, r.user_email, r.user_role,
                 r.category, r.subject, r.message, r.context, r.status, r.emailed_at, r.closed_at, r.created_at, r.updated_at`;

const isSuperadmin = (req) => req.user && req.user.role === 'superadmin';
const isAdmin = (req) => req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');

router.get('/info', (_req, res) => {
  const email = supportAddress();
  res.json({
    data: {
      email:    email || null,
      telegram: process.env.SUPPORT_TELEGRAM || null,
      docs_url: process.env.SUPPORT_DOCS_URL || null,
    },
  });
});

router.post('/requests', async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const { category, subject, message } = parsed.data;
    const context = { ...(parsed.data.context || {}) };
    // A request filed by support signed in as the user says so
    if (req.user.impersonator) context.impersonated_by = req.user.impersonator.email;

    const { rows: tRows } = await db.query('SELECT id, name, slug, plan, status FROM tenants WHERE id = $1', [req.tenantId]);
    const tenant = tRows[0];
    if (!tenant) return res.status(400).json({ error: 'tenant_not_found', message: 'Organisation not found', status: 400 });

    const { rows } = await db.query(
      `INSERT INTO support_requests (tenant_id, user_id, user_email, user_role, category, subject, message, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [req.tenantId, req.user.id, req.user.email, req.user.role, category, subject, message,
       Object.keys(context).length ? JSON.stringify(context) : null]);
    const created = rows[0];

    let emailed = false;
    const to = supportAddress();
    if (to) {
      try {
        emailed = await emailSvc.sendSupportRequest({
          to,
          request: { id: created.id, created_at: created.created_at, category, subject, message, context,
                     user_email: req.user.email, user_role: req.user.role },
          tenant,
        });
        if (emailed) await db.query('UPDATE support_requests SET emailed_at = now() WHERE id = $1', [created.id]);
      } catch (err) {
        req.log?.warn?.({ err, id: created.id }, 'Support request e-mail failed');
      }
    }

    req.auditContext = { entityId: created.id, action: 'support.request', changes: { category, subject } };
    res.status(201).json({ data: { id: created.id, created_at: created.created_at, status: 'new', category, subject, emailed } });
  } catch (err) {
    next(err);
  }
});

router.get('/requests', async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten(), status: 400 });
  }
  try {
    const { status, tenant_id, limit } = parsed.data;
    const conditions = [];
    const params = [];
    const add = (sql, v) => { params.push(v); conditions.push(sql.replace('?', `$${params.length}`)); };

    if (isSuperadmin(req)) {
      if (tenant_id) add('r.tenant_id = ?', tenant_id);
    } else if (isAdmin(req)) {
      add('r.tenant_id = ?', req.tenantId);
    } else {
      add('r.tenant_id = ?', req.tenantId);
      add('r.user_id = ?', req.user.id);
    }
    if (status) add('r.status = ?', status);
    params.push(limit);

    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM support_requests r JOIN tenants t ON t.id = r.tenant_id
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
    const { rows: counts } = isSuperadmin(req)
      ? await db.query(`SELECT status, COUNT(*)::int AS n FROM support_requests GROUP BY status`)
      : { rows: [] };
    res.json({ data: rows, meta: { open: counts.reduce((a, r) => a + (r.status === 'closed' ? 0 : r.n), 0) } });
  } catch (err) {
    next(err);
  }
});

router.patch('/requests/:id', async (req, res, next) => {
  if (!isSuperadmin(req)) {
    return res.status(403).json({ error: 'forbidden', message: 'Superadmin access required', status: 403 });
  }
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const { status } = parsed.data;
    const { rows } = await db.query(
      `UPDATE support_requests r
          SET status = $2::text, closed_at = CASE WHEN $2::text = 'closed' THEN now() ELSE NULL END, updated_at = now()
        WHERE id = $1
        RETURNING id, status, closed_at, updated_at`,
      [req.params.id, status]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'Request not found', status: 404 });
    req.auditContext = { entityId: req.params.id, action: 'support.status', changes: { status } };
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
