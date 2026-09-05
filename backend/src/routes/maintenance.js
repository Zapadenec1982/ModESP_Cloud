'use strict';

/**
 * Maintenance hints (plan epic 2.4): "the same alarm keeps coming back".
 * The controller raises the alarms; services/maintenance.js counts them.
 *
 *   GET    /api/maintenance/hints            list (active by default) — tenant-scoped, per-device RBAC
 *   POST   /api/maintenance/hints/:id/ack    take into work (admin, technician with device access)
 *   POST   /api/maintenance/hints/:id/dismiss close as "dismissed" (admin)
 *   GET    /api/maintenance/rules            effective rules of the organisation (admin)
 *   PUT    /api/maintenance/rules/:key       organisation override; ?global=1 → platform default (superadmin)
 *   DELETE /api/maintenance/rules/:key       drop the organisation override (admin)
 *   POST   /api/maintenance/evaluate         run the evaluator now (superadmin)
 *   GET    /api/devices/:id/hints            hints of one device (any role with device access)
 *
 * Everything but the device sub-route is behind the `maintenance` plan feature
 * (402 plan_feature otherwise); the device route answers an empty list for a
 * plan without the feature so the tab renders instead of erroring.
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const maintenance = require('../services/maintenance');
const { authorize, requireSuperadmin } = require('../middleware/auth');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const { requireFeature, hasFeature } = require('../middleware/plan');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) => AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

const router       = Router();
const deviceRouter = Router();

const HINT_COLUMNS = `h.id, h.device_id, h.rule_key, h.alarm_code, h.severity, h.value::float AS value, h.threshold::float AS threshold,
                      h.window_hours, h.opened_at, h.last_seen_at, h.closed_at, h.closed_reason,
                      h.acknowledged_at, h.ack_note, ack.email AS acknowledged_by_email,
                      wo.id AS work_order_id, wo.status AS work_order_status`;
const HINT_WO_JOIN = `LEFT JOIN LATERAL (SELECT w.id, w.status FROM work_orders w WHERE w.hint_id = h.id ORDER BY w.created_at DESC LIMIT 1) wo ON true`;

// ── GET /maintenance/hints ────────────────────────────────
router.get('/hints', requireFeature('maintenance'), filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const active = req.query.active === undefined ? 'true' : String(req.query.active);
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const params = [];
    let where = '1=1';
    if (!isSuperadmin) { params.push(req.tenantId); where += ` AND h.tenant_id = $${params.length}`; }
    if (req.deviceMqttIds) { params.push(req.deviceMqttIds); where += ` AND h.device_id = ANY($${params.length})`; }
    if (active === 'true') where += ' AND h.closed_at IS NULL';
    else if (active === 'false') where += ' AND h.closed_at IS NOT NULL';
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT ${HINT_COLUMNS}, d.id AS device_uuid, d.name AS device_name, d.model AS device_model
              ${isSuperadmin ? ', t.slug AS tenant_slug, t.name AS tenant_name' : ''}
         FROM maintenance_hints h
         LEFT JOIN devices d ON d.mqtt_device_id = h.device_id AND d.tenant_id = h.tenant_id
         LEFT JOIN users ack ON ack.id = h.acknowledged_by
         ${HINT_WO_JOIN}
         ${isSuperadmin ? 'LEFT JOIN tenants t ON t.id = h.tenant_id' : ''}
        WHERE ${where}
        ORDER BY (h.closed_at IS NULL) DESC, h.opened_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /devices/:id/hints ────────────────────────────────
deviceRouter.get('/:id/hints', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const where = isUuidFormat(id) ? 'id = $1' : 'mqtt_device_id = $1';
    const devParams = [id];
    let scope = '';
    if (!isSuperadmin && req.tenantId) { devParams.push(req.tenantId); scope = ' AND tenant_id = $2'; }
    const { rows: dev } = await db.query(`SELECT mqtt_device_id, tenant_id FROM devices WHERE ${where}${scope}`, devParams);
    if (dev.length === 0) return res.status(404).json({ error: 'not_found', message: `Device ${id} not found`, status: 404 });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await db.query(
      `SELECT ${HINT_COLUMNS} FROM maintenance_hints h
         LEFT JOIN users ack ON ack.id = h.acknowledged_by
         ${HINT_WO_JOIN}
        WHERE h.tenant_id = $1 AND h.device_id = $2
        ORDER BY (h.closed_at IS NULL) DESC, h.opened_at DESC LIMIT $3`,
      [dev[0].tenant_id, dev[0].mqtt_device_id, limit]
    );
    const enabled = isSuperadmin ? true : await hasFeature(dev[0].tenant_id, 'maintenance');
    res.json({ data: rows, feature_enabled: enabled });
  } catch (err) { next(err); }
});

// ── hint loader with RBAC (mirrors alarms.js loadAlarmForCaller) ──
async function loadHintForCaller(req, hintId) {
  if (!/^\d{1,18}$/.test(String(hintId))) return { status: 404, error: 'not_found', message: 'Hint not found' };
  const isSuperadmin = req.user && req.user.role === 'superadmin';
  const params = [hintId];
  let scope = '';
  if (!isSuperadmin) { params.push(req.tenantId); scope = ' AND h.tenant_id = $2'; }
  const { rows } = await db.query(
    `SELECT h.*, d.id AS device_uuid, t.slug AS tenant_slug
       FROM maintenance_hints h
       LEFT JOIN devices d ON d.mqtt_device_id = h.device_id AND d.tenant_id = h.tenant_id
       LEFT JOIN tenants t ON t.id = h.tenant_id
      WHERE h.id = $1${scope}`,
    params
  );
  if (rows.length === 0) return { status: 404, error: 'not_found', message: 'Hint not found' };
  const hint = rows[0];
  if (AUTH_ENABLED && req.user && req.user.role !== 'admin' && !isSuperadmin) {
    if (!hint.device_uuid) return { status: 403, error: 'forbidden', message: 'Device access denied' };
    const { rows: access } = await db.query(
      `SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2
       UNION
       SELECT 1 FROM user_sites us JOIN devices d ON d.site_id = us.site_id AND d.tenant_id = us.tenant_id
        WHERE us.user_id = $1 AND d.id = $2 AND us.tenant_id = $3
       LIMIT 1`,
      [req.user.id, hint.device_uuid, req.tenantId]
    );
    if (access.length === 0) return { status: 403, error: 'forbidden', message: 'Device access denied' };
  }
  return { hint };
}

const noteSchema = z.object({ note: z.string().max(512).optional().nullable() });

// ── POST /maintenance/hints/:id/ack ───────────────────────
router.post('/hints/:id/ack', requireFeature('maintenance'), maybeAuthorize('admin', 'technician'), async (req, res, next) => {
  const parsed = noteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  try {
    const loaded = await loadHintForCaller(req, req.params.id);
    if (loaded.status) return res.status(loaded.status).json({ error: loaded.error, message: loaded.message, status: loaded.status });
    const { hint } = loaded;
    if (hint.closed_at) return res.status(409).json({ error: 'closed', message: 'Hint is already closed', status: 409 });
    if (hint.acknowledged_at) return res.status(409).json({ error: 'already_acknowledged', message: 'Hint was already acknowledged', status: 409 });
    const { rows } = await db.query(
      `UPDATE maintenance_hints SET acknowledged_by = $1, acknowledged_at = now(), ack_note = $2
        WHERE id = $3 AND acknowledged_at IS NULL
        RETURNING id, device_id, rule_key, alarm_code, severity, acknowledged_at, ack_note`,
      [req.user ? req.user.id : null, parsed.data.note?.trim() || null, hint.id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'already_acknowledged', message: 'Hint was already acknowledged', status: 409 });
    req.auditContext = { entityId: hint.device_id, action: 'maintenance.hint_ack', changes: { hint_id: hint.id, rule_key: hint.rule_key, note: parsed.data.note || null } };
    res.json({ data: { ...rows[0], acknowledged_by_email: req.user ? req.user.email : null } });
  } catch (err) { next(err); }
});

// ── POST /maintenance/hints/:id/dismiss ───────────────────
router.post('/hints/:id/dismiss', requireFeature('maintenance'), maybeAuthorize('admin'), async (req, res, next) => {
  const parsed = noteSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  try {
    const loaded = await loadHintForCaller(req, req.params.id);
    if (loaded.status) return res.status(loaded.status).json({ error: loaded.error, message: loaded.message, status: loaded.status });
    const { hint } = loaded;
    if (hint.closed_at) return res.status(409).json({ error: 'closed', message: 'Hint is already closed', status: 409 });
    const { rows } = await db.query(
      `UPDATE maintenance_hints
          SET closed_at = now(), closed_reason = 'dismissed',
              acknowledged_by = COALESCE(acknowledged_by, $1), acknowledged_at = COALESCE(acknowledged_at, now()),
              ack_note = COALESCE($2, ack_note)
        WHERE id = $3 AND closed_at IS NULL
        RETURNING id, device_id, rule_key, alarm_code, severity, closed_at, closed_reason`,
      [req.user ? req.user.id : null, parsed.data.note?.trim() || null, hint.id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'closed', message: 'Hint is already closed', status: 409 });
    req.auditContext = { entityId: hint.device_id, action: 'maintenance.hint_dismiss', changes: { hint_id: hint.id, rule_key: hint.rule_key } };
    mqttSvc.emit('hint', { tenantId: hint.tenant_id, tenantSlug: hint.tenant_slug, deviceId: hint.device_id, deviceUuid: hint.device_uuid,
                           hintId: hint.id, ruleKey: hint.rule_key, alarmCode: hint.alarm_code, severity: hint.severity,
                           value: hint.value, threshold: hint.threshold, active: false });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── Rules ─────────────────────────────────────────────────
router.get('/rules', requireFeature('maintenance'), maybeAuthorize('admin'), async (req, res, next) => {
  try {
    res.json({ data: await maintenance.effectiveRules(req.tenantId) });
  } catch (err) { next(err); }
});

const ruleKeyParam = z.enum(maintenance.RULE_KEYS);
const ruleSchema = z.object({
  threshold:    z.number().min(1).max(100000),   // times the alarm came back
  window_hours: z.number().int().min(1).max(720).optional(),
  severity:     z.enum(['info', 'warning']).optional(),
  enabled:      z.boolean().optional(),
  model:        z.string().min(1).max(64).trim().nullable().optional(),
});

router.put('/rules/:key', requireFeature('maintenance'), maybeAuthorize('admin'), async (req, res, next) => {
  const key = ruleKeyParam.safeParse(req.params.key);
  if (!key.success) return res.status(404).json({ error: 'not_found', message: 'Unknown rule', status: 404 });
  const parsed = ruleSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  const isSuperadmin = req.user && req.user.role === 'superadmin';
  const global = String(req.query.global) === '1';
  if (global && !isSuperadmin) return res.status(403).json({ error: 'forbidden', message: 'Only a superadmin edits the platform defaults', status: 403 });
  try {
    const d = parsed.data;
    const tenantId = global ? null : req.tenantId;
    const model = d.model === undefined ? null : d.model;
    const { rows } = await db.query(
      `INSERT INTO maintenance_rules (tenant_id, rule_key, model, threshold, window_hours, severity, enabled, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 168), COALESCE($6, 'info'), COALESCE($7, true), $8)
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_key, COALESCE(model, ''))
       DO UPDATE SET threshold = EXCLUDED.threshold,
                     window_hours = COALESCE($5, maintenance_rules.window_hours),
                     severity = COALESCE($6, maintenance_rules.severity),
                     enabled = COALESCE($7, maintenance_rules.enabled),
                     updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING id, tenant_id, rule_key, model, threshold::float AS threshold, window_hours, severity, enabled, updated_at`,
      [tenantId, key.data, model, d.threshold, d.window_hours ?? null, d.severity ?? null, d.enabled ?? null, req.user ? req.user.id : null]
    );
    req.auditContext = { entityId: key.data, action: 'maintenance.rule_update', changes: { ...d, global } };
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/rules/:key', requireFeature('maintenance'), maybeAuthorize('admin'), async (req, res, next) => {
  const key = ruleKeyParam.safeParse(req.params.key);
  if (!key.success) return res.status(404).json({ error: 'not_found', message: 'Unknown rule', status: 404 });
  try {
    const model = req.query.model ? String(req.query.model) : null;
    const { rowCount } = await db.query(
      `DELETE FROM maintenance_rules WHERE tenant_id = $1 AND rule_key = $2 AND COALESCE(model, '') = COALESCE($3, '')`,
      [req.tenantId, key.data, model]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found', message: 'No override for this rule', status: 404 });
    req.auditContext = { entityId: key.data, action: 'maintenance.rule_reset', changes: { model } };
    res.json({ data: { rule_key: key.data, model, reset: true } });
  } catch (err) { next(err); }
});

// ── POST /maintenance/evaluate (superadmin) ───────────────
router.post('/evaluate', requireSuperadmin, async (req, res, next) => {
  try {
    const report = await maintenance.evaluateAll();
    req.auditContext = { entityId: null, action: 'maintenance.evaluate', changes: { tenants: Object.keys(report).length } };
    res.json({ data: report });
  } catch (err) { next(err); }
});

module.exports = { router, deviceRouter };
