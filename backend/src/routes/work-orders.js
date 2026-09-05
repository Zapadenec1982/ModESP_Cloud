'use strict';

/**
 * Work orders (plan epic 2.3): alarm or hint → technician → visit → record.
 *
 *   GET    /api/work-orders                 list: status=open|closed|all (default open), mine=1, device_id, site_id, limit, offset
 *   GET    /api/work-orders/stats           counts by status and average time to assign / start / close (from, to)
 *   GET    /api/work-orders/assignees       active technicians and admins of the organisation (admin)
 *   POST   /api/work-orders                 create (admin, technician with access to the device)
 *   GET    /api/work-orders/:id             detail with the linked alarm / hint / service record
 *   PATCH  /api/work-orders/:id             title, description, priority, scheduled_at (admin; technician on own order)
 *   POST   /api/work-orders/:id/assign      { user_id } — admin: anyone; technician: only themselves
 *   POST   /api/work-orders/:id/start       assignee or admin → in_progress
 *   POST   /api/work-orders/:id/close       { work_done, ... } → done + structured service record
 *   POST   /api/work-orders/:id/cancel      { reason } (admin)
 *   GET    /api/devices/:id/work-orders     orders of one device (any role with device access)
 *
 * Visibility for a technician or viewer: orders assigned to them, plus orders
 * on devices they may open (filterDeviceAccess). Administrators see everything
 * in the organisation; the superadmin across organisations.
 */

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const pushSvc    = require('../services/push');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) => AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

const router       = Router();
const deviceRouter = Router();

const OPEN = ['new', 'assigned', 'in_progress'];

const ORDER_COLUMNS = `w.id, w.site_id, w.device_id, w.device_mqtt_id, w.alarm_id, w.hint_id, w.title, w.description,
  w.priority, w.status, w.assigned_to, w.created_by, w.scheduled_at, w.assigned_at, w.started_at, w.closed_at,
  w.closed_reason, w.service_record_id, w.created_at, w.updated_at,
  d.name AS device_name, s.name AS site_name, s.city AS site_city, s.address_line AS site_address_line,
  s.latitude AS site_latitude, s.longitude AS site_longitude,
  au.email AS assigned_to_email, cu.email AS created_by_email`;
const ORDER_JOINS = `
  LEFT JOIN devices d ON d.id = w.device_id
  LEFT JOIN sites   s ON s.id = w.site_id AND s.tenant_id = w.tenant_id
  LEFT JOIN users  au ON au.id = w.assigned_to
  LEFT JOIN users  cu ON cu.id = w.created_by`;

function isAdmin(req)  { return !AUTH_ENABLED || !req.user || req.user.role === 'admin' || req.user.role === 'superadmin'; }
function isSuper(req)  { return req.user && req.user.role === 'superadmin'; }
function userId(req)   { return req.user ? req.user.id : null; }
function bad(res, message) { return res.status(400).json({ error: 'validation_failed', message, status: 400 }); }
function notFound(res)     { return res.status(404).json({ error: 'not_found', message: 'Work order not found', status: 404 }); }
function forbidden(res, message = 'Access denied') { return res.status(403).json({ error: 'forbidden', message, status: 403 }); }

function siteAddress(row) {
  return [row.site_address_line, row.site_city].filter(Boolean).join(', ') || null;
}
function mapsUrl(row) {
  if (row.site_latitude == null || row.site_longitude == null) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', `${row.site_latitude},${row.site_longitude}`);
  return url.toString();
}
function present(row) {
  return { ...row, site_address: siteAddress(row), maps_url: mapsUrl(row) };
}

/** Load one order the caller may see; null when not found or not visible. */
async function loadOrder(req, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const params = [id];
  let scope = '';
  if (!isSuper(req)) { params.push(req.tenantId); scope = ' AND w.tenant_id = $2'; }
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS}, w.tenant_id, t.slug AS tenant_slug FROM work_orders w ${ORDER_JOINS}
       LEFT JOIN tenants t ON t.id = w.tenant_id WHERE w.id = $1${scope}`, params);
  const order = rows[0];
  if (!order) return null;
  if (isAdmin(req)) return order;
  if (order.assigned_to === userId(req)) return order;
  if (order.device_id && req.deviceFilter && req.deviceFilter.includes(order.device_id)) return order;
  return null;
}

/** Resolve a device (uuid or mqtt id) inside the caller's scope and access set. */
async function resolveDevice(req, id) {
  const field = isUuidFormat(id) ? 'id' : 'mqtt_device_id';
  const params = [id];
  let scope = '';
  if (!isSuper(req)) { params.push(req.tenantId); scope = ' AND tenant_id = $2'; }
  const { rows } = await db.query(
    `SELECT id, tenant_id, mqtt_device_id, name, site_id FROM devices WHERE ${field} = $1${scope}`, params);
  const dev = rows[0];
  if (!dev) return { error: 404 };
  if (!isAdmin(req) && req.deviceFilter && !req.deviceFilter.includes(dev.id)) return { error: 403 };
  return { device: dev };
}

async function assigneeInTenant(tenantId, id) {
  const { rows } = await db.query(
    `SELECT id, email, role FROM users WHERE id = $1 AND tenant_id = $2 AND active = true AND role IN ('technician', 'admin')`,
    [id, tenantId]);
  return rows[0] || null;
}

async function notifyAssignee(req, order, tenantId) {
  if (!order.assigned_to) return;
  try {
    await pushSvc.notifyWorkOrder({
      tenantId, orderId: order.id, title: order.title, priority: order.priority, assignedTo: order.assigned_to,
      deviceId: order.device_mqtt_id, deviceUuid: order.device_id, deviceName: order.device_name,
      siteName: order.site_name, siteAddress: siteAddress(order), mapsUrl: mapsUrl(order), scheduledAt: order.scheduled_at,
    });
  } catch (err) {
    // The order is saved; a failed notification must not fail the request.
    req.log?.warn?.({ err, orderId: order.id }, 'Work order notification failed');
  }
}

function emit(order, tenantId, tenantSlug, action) {
  mqttSvc.emit('work_order', {
    tenantId, tenantSlug, orderId: order.id, deviceId: order.device_mqtt_id || null, status: order.status,
    assignedTo: order.assigned_to || null, action,
  });
}

// ── GET /work-orders ──────────────────────────────────────
router.get('/', filterDeviceAccess(), async (req, res, next) => {
  try {
    const status = String(req.query.status || 'open');
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    const where = [];
    if (!isSuper(req)) { params.push(req.tenantId); where.push(`w.tenant_id = $${params.length}`); }
    if (status === 'open')        { params.push(OPEN); where.push(`w.status = ANY($${params.length})`); }
    else if (status === 'closed') { params.push(['done', 'cancelled']); where.push(`w.status = ANY($${params.length})`); }
    else if (status !== 'all')    { params.push(status); where.push(`w.status = $${params.length}`); }
    if (String(req.query.mine) === '1' && req.user) { params.push(req.user.id); where.push(`w.assigned_to = $${params.length}`); }
    if (req.query.device_id && isUuidFormat(String(req.query.device_id))) { params.push(String(req.query.device_id)); where.push(`w.device_id = $${params.length}`); }
    if (req.query.site_id && isUuidFormat(String(req.query.site_id)))     { params.push(String(req.query.site_id));   where.push(`w.site_id = $${params.length}`); }
    if (!isAdmin(req)) {
      params.push(userId(req), req.deviceFilter || []);
      where.push(`(w.assigned_to = $${params.length - 1} OR w.device_id = ANY($${params.length}))`);
    }
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT ${ORDER_COLUMNS}${isSuper(req) ? ', t.slug AS tenant_slug, t.name AS tenant_name' : ''}
         FROM work_orders w ${ORDER_JOINS}${isSuper(req) ? ' LEFT JOIN tenants t ON t.id = w.tenant_id' : ''}
        WHERE ${where.join(' AND ') || '1=1'}
        ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 w.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    res.json({ data: rows.map(present) });
  } catch (err) { next(err); }
});

// ── GET /work-orders/stats ────────────────────────────────
router.get('/stats', maybeAuthorize('admin', 'technician'), async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400e3);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();
    if (isNaN(from) || isNaN(to)) return bad(res, 'from/to must be ISO dates');
    const { rows } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'new')::int         AS new,
              count(*) FILTER (WHERE status = 'assigned')::int    AS assigned,
              count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE status = 'done')::int        AS done,
              count(*) FILTER (WHERE status = 'cancelled')::int   AS cancelled,
              count(*) FILTER (WHERE alarm_id IS NOT NULL)::int   AS from_alarms,
              count(*) FILTER (WHERE hint_id IS NOT NULL)::int    AS from_hints,
              round(avg(EXTRACT(EPOCH FROM (assigned_at - created_at)) / 60) FILTER (WHERE assigned_at IS NOT NULL))::int AS avg_assign_min,
              round(avg(EXTRACT(EPOCH FROM (started_at  - created_at)) / 60) FILTER (WHERE started_at  IS NOT NULL))::int AS avg_start_min,
              round(avg(EXTRACT(EPOCH FROM (closed_at   - created_at)) / 60) FILTER (WHERE status = 'done'))::int          AS avg_close_min
         FROM work_orders WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [req.tenantId, from, to]);
    res.json({ data: rows[0], meta: { from: from.toISOString(), to: to.toISOString() } });
  } catch (err) { next(err); }
});

// ── GET /work-orders/assignees ────────────────────────────
router.get('/assignees', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, role, base_address FROM users
        WHERE tenant_id = $1 AND active = true AND role IN ('technician', 'admin') ORDER BY role, email`,
      [req.tenantId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /work-orders ─────────────────────────────────────
const createSchema = z.object({
  title:        z.string().min(1).max(200).trim(),
  description:  z.string().max(4000).optional().nullable(),
  priority:     z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  device_id:    z.string().min(1).max(64).optional().nullable(),   // uuid or mqtt id
  site_id:      z.string().uuid().optional().nullable(),
  // BIGSERIAL ids travel as strings through pg and JSON; accept both forms.
  alarm_id:     z.coerce.number().int().positive().optional().nullable(),
  hint_id:      z.coerce.number().int().positive().optional().nullable(),
  assigned_to:  z.string().uuid().optional().nullable(),
  scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
});

router.post('/', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  const d = parsed.data;
  try {
    const tenantId = req.tenantId;
    let device = null;
    if (d.device_id) {
      const r = await resolveDevice(req, d.device_id);
      if (r.error === 404) return res.status(404).json({ error: 'not_found', message: 'Device not found', status: 404 });
      if (r.error === 403) return forbidden(res, 'Device access denied');
      device = r.device;
    }
    let siteId = d.site_id || (device ? device.site_id : null);
    if (siteId) {
      const { rows } = await db.query('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2', [siteId, tenantId]);
      if (rows.length === 0) return bad(res, 'site_id does not belong to this organisation');
    }
    if (!device && !siteId) return bad(res, 'device_id or site_id is required');

    // Linked alarm / hint must be in the organisation and on the same device
    let alarm = null, hint = null;
    if (d.alarm_id) {
      const { rows } = await db.query('SELECT id, device_id, acknowledged_at FROM alarms WHERE id = $1 AND tenant_id = $2', [d.alarm_id, tenantId]);
      alarm = rows[0];
      if (!alarm) return bad(res, 'alarm_id not found in this organisation');
      if (device && alarm.device_id !== device.mqtt_device_id) return bad(res, 'alarm belongs to another device');
    }
    if (d.hint_id) {
      const { rows } = await db.query('SELECT id, device_id, acknowledged_at FROM maintenance_hints WHERE id = $1 AND tenant_id = $2', [d.hint_id, tenantId]);
      hint = rows[0];
      if (!hint) return bad(res, 'hint_id not found in this organisation');
      if (device && hint.device_id !== device.mqtt_device_id) return bad(res, 'hint belongs to another device');
    }

    let assignedTo = d.assigned_to || null;
    if (assignedTo) {
      if (!isAdmin(req) && assignedTo !== userId(req)) return forbidden(res, 'A technician can only assign an order to themselves');
      if (!await assigneeInTenant(tenantId, assignedTo)) return bad(res, 'assigned_to must be an active technician or admin of this organisation');
    }

    const order = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO work_orders (tenant_id, site_id, device_id, device_mqtt_id, alarm_id, hint_id, title, description, priority,
                                  status, assigned_to, created_by, scheduled_at, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [tenantId, siteId, device ? device.id : null, device ? device.mqtt_device_id : null, d.alarm_id || null, d.hint_id || null,
         d.title, d.description || null, d.priority || 'normal', assignedTo ? 'assigned' : 'new', assignedTo, userId(req),
         d.scheduled_at ? new Date(d.scheduled_at) : null]);
      const id = rows[0].id;
      // Taking an alarm or hint into an order is an acknowledgement of it.
      if (alarm && !alarm.acknowledged_at) {
        await client.query(`UPDATE alarms SET acknowledged_by = $1, acknowledged_at = now(), ack_note = COALESCE(ack_note, $2) WHERE id = $3 AND acknowledged_at IS NULL`,
          [userId(req), `Наряд #${id}`, alarm.id]);
      }
      if (hint && !hint.acknowledged_at) {
        await client.query(`UPDATE maintenance_hints SET acknowledged_by = $1, acknowledged_at = now(), ack_note = COALESCE(ack_note, $2) WHERE id = $3 AND acknowledged_at IS NULL`,
          [userId(req), `Наряд #${id}`, hint.id]);
      }
      return id;
    });

    const full = await loadOrder(req, order);
    req.auditContext = { entityId: String(order), action: 'work_order.create', changes: { title: d.title, device: device ? device.mqtt_device_id : null, alarm_id: d.alarm_id || null, hint_id: d.hint_id || null, assigned_to: assignedTo } };
    if (alarm && !alarm.acknowledged_at) {
      mqttSvc.emit('alarm_ack', { tenantSlug: full.tenant_slug, tenantId, deviceId: alarm.device_id, alarmId: alarm.id, alarmCode: null, acknowledgedBy: req.user ? req.user.email : null });
    }
    emit(full, tenantId, full.tenant_slug, 'created');
    if (assignedTo && assignedTo !== userId(req)) await notifyAssignee(req, full, tenantId);   // no note to oneself
    res.status(201).json({ data: present(full) });
  } catch (err) { next(err); }
});

// ── GET /work-orders/:id ──────────────────────────────────
router.get('/:id', filterDeviceAccess(), async (req, res, next) => {
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    const [alarm, hint, record] = await Promise.all([
      order.alarm_id ? db.query('SELECT id, alarm_code, severity, active, triggered_at, cleared_at, acknowledged_at FROM alarms WHERE id = $1', [order.alarm_id]) : { rows: [] },
      order.hint_id  ? db.query('SELECT id, rule_key, severity, value::float AS value, threshold::float AS threshold, opened_at, closed_at, closed_reason FROM maintenance_hints WHERE id = $1', [order.hint_id]) : { rows: [] },
      order.service_record_id ? db.query('SELECT id, service_date, technician, reason, work_done, duration_min, parts, cost, cost_currency, created_at FROM service_records WHERE id = $1', [order.service_record_id]) : { rows: [] },
    ]);
    res.json({ data: { ...present(order), alarm: alarm.rows[0] || null, hint: hint.rows[0] || null, service_record: record.rows[0] || null } });
  } catch (err) { next(err); }
});

// ── PATCH /work-orders/:id ────────────────────────────────
const patchSchema = z.object({
  title:        z.string().min(1).max(200).trim().optional(),
  description:  z.string().max(4000).nullable().optional(),
  priority:     z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
});
router.patch('/:id', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  const d = parsed.data;
  if (Object.keys(d).length === 0) return bad(res, 'No fields to update');
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    if (!isAdmin(req) && order.assigned_to !== userId(req)) return forbidden(res, 'Only the assignee or an administrator can edit this order');
    if (!OPEN.includes(order.status)) return res.status(409).json({ error: 'closed', message: 'Order is closed', status: 409 });
    const sets = [], params = [];
    for (const [k, v] of Object.entries(d)) { params.push(k === 'scheduled_at' && v ? new Date(v) : v); sets.push(`${k} = $${params.length}`); }
    params.push(order.id);
    await db.query(`UPDATE work_orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    const full = await loadOrder(req, order.id);
    req.auditContext = { entityId: String(order.id), action: 'work_order.update', changes: d };
    emit(full, order.tenant_id, order.tenant_slug, 'updated');
    res.json({ data: present(full) });
  } catch (err) { next(err); }
});

// ── POST /work-orders/:id/assign ──────────────────────────
router.post('/:id/assign', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = z.object({ user_id: z.string().uuid() }).safeParse(req.body || {});
  if (!parsed.success) return bad(res, 'user_id (uuid) is required');
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    if (!OPEN.includes(order.status)) return res.status(409).json({ error: 'closed', message: 'Order is closed', status: 409 });
    const target = parsed.data.user_id;
    if (!isAdmin(req)) {
      if (target !== userId(req)) return forbidden(res, 'A technician can only take an order themselves');
      if (order.assigned_to && order.assigned_to !== userId(req)) return res.status(409).json({ error: 'already_assigned', message: 'Order is assigned to someone else', status: 409 });
    }
    if (!await assigneeInTenant(order.tenant_id, target)) return bad(res, 'user_id must be an active technician or admin of this organisation');
    await db.query(
      `UPDATE work_orders SET assigned_to = $1, assigned_at = now(), status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END, updated_at = now() WHERE id = $2`,
      [target, order.id]);
    const full = await loadOrder(req, order.id);
    req.auditContext = { entityId: String(order.id), action: 'work_order.assign', changes: { user_id: target } };
    emit(full, order.tenant_id, order.tenant_slug, 'assigned');
    if (target !== userId(req)) await notifyAssignee(req, full, order.tenant_id);
    res.json({ data: present(full) });
  } catch (err) { next(err); }
});

// ── POST /work-orders/:id/start ───────────────────────────
router.post('/:id/start', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    if (!OPEN.includes(order.status)) return res.status(409).json({ error: 'closed', message: 'Order is closed', status: 409 });
    if (!isAdmin(req) && order.assigned_to !== userId(req)) return forbidden(res, 'Only the assignee can start this order');
    if (order.status === 'in_progress') return res.status(409).json({ error: 'already_started', message: 'Order is already in progress', status: 409 });
    await db.query(
      `UPDATE work_orders SET status = 'in_progress', started_at = COALESCE(started_at, now()),
              assigned_to = COALESCE(assigned_to, $1), assigned_at = COALESCE(assigned_at, now()), updated_at = now() WHERE id = $2`,
      [userId(req), order.id]);
    const full = await loadOrder(req, order.id);
    req.auditContext = { entityId: String(order.id), action: 'work_order.start', changes: {} };
    emit(full, order.tenant_id, order.tenant_slug, 'started');
    res.json({ data: present(full) });
  } catch (err) { next(err); }
});

// ── POST /work-orders/:id/close ───────────────────────────
const closeSchema = z.object({
  work_done:     z.string().min(1).max(2000),
  reason:        z.string().max(2000).optional().nullable(),
  service_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  duration_min:  z.number().int().min(0).max(100000).optional().nullable(),
  parts:         z.array(z.object({ name: z.string().min(1).max(120), qty: z.number().min(0).max(100000).optional(), cost: z.number().min(0).optional() })).max(50).optional().nullable(),
  cost:          z.number().min(0).max(1e9).optional().nullable(),
  cost_currency: z.string().length(3).toUpperCase().optional().nullable(),
});
router.post('/:id/close', maybeAuthorize('admin', 'technician'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = closeSchema.safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  const d = parsed.data;
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    if (!OPEN.includes(order.status)) return res.status(409).json({ error: 'closed', message: 'Order is closed', status: 409 });
    if (!isAdmin(req) && order.assigned_to !== userId(req)) return forbidden(res, 'Only the assignee can close this order');
    const technician = (req.user && req.user.email) || order.assigned_to_email || 'system';
    const recordId = await db.transaction(async (client) => {
      let rid = null;
      if (order.device_id) {
        const { rows } = await client.query(
          `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done, user_id, work_order_id, duration_min, parts, cost, cost_currency)
           VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [order.tenant_id, order.device_id, d.service_date || null, technician, d.reason || order.title, d.work_done, userId(req), order.id,
           d.duration_min ?? null, d.parts ? JSON.stringify(d.parts) : null, d.cost ?? null, d.cost_currency || null]);
        rid = rows[0].id;
      }
      await client.query(
        `UPDATE work_orders SET status = 'done', closed_at = now(), closed_reason = $1, service_record_id = $2,
                assigned_to = COALESCE(assigned_to, $3), started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $4`,
        [d.work_done.slice(0, 512), rid, userId(req), order.id]);
      return rid;
    });
    const full = await loadOrder(req, order.id);
    req.auditContext = { entityId: String(order.id), action: 'work_order.close', changes: { service_record_id: recordId, duration_min: d.duration_min ?? null, cost: d.cost ?? null } };
    emit(full, order.tenant_id, order.tenant_slug, 'closed');
    res.json({ data: present(full), service_record_id: recordId });
  } catch (err) { next(err); }
});

// ── POST /work-orders/:id/cancel ──────────────────────────
router.post('/:id/cancel', maybeAuthorize('admin'), filterDeviceAccess(), async (req, res, next) => {
  const parsed = z.object({ reason: z.string().max(512).optional().nullable() }).safeParse(req.body || {});
  if (!parsed.success) return bad(res, parsed.error.issues[0].message);
  try {
    const order = await loadOrder(req, req.params.id);
    if (!order) return notFound(res);
    if (!OPEN.includes(order.status)) return res.status(409).json({ error: 'closed', message: 'Order is closed', status: 409 });
    await db.query(`UPDATE work_orders SET status = 'cancelled', closed_at = now(), closed_reason = $1, updated_at = now() WHERE id = $2`,
      [parsed.data.reason || null, order.id]);
    const full = await loadOrder(req, order.id);
    req.auditContext = { entityId: String(order.id), action: 'work_order.cancel', changes: { reason: parsed.data.reason || null } };
    emit(full, order.tenant_id, order.tenant_slug, 'cancelled');
    res.json({ data: present(full) });
  } catch (err) { next(err); }
});

// ── GET /devices/:id/work-orders ──────────────────────────
deviceRouter.get('/:id/work-orders', checkDeviceAccess(), async (req, res, next) => {
  try {
    const field = isUuidFormat(req.params.id) ? 'id' : 'mqtt_device_id';
    const params = [req.params.id];
    let scope = '';
    if (!isSuper(req)) { params.push(req.tenantId); scope = ' AND tenant_id = $2'; }
    const { rows: dev } = await db.query(`SELECT id, tenant_id FROM devices WHERE ${field} = $1${scope}`, params);
    if (dev.length === 0) return res.status(404).json({ error: 'not_found', message: `Device ${req.params.id} not found`, status: 404 });
    const status = String(req.query.status || 'all');
    const p = [dev[0].tenant_id, dev[0].id];
    let extra = '';
    if (status === 'open') { p.push(OPEN); extra = ` AND w.status = ANY($3)`; }
    const { rows } = await db.query(
      `SELECT ${ORDER_COLUMNS} FROM work_orders w ${ORDER_JOINS}
        WHERE w.tenant_id = $1 AND w.device_id = $2${extra}
        ORDER BY (w.status = ANY('{new,assigned,in_progress}')) DESC, w.created_at DESC LIMIT 100`, p);
    res.json({ data: rows.map(present) });
  } catch (err) { next(err); }
});

module.exports = { router, deviceRouter };
