'use strict';

/**
 * Partner plan (plan epic 2.5) — a service company that runs its clients'
 * organisations. Mounted at /api/partner behind authenticate; every route needs
 * the `partner` plan feature on the caller's CURRENT organisation and the admin
 * role there (a partner's technician who is admin at a client is not a partner
 * admin — the role is the one held at the partner).
 *
 *   GET    /api/partner/overview                 totals + recent alarms, open orders, hints across clients
 *   GET    /api/partner/clients                  client organisations with counts
 *   POST   /api/partner/clients                  create a client organisation (the caller becomes its admin)
 *   PATCH  /api/partner/clients/:id              rename / change plan of a client
 *   GET    /api/partner/clients/:id/members      who is in the client (partner staff flagged)
 *   POST   /api/partner/clients/:id/members      put a member of the partner into the client with a role
 *   DELETE /api/partner/clients/:id/members/:uid take partner staff out of the client
 *   GET    /api/partner/sites                    every client site with coordinates and counts (cross-tenant map)
 *
 * Isolation: every statement carries `parent_tenant_id = <partner>`; partner A
 * never sees partner B's clients, and a client never sees its partner's other
 * clients — a client's admin has no `partner` feature and gets 402 here.
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const planMw     = require('../middleware/plan');
const { authorize } = require('../middleware/auth');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) => AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

const router = Router();
router.use(planMw.requireFeature('partner'), maybeAuthorize('admin'));

const CLIENT_PLANS = ['free', 'basic', 'pro'];
const RESERVED_SLUGS = new Set(['__system__', 'pending', 'system', 'admin', 'api']);

function partnerId(req) { return req.tenantId; }
function userId(req)    { return req.user ? req.user.id : null; }
function bad(res, message, status = 400, error = 'validation_failed') {
  return res.status(status).json({ error, message, status });
}

const CLIENT_COLUMNS = `
  t.id, t.name, t.slug, t.plan, t.status, t.active, t.created_at, t.trial_expires_at,
  p.name AS plan_name, p.max_devices,
  (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL) AS device_count,
  (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL AND d.online = true) AS online_count,
  (SELECT COUNT(*)::int FROM sites s WHERE s.tenant_id = t.id) AS site_count,
  (SELECT COUNT(*)::int FROM user_tenants ut WHERE ut.tenant_id = t.id) AS member_count,
  (SELECT COUNT(*)::int FROM alarms a WHERE a.tenant_id = t.id AND a.active = true) AS active_alarms,
  (SELECT COUNT(*)::int FROM alarms a WHERE a.tenant_id = t.id AND a.active = true AND a.severity = 'critical') AS critical_alarms,
  (SELECT COUNT(*)::int FROM work_orders w WHERE w.tenant_id = t.id AND w.status IN ('new', 'assigned', 'in_progress')) AS open_orders,
  (SELECT COUNT(*)::int FROM maintenance_hints h WHERE h.tenant_id = t.id AND h.closed_at IS NULL) AS open_hints,
  (SELECT ut.role FROM user_tenants ut WHERE ut.tenant_id = t.id AND ut.user_id = $2) AS my_role`;

async function loadClient(req, id) {
  const { rows } = await db.query(
    `SELECT ${CLIENT_COLUMNS} FROM tenants t LEFT JOIN plan_limits p ON p.plan = t.plan
      WHERE t.id = $1 AND t.parent_tenant_id = $3`,
    [id, userId(req), partnerId(req)]
  );
  return rows[0] || null;
}

// ── GET /partner/clients ──────────────────────────────────
router.get('/clients', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${CLIENT_COLUMNS} FROM tenants t LEFT JOIN plan_limits p ON p.plan = t.plan
        WHERE t.parent_tenant_id = $1 ORDER BY t.name`,
      [partnerId(req), userId(req)]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /partner/clients ─────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1).max(128).trim(),
  slug: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'Slug must be lowercase alphanumeric with hyphens/underscores'),
  plan: z.enum(CLIENT_PLANS).default('basic'),
});

/** The partner's billing account — created from its billing identity on first use. */
async function partnerBillingAccount(client, partnerTenantId) {
  const { rows } = await client.query(
    'SELECT id, name, legal_name, tax_id, billing_email, billing_currency, billing_account_id FROM tenants WHERE id = $1',
    [partnerTenantId]);
  const t = rows[0];
  if (t.billing_account_id) return t.billing_account_id;
  const { rows: acc } = await client.query(
    `INSERT INTO billing_accounts (legal_name, tax_id, email, currency, is_partner)
     VALUES ($1, $2, $3, COALESCE($4, 'UAH'), true) RETURNING id`,
    [t.legal_name || t.name, t.tax_id || null, t.billing_email || null, t.billing_currency || null]);
  await client.query('UPDATE tenants SET billing_account_id = $2 WHERE id = $1', [partnerTenantId, acc[0].id]);
  return acc[0].id;
}

router.post('/clients', async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  const { name, slug, plan } = parsed.data;
  if (RESERVED_SLUGS.has(slug)) return bad(res, `Slug "${slug}" is reserved`);
  try {
    const created = await db.transaction(async (client) => {
      const accountId = await partnerBillingAccount(client, partnerId(req));
      const { rows } = await client.query(
        `INSERT INTO tenants (name, slug, plan, status, parent_tenant_id, billing_account_id)
         VALUES ($1, $2, $3, 'active', $4, $5)
         RETURNING id, name, slug, plan, status, parent_tenant_id, billing_account_id, created_at`,
        [name, slug, plan, partnerId(req), accountId]);
      // The organisation inherits the partner's language and time zone
      await client.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, locale)
         SELECT $1, s.timezone, s.locale FROM tenant_settings s WHERE s.tenant_id = $2
         ON CONFLICT (tenant_id) DO NOTHING`,
        [rows[0].id, partnerId(req)]);
      // The creator runs the client from day one
      if (userId(req)) {
        await client.query(
          `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
          [userId(req), rows[0].id]);
      }
      return rows[0];
    });
    req.auditContext = { entityId: created.id, action: 'partner.client_create', changes: { name, slug, plan, partner_tenant_id: partnerId(req) } };
    await mqttSvc.refreshRegistries();
    res.status(201).json({ data: await loadClient(req, created.id) });
  } catch (err) {
    if (err.code === '23505' && err.constraint && err.constraint.includes('slug')) {
      return bad(res, 'A tenant with this slug already exists', 409, 'conflict');
    }
    next(err);
  }
});

// ── PATCH /partner/clients/:id ────────────────────────────
const patchSchema = z.object({
  name: z.string().min(1).max(128).trim().optional(),
  plan: z.enum(CLIENT_PLANS).optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' });

router.patch('/clients/:id', async (req, res, next) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const before = await loadClient(req, req.params.id);
    if (!before) return bad(res, 'Client not found', 404, 'not_found');
    const d = parsed.data;
    const sets = [], params = [];
    if (d.name !== undefined) { params.push(d.name); sets.push(`name = $${params.length}`); }
    if (d.plan !== undefined) { params.push(d.plan); sets.push(`plan = $${params.length}`); }
    params.push(req.params.id, partnerId(req));
    await db.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND parent_tenant_id = $${params.length}`, params);
    planMw.invalidate(req.params.id);
    if (d.plan !== undefined && d.plan !== before.plan) {
      await db.query('UPDATE tenant_settings SET raw_retention_days = NULL WHERE tenant_id = $1', [req.params.id]);
    }
    req.auditContext = { entityId: req.params.id, action: 'partner.client_update', changes: { before: { name: before.name, plan: before.plan }, after: d } };
    await mqttSvc.refreshRegistries();
    res.json({ data: await loadClient(req, req.params.id) });
  } catch (err) { next(err); }
});

// ── Members ───────────────────────────────────────────────
router.get('/clients/:id/members', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id);
    if (!client) return bad(res, 'Client not found', 404, 'not_found');
    const { rows } = await db.query(
      `SELECT u.id, u.email, ut.role, u.active, (u.tenant_id = $2) AS partner_staff, ut.created_at
         FROM user_tenants ut JOIN users u ON u.id = ut.user_id
        WHERE ut.tenant_id = $1 AND u.role <> 'superadmin'
        ORDER BY partner_staff DESC, u.email`,
      [req.params.id, partnerId(req)]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

const memberSchema = z.object({
  user_id: z.string().uuid(),
  role:    z.enum(['admin', 'technician', 'viewer']).default('technician'),
});

router.post('/clients/:id/members', async (req, res, next) => {
  const parsed = memberSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const client = await loadClient(req, req.params.id);
    if (!client) return bad(res, 'Client not found', 404, 'not_found');
    // Only the partner's own people can be placed: a member of the partner
    // organisation whose home is the partner (clients' staff are theirs).
    const { rows: staff } = await db.query(
      `SELECT u.id FROM users u JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $2
        WHERE u.id = $1 AND u.tenant_id = $2 AND u.active = true AND u.role <> 'superadmin'`,
      [parsed.data.user_id, partnerId(req)]
    );
    if (staff.length === 0) return bad(res, 'user_id must be an active member of the partner organisation');
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [parsed.data.user_id, req.params.id, parsed.data.role]
    );
    req.auditContext = { entityId: req.params.id, action: 'partner.member_add', changes: parsed.data };
    res.status(201).json({ data: { client_id: req.params.id, ...parsed.data } });
  } catch (err) { next(err); }
});

router.delete('/clients/:id/members/:userId', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id);
    if (!client) return bad(res, 'Client not found', 404, 'not_found');
    // Partner staff only; the client's own users are the client's business.
    const { rowCount } = await db.query(
      `DELETE FROM user_tenants ut USING users u
        WHERE ut.user_id = u.id AND ut.user_id = $1 AND ut.tenant_id = $2 AND u.tenant_id = $3`,
      [req.params.userId, req.params.id, partnerId(req)]
    );
    if (rowCount === 0) return bad(res, 'Not a partner member of this client', 404, 'not_found');
    await db.query('DELETE FROM user_sites WHERE user_id = $1 AND tenant_id = $2', [req.params.userId, req.params.id]);
    req.auditContext = { entityId: req.params.id, action: 'partner.member_remove', changes: { user_id: req.params.userId } };
    res.json({ data: { client_id: req.params.id, user_id: req.params.userId, removed: true } });
  } catch (err) { next(err); }
});

// ── GET /partner/overview ─────────────────────────────────
router.get('/overview', async (req, res, next) => {
  try {
    const pid = partnerId(req);
    const [{ rows: totals }, { rows: alarms }, { rows: orders }, { rows: hints }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS clients,
                COALESCE(SUM((SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL)), 0)::int AS devices,
                COALESCE(SUM((SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL AND d.online = true)), 0)::int AS online,
                COALESCE(SUM((SELECT COUNT(*) FROM alarms a WHERE a.tenant_id = t.id AND a.active = true)), 0)::int AS active_alarms,
                COALESCE(SUM((SELECT COUNT(*) FROM work_orders w WHERE w.tenant_id = t.id AND w.status IN ('new', 'assigned', 'in_progress'))), 0)::int AS open_orders,
                COALESCE(SUM((SELECT COUNT(*) FROM maintenance_hints h WHERE h.tenant_id = t.id AND h.closed_at IS NULL)), 0)::int AS open_hints
           FROM tenants t WHERE t.parent_tenant_id = $1`, [pid]),
      db.query(
        `SELECT a.id, a.alarm_code, a.severity, a.triggered_at, a.acknowledged_at, a.device_id AS device_mqtt_id,
                d.id AS device_id, d.name AS device_name, t.id AS tenant_id, t.name AS tenant_name, s.name AS site_name
           FROM alarms a
           JOIN tenants t ON t.id = a.tenant_id
           LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
           LEFT JOIN sites s ON s.id = d.site_id
          WHERE t.parent_tenant_id = $1 AND a.active = true
          ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.triggered_at DESC
          LIMIT 50`, [pid]),
      db.query(
        `SELECT w.id, w.title, w.priority, w.status, w.created_at, w.scheduled_at, w.device_mqtt_id,
                t.id AS tenant_id, t.name AS tenant_name, s.name AS site_name, au.email AS assigned_to_email
           FROM work_orders w
           JOIN tenants t ON t.id = w.tenant_id
           LEFT JOIN sites s ON s.id = w.site_id
           LEFT JOIN users au ON au.id = w.assigned_to
          WHERE t.parent_tenant_id = $1 AND w.status IN ('new', 'assigned', 'in_progress')
          ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.created_at
          LIMIT 50`, [pid]),
      db.query(
        `SELECT h.id, h.alarm_code, h.value::float AS value, h.threshold::float AS threshold, h.opened_at, h.device_id AS device_mqtt_id,
                d.name AS device_name, t.id AS tenant_id, t.name AS tenant_name
           FROM maintenance_hints h
           JOIN tenants t ON t.id = h.tenant_id
           LEFT JOIN devices d ON d.mqtt_device_id = h.device_id AND d.tenant_id = h.tenant_id
          WHERE t.parent_tenant_id = $1 AND h.closed_at IS NULL
          ORDER BY h.opened_at DESC LIMIT 50`, [pid]),
    ]);
    res.json({ data: { totals: totals[0], alarms, work_orders: orders, hints } });
  } catch (err) { next(err); }
});

// ── GET /partner/sites — the cross-tenant map ─────────────
router.get('/sites', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.city, s.latitude, s.longitude, t.id AS tenant_id, t.name AS tenant_name,
              (SELECT COUNT(*)::int FROM devices d WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id AND d.status = 'active' AND d.deleted_at IS NULL) AS device_count,
              (SELECT COUNT(*)::int FROM devices d WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id AND d.status = 'active' AND d.deleted_at IS NULL AND d.online = true) AS online_count,
              (SELECT COUNT(*)::int FROM alarms a JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
                WHERE d.site_id = s.id AND a.tenant_id = s.tenant_id AND a.active = true) AS active_alarms
         FROM sites s JOIN tenants t ON t.id = s.tenant_id
        WHERE t.parent_tenant_id = $1 AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        ORDER BY t.name, s.name LIMIT 2000`,
      [partnerId(req)]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
