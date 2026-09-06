'use strict';

/**
 * Billing (plan epic 2.2). Mounted at /api/billing behind authenticate +
 * authorize('admin'): an organisation's admin sees its own plan, usage,
 * invoices and requisites and asks for a plan change; the superadmin runs the
 * jobs, marks invoices paid or void, keeps the seller's requisites and
 * decides plan-change requests.
 *
 *   GET    /api/billing/summary                    plan, status, month-to-date estimate, open invoices, seller requisites
 *   GET    /api/billing/usage?months=2             daily usage snapshots
 *   GET    /api/billing/invoices                   own invoices (superadmin: ?tenant_id=)
 *   GET    /api/billing/invoices/:id               one invoice with lines
 *   GET    /api/billing/invoices/:id/pdf           the PDF
 *   PATCH  /api/billing/identity                   legal_name / tax_id / billing_email of the organisation
 *   POST   /api/billing/plan-request               ask for another plan; DELETE cancels the pending one
 *
 *   GET    /api/billing/admin/invoices             every invoice (?status=&tenant_id=&limit=)
 *   POST   /api/billing/admin/invoices/:id/pay     mark paid (restores past_due / suspended organisations)
 *   POST   /api/billing/admin/invoices/:id/void    annul
 *   POST   /api/billing/admin/invoices/:id/send    (re)send the e-mail with the PDF
 *   POST   /api/billing/admin/run                  { job: snapshot|invoices|dunning|all, period?: 'YYYY-MM', tenant_id? }
 *   GET    /api/billing/admin/settings             seller requisites; PUT updates them
 *   GET    /api/billing/admin/plan-requests        ?status=pending
 *   POST   /api/billing/admin/plan-requests/:id/approve | /reject
 *
 * An organisation billed through its partner (billing account is_partner)
 * sees who pays for it and nothing of the partner's invoice.
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const planMw     = require('../middleware/plan');
const billing    = require('../services/billing');
const pdfSvc     = require('../services/invoice-pdf');
const emailSvc   = require('../services/email');
const { requireSuperadmin } = require('../middleware/auth');
const { pickLocale } = require('../lib/locale');
const { normalizeIban, isValidIban, ibanProblem } = require('../lib/iban');

const router = Router();

const isSuperAdmin = (req) => !!(req.user && req.user.role === 'superadmin');
function bad(res, message, status = 400, error = 'validation_failed') {
  return res.status(status).json({ error, message, status });
}

const INVOICE_COLUMNS = `
  i.id, i.number, i.tenant_id, i.billing_account_id, i.period_start, i.period_end, i.amount::float AS amount, i.currency,
  i.status, i.issued_at, i.due_at, i.paid_at, i.paid_note, i.voided_at, i.sent_at, i.dunning_stage, i.dunning_at,
  i.buyer, i.created_at, (i.status = 'issued' AND i.due_at < now()) AS overdue`;

const SELLER_FIELDS = ['seller_name', 'seller_tax_id', 'seller_iban', 'seller_bank', 'seller_address', 'seller_email', 'due_days', 'invoice_note'];
const publicSeller = (s) => Object.fromEntries(SELLER_FIELDS.map(k => [k, s ? s[k] : null]));

async function tenantLocale(tenantId) {
  const { rows } = await db.query('SELECT locale FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  return pickLocale(rows[0] && rows[0].locale);
}

// ── Organisation admin ────────────────────────────────────

router.get('/summary', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const [{ rows: t }, est, settings, { rows: pending }, { rows: open }] = await Promise.all([
      db.query(
        `SELECT t.id, t.name, t.plan, t.status, t.trial_expires_at, t.legal_name, t.tax_id, t.billing_email, t.billing_currency,
                t.parent_tenant_id, parent.name AS parent_name, t.created_at,
                p.name AS plan_name, p.tagline, p.price_base_uah, p.price_controller_uah, p.price_site_uah, p.price_tiers_uah, p.price_note,
                p.max_devices, p.max_sites, p.max_users
           FROM tenants t
           LEFT JOIN tenants parent ON parent.id = t.parent_tenant_id
           LEFT JOIN plan_limits p ON p.plan = t.plan
          WHERE t.id = $1`, [tenantId]),
      billing.estimate(tenantId),
      billing.loadSettings(),
      db.query(`SELECT id, current_plan, requested_plan, message, status, created_at FROM plan_change_requests
                 WHERE tenant_id = $1 AND status = 'pending'`, [tenantId]),
      db.query(`SELECT ${INVOICE_COLUMNS} FROM invoices i WHERE i.tenant_id = $1 AND i.status = 'issued' ORDER BY i.due_at`, [tenantId]),
    ]);
    if (!t[0]) return bad(res, 'Organisation not found', 404, 'not_found');
    // A client billed through its partner learns who pays, not what the partner pays.
    const estimate = est && est.billed_via_partner
      ? { billed_via_partner: true, payer: est.payer, period: est.period }
      : est;
    res.json({ data: { tenant: t[0], estimate, seller: publicSeller(settings), plan_request: pending[0] || null, open_invoices: open } });
  } catch (err) { next(err); }
});

router.get('/usage', async (req, res, next) => {
  try {
    const months = Math.min(12, Math.max(1, parseInt(req.query.months, 10) || 2));
    const tenantId = isSuperAdmin(req) && req.query.tenant_id ? req.query.tenant_id : req.tenantId;
    const from = new Date();
    from.setUTCDate(1); from.setUTCHours(0, 0, 0, 0);
    from.setUTCMonth(from.getUTCMonth() - (months - 1));
    const { rows } = await db.query(
      `SELECT day, active_devices, sites, users, telemetry_rows::float AS telemetry_rows, notifications_sent, taken_at
         FROM usage_snapshots WHERE tenant_id = $1 AND day >= $2::date ORDER BY day`,
      [tenantId, from.toISOString().slice(0, 10)]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/invoices', async (req, res, next) => {
  try {
    const tenantId = isSuperAdmin(req) && req.query.tenant_id ? req.query.tenant_id : req.tenantId;
    const { rows } = await db.query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices i WHERE i.tenant_id = $1 ORDER BY i.period_start DESC, i.issued_at DESC LIMIT 60`,
      [tenantId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

/** The invoice when it belongs to the caller's organisation (superadmin: any). */
async function loadInvoice(req, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(
    `SELECT ${INVOICE_COLUMNS}, i.lines, t.name AS tenant_name, t.slug AS tenant_slug
       FROM invoices i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.id = $1 AND ($2::boolean OR i.tenant_id = $3)`,
    [id, isSuperAdmin(req), req.tenantId]);
  return rows[0] || null;
}

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return bad(res, 'Invoice not found', 404, 'not_found');
    res.json({ data: inv });
  } catch (err) { next(err); }
});

router.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return bad(res, 'Invoice not found', 404, 'not_found');
    const lang = pickLocale(req.query.lang, await tenantLocale(inv.tenant_id));
    const seller = await billing.loadSettings();
    const buffer = await pdfSvc.render({ invoice: inv, seller, lang });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

const identitySchema = z.object({
  legal_name:    z.string().max(256).trim().nullable().optional(),
  tax_id:        z.string().max(32).trim().nullable().optional(),
  billing_email: z.string().email().max(256).nullable().optional().or(z.literal('').transform(() => null)),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' });

router.patch('/identity', async (req, res, next) => {
  const parsed = identitySchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const d = parsed.data;
    const sets = [], params = [];
    for (const k of ['legal_name', 'tax_id', 'billing_email']) {
      if (d[k] !== undefined) { params.push(d[k] === '' ? null : d[k]); sets.push(`${k} = $${params.length}`); }
    }
    params.push(req.tenantId);
    const { rows } = await db.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, legal_name, tax_id, billing_email`, params);
    req.auditContext = { entityId: req.tenantId, action: 'billing.identity_update', changes: d };
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── Plan change requests ──────────────────────────────────

const planRequestSchema = z.object({
  plan:    z.string().min(1).max(16),
  message: z.string().max(1000).trim().nullable().optional(),
});

router.post('/plan-request', async (req, res, next) => {
  const parsed = planRequestSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const { rows: plans } = await db.query('SELECT plan FROM plan_limits WHERE public = true AND plan = $1', [parsed.data.plan]);
    if (plans.length === 0) return bad(res, 'Unknown plan');
    const { rows: t } = await db.query('SELECT plan, name, slug, billing_email FROM tenants WHERE id = $1', [req.tenantId]);
    if (t[0].plan === parsed.data.plan) return bad(res, 'This is already the current plan');
    const { rows } = await db.query(
      `INSERT INTO plan_change_requests (tenant_id, requested_by, current_plan, requested_plan, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, current_plan, requested_plan, message, status, created_at`,
      [req.tenantId, req.user ? req.user.id : null, t[0].plan, parsed.data.plan, parsed.data.message || null]);
    req.auditContext = { entityId: rows[0].id, action: 'billing.plan_request', changes: parsed.data };
    // Tell the founder (best effort; the request is stored either way)
    emailSvc.sendPlanRequest({
      to: process.env.PILOT_REQUEST_EMAIL,
      request: { ...rows[0], tenant_name: t[0].name, tenant_slug: t[0].slug, by: req.user ? req.user.email : null },
    }).catch(() => {});
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') return bad(res, 'A plan change request is already pending', 409, 'conflict');
    next(err);
  }
});

router.delete('/plan-request', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE plan_change_requests SET status = 'cancelled', resolved_at = now()
        WHERE tenant_id = $1 AND status = 'pending' RETURNING id`, [req.tenantId]);
    if (rows.length === 0) return bad(res, 'No pending request', 404, 'not_found');
    req.auditContext = { entityId: rows[0].id, action: 'billing.plan_request_cancel' };
    res.json({ data: { id: rows[0].id, status: 'cancelled' } });
  } catch (err) { next(err); }
});

// ── Superadmin ────────────────────────────────────────────

const admin = Router();
admin.use(requireSuperadmin);

admin.get('/invoices', async (req, res, next) => {
  try {
    const status = ['issued', 'paid', 'void', 'overdue'].includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { rows } = await db.query(
      `SELECT ${INVOICE_COLUMNS}, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
         FROM invoices i JOIN tenants t ON t.id = i.tenant_id
        WHERE ($1::text IS NULL OR ($1 = 'overdue' AND i.status = 'issued' AND i.due_at < now()) OR i.status = $1)
          AND ($2::uuid IS NULL OR i.tenant_id = $2)
        ORDER BY i.issued_at DESC LIMIT $3`,
      [status, req.query.tenant_id || null, limit]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

const paySchema = z.object({
  paid_at: z.string().datetime().optional(),
  note:    z.string().max(256).trim().nullable().optional(),
});

admin.post('/invoices/:id/pay', async (req, res, next) => {
  const parsed = paySchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return bad(res, 'Invoice not found', 404, 'not_found');
    if (inv.status !== 'issued') return bad(res, `Invoice is ${inv.status}`, 409, 'conflict');
    const result = await billing.markPaid(inv.id, { paidAt: parsed.data.paid_at ? new Date(parsed.data.paid_at) : new Date(), note: parsed.data.note || null });
    req.auditContext = { entityId: inv.id, action: 'billing.invoice_paid', changes: { number: inv.number, ...parsed.data, restored: result.restored.map(r => r.slug) } };
    res.json({ data: { ...(await loadInvoice(req, inv.id)), restored: result.restored } });
  } catch (err) { next(err); }
});

admin.post('/invoices/:id/void', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return bad(res, 'Invoice not found', 404, 'not_found');
    if (inv.status !== 'issued') return bad(res, `Invoice is ${inv.status}`, 409, 'conflict');
    const note = typeof (req.body || {}).note === 'string' ? req.body.note.slice(0, 256) : null;
    const result = await billing.voidInvoice(inv.id, { note });
    req.auditContext = { entityId: inv.id, action: 'billing.invoice_void', changes: { number: inv.number, note, restored: result.restored.map(r => r.slug) } };
    res.json({ data: { ...(await loadInvoice(req, inv.id)), restored: result.restored } });
  } catch (err) { next(err); }
});

admin.post('/invoices/:id/send', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return bad(res, 'Invoice not found', 404, 'not_found');
    if (!emailSvc.isConfigured()) return bad(res, 'E-mail is not configured (RESEND_API_KEY)', 503, 'unavailable');
    const sent = await billing.sendInvoiceEmail(inv);
    if (!sent) return bad(res, 'No recipient: set billing_email or an admin for the organisation', 409, 'conflict');
    req.auditContext = { entityId: inv.id, action: 'billing.invoice_send', changes: { number: inv.number } };
    res.json({ data: { id: inv.id, sent: true } });
  } catch (err) { next(err); }
});

const runSchema = z.object({
  job:       z.enum(['snapshot', 'invoices', 'dunning', 'all']).default('all'),
  period:    z.string().regex(/^\d{4}-\d{2}$/).optional(),
  tenant_id: z.string().uuid().optional(),
  send:      z.boolean().default(true),
});

admin.post('/run', async (req, res, next) => {
  const parsed = runSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  const { job, period, tenant_id, send } = parsed.data;
  try {
    const now = new Date();
    const out = {};
    if (job === 'snapshot' || job === 'all') out.snapshot = await billing.snapshotAll({ now });
    if (job === 'invoices' || job === 'all') {
      const p = period ? billing.periodFromString(period) : null;
      if (period && !p) return bad(res, 'period must be YYYY-MM');
      const r = await billing.generateInvoices({ now, period: p, tenantIds: tenant_id ? [tenant_id] : null, createdBy: req.user ? req.user.id : null, send });
      out.invoices = { period: r.period, skipped: r.skipped || null, created: r.created.map(i => ({ id: i.id, number: i.number, tenant_id: i.tenant_id, amount: Number(i.amount) })) };
    }
    if (job === 'dunning' || job === 'all') out.dunning = await billing.runDunning({ now });
    req.auditContext = { action: 'billing.run', changes: { job, period: period || null, tenant_id: tenant_id || null } };
    res.json({ data: out });
  } catch (err) { next(err); }
});

admin.get('/settings', async (_req, res, next) => {
  try { res.json({ data: publicSeller(await billing.loadSettings()) }); } catch (err) { next(err); }
});

const settingsSchema = z.object({
  seller_name:    z.string().max(256).trim().nullable().optional(),
  seller_tax_id:  z.string().max(32).trim().nullable().optional(),
  // The IBAN arms automatic billing and is what the customer pays into, so it
  // is checked like a bank checks it: structure, the length the country
  // registers, and the MOD 97-10 checksum. Stored without spaces, upper case.
  seller_iban:    z.string().max(64).nullable().optional()
                   .transform(v => (v === null || v === undefined ? v : normalizeIban(v)))
                   .refine(v => v === null || v === undefined || isValidIban(v), v => ({
                     message: `IBAN is not valid (${ibanProblem(v)})`,
                   })),
  seller_bank:    z.string().max(128).trim().nullable().optional(),
  seller_address: z.string().max(256).trim().nullable().optional(),
  seller_email:   z.string().email().max(256).nullable().optional().or(z.literal('').transform(() => null)),
  due_days:       z.number().int().min(1).max(90).optional(),
  invoice_note:   z.string().max(2000).trim().nullable().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' });

admin.put('/settings', async (req, res, next) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const d = parsed.data;
    const sets = [], params = [];
    for (const k of SELLER_FIELDS) {
      if (d[k] !== undefined) { params.push(d[k] === '' ? null : d[k]); sets.push(`${k} = $${params.length}`); }
    }
    const { rows } = await db.query(
      `UPDATE billing_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`, params);
    req.auditContext = { action: 'billing.settings_update', changes: d };
    res.json({ data: publicSeller(rows[0]) });
  } catch (err) { next(err); }
});

admin.get('/plan-requests', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const { rows } = await db.query(
      `SELECT r.id, r.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.plan AS tenant_plan,
              r.current_plan, r.requested_plan, r.message, r.status, r.created_at, r.resolved_at, r.resolution_note,
              u.email AS requested_by_email
         FROM plan_change_requests r
         JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`, [status]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

async function resolvePlanRequest(req, res, next, decision) {
  const note = typeof (req.body || {}).note === 'string' ? req.body.note.slice(0, 256) : null;
  try {
    const result = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE plan_change_requests SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [req.params.id, decision, req.user ? req.user.id : null, note]);
      const r = rows[0];
      if (!r) return null;
      if (decision === 'approved') {
        await client.query('UPDATE tenants SET plan = $2 WHERE id = $1', [r.tenant_id, r.requested_plan]);
        await client.query('UPDATE tenant_settings SET raw_retention_days = NULL WHERE tenant_id = $1', [r.tenant_id]);
      }
      return r;
    });
    if (!result) return bad(res, 'Pending request not found', 404, 'not_found');
    if (decision === 'approved') {
      planMw.invalidate(result.tenant_id);
      await mqttSvc.refreshRegistries();
    }
    req.auditContext = { entityId: result.id, action: `billing.plan_request_${decision}`, changes: { tenant_id: result.tenant_id, plan: result.requested_plan, note } };
    res.json({ data: result });
  } catch (err) { next(err); }
}

admin.post('/plan-requests/:id/approve', (req, res, next) => resolvePlanRequest(req, res, next, 'approved'));
admin.post('/plan-requests/:id/reject',  (req, res, next) => resolvePlanRequest(req, res, next, 'rejected'));

router.use('/admin', admin);

module.exports = router;
