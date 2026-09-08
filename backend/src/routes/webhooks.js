'use strict';

/**
 * Webhooks of the organisation (plan epic 2.6). Mounted with authorize('admin').
 *   GET    /webhooks                          list with queue counters
 *   POST   /webhooks                          create; the signing secret is in the answer once
 *   PATCH  /webhooks/:id                      name, url, events, enabled (re-enabling resets failures)
 *   DELETE /webhooks/:id
 *   POST   /webhooks/:id/test                 send a `ping` now and report the answer
 *   POST   /webhooks/:id/rotate-secret        new secret, shown once
 *   GET    /webhooks/:id/deliveries           recent deliveries with status, attempts and payload
 *   POST   /webhooks/:id/deliveries/:did/redeliver
 */

const { Router } = require('express');
const { z } = require('zod');
const db = require('../services/db');
const webhooks = require('../services/webhooks');
const { requireFeature } = require('../middleware/plan');
const { isUuidFormat } = require('../lib/ids');

const router = Router();
const MAX_HOOKS = 10;
const COLUMNS = `w.id, w.tenant_id, w.name, w.url, w.events, w.enabled, w.failures, w.disabled_at, w.disabled_reason,
                 w.last_delivery_at, w.last_status, w.created_by, w.created_at, w.updated_at,
                 (SELECT COUNT(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
                 (SELECT COUNT(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'dead') AS dead`;

const eventSchema = z.enum([...webhooks.EVENTS, '*']);
const createSchema = z.object({
  name:    z.string().trim().min(1).max(80),
  url:     z.string().trim().url().max(2048),
  events:  z.array(eventSchema).min(1).max(20),
  secret:  z.string().min(16).max(128).optional(),
  enabled: z.boolean().optional(),
});
const patchSchema = createSchema.partial();

const validationError = (res, parsed) =>
  res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Webhook not found', status: 404 });

async function fetchHook(id, tenantId, { withSecret = false } = {}) {
  if (!isUuidFormat(id)) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS}${withSecret ? ', w.secret' : ''} FROM webhooks w WHERE w.id = $1 AND w.tenant_id = $2`, [id, tenantId]);
  return rows[0] || null;
}

async function checkUrl(res, url) {
  try { await webhooks.assertPublicUrl(url); return true; }
  catch (err) {
    if (err.code === 'invalid_url') { res.status(400).json({ error: 'invalid_url', message: err.message, status: 400 }); return false; }
    throw err;
  }
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM webhooks w WHERE w.tenant_id = $1 ORDER BY w.created_at`, [req.tenantId]);
    res.json({ data: rows, meta: { events: webhooks.EVENTS } });
  } catch (err) {
    req.log?.error?.({ err }, 'List webhooks failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list webhooks', status: 500 });
  }
});

router.post('/', requireFeature('api'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const b = parsed.data;
  try {
    const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM webhooks WHERE tenant_id = $1', [req.tenantId]);
    if (n >= MAX_HOOKS) return res.status(409).json({ error: 'limit_reached', message: `At most ${MAX_HOOKS} webhooks per organisation`, status: 409 });
    if (!await checkUrl(res, b.url)) return;
    const secret = b.secret || webhooks.generateSecret();
    const { rows } = await db.query(
      `INSERT INTO webhooks (tenant_id, name, url, secret, events, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.tenantId, b.name, b.url, webhooks.encryptSecret(secret), [...new Set(b.events)], b.enabled !== false, req.user.id]);
    const hook = await fetchHook(rows[0].id, req.tenantId);
    req.auditContext = { entityId: hook.id, action: 'webhook.create', changes: { name: hook.name, url: hook.url, events: hook.events } };
    res.status(201).json({ data: { ...hook, secret } });
  } catch (err) {
    req.log?.error?.({ err }, 'Create webhook failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to create webhook', status: 500 });
  }
});

router.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const b = parsed.data;
  try {
    const hook = await fetchHook(req.params.id, req.tenantId);
    if (!hook) return notFound(res);
    if (b.url !== undefined && b.url !== hook.url && !await checkUrl(res, b.url)) return;
    const enabled = b.enabled !== undefined ? b.enabled : hook.enabled;
    const reenabled = enabled && !hook.enabled;
    await db.query(
      `UPDATE webhooks
          SET name = $2, url = $3, events = $4, enabled = $5,
              failures = CASE WHEN $6 THEN 0 ELSE failures END,
              disabled_at = CASE WHEN $5 THEN NULL WHEN disabled_at IS NULL THEN now() ELSE disabled_at END,
              disabled_reason = CASE WHEN $5 THEN NULL WHEN disabled_reason IS NULL THEN 'manual' ELSE disabled_reason END,
              updated_at = now()
        WHERE id = $1`,
      [hook.id, b.name ?? hook.name, b.url ?? hook.url, b.events ? [...new Set(b.events)] : hook.events, enabled, reenabled]);
    req.auditContext = { entityId: hook.id, action: 'webhook.update', changes: b };
    res.json({ data: await fetchHook(hook.id, req.tenantId) });
  } catch (err) {
    req.log?.error?.({ err }, 'Update webhook failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update webhook', status: 500 });
  }
});

router.delete('/:id', async (req, res) => {
  if (!isUuidFormat(req.params.id)) return notFound(res);
  try {
    const { rowCount } = await db.query('DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!rowCount) return notFound(res);
    req.auditContext = { entityId: req.params.id, action: 'webhook.delete' };
    res.json({ data: { deleted: true } });
  } catch (err) {
    req.log?.error?.({ err }, 'Delete webhook failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to delete webhook', status: 500 });
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const hook = await fetchHook(req.params.id, req.tenantId, { withSecret: true });
    if (!hook) return notFound(res);
    const r = await webhooks.test(hook);
    res.json({ data: { ok: r.ok, status_code: r.status, error: r.error, duration_ms: r.ms } });
  } catch (err) {
    req.log?.error?.({ err }, 'Test webhook failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to test webhook', status: 500 });
  }
});

router.post('/:id/rotate-secret', async (req, res) => {
  try {
    const hook = await fetchHook(req.params.id, req.tenantId);
    if (!hook) return notFound(res);
    const secret = webhooks.generateSecret();
    await db.query('UPDATE webhooks SET secret = $2, updated_at = now() WHERE id = $1', [hook.id, webhooks.encryptSecret(secret)]);
    req.auditContext = { entityId: hook.id, action: 'webhook.rotate_secret' };
    res.json({ data: { id: hook.id, secret } });
  } catch (err) {
    req.log?.error?.({ err }, 'Rotate webhook secret failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to rotate secret', status: 500 });
  }
});

router.get('/:id/deliveries', async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const hook = await fetchHook(req.params.id, req.tenantId);
    if (!hook) return notFound(res);
    const params = [hook.id, limit];
    let where = 'webhook_id = $1';
    if (['pending', 'ok', 'failed', 'dead'].includes(req.query.status)) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT id, event, status, attempts, next_attempt_at, status_code, error, duration_ms, created_at, delivered_at, payload
         FROM webhook_deliveries WHERE ${where} ORDER BY created_at DESC LIMIT $2`, params);
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List deliveries failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list deliveries', status: 500 });
  }
});

router.post('/:id/deliveries/:did/redeliver', async (req, res) => {
  try {
    const hook = await fetchHook(req.params.id, req.tenantId);
    if (!hook || !isUuidFormat(req.params.did)) return notFound(res);
    const id = await webhooks.redeliver(req.params.did, req.tenantId);
    if (!id) return res.status(404).json({ error: 'not_found', message: 'Delivery not found', status: 404 });
    res.status(202).json({ data: { id } });
  } catch (err) {
    req.log?.error?.({ err }, 'Redeliver failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to queue redelivery', status: 500 });
  }
});

module.exports = router;
