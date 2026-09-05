'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

const router = Router();

// ── GET /api/alarms ───────────────────────────────────────
// List alarms. Superadmin sees cross-tenant; others see tenant-scoped.
router.get('/', filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const active = req.query.active;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql, params, idx;
    if (isSuperadmin) {
      sql = `
        SELECT a.id, a.device_id, a.alarm_code, a.severity,
               a.active, a.value, a.limit_value,
               a.triggered_at, a.cleared_at,
               a.acknowledged_at, a.ack_note, a.escalated_at, ack.email AS acknowledged_by_email,
               wo.id AS work_order_id, wo.status AS work_order_status,
               d.name AS device_name, d.mqtt_device_id,
               t.slug AS tenant_slug, t.name AS tenant_name
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
        LEFT JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN users ack ON ack.id = a.acknowledged_by
        LEFT JOIN LATERAL (SELECT w.id, w.status FROM work_orders w WHERE w.alarm_id = a.id ORDER BY w.created_at DESC LIMIT 1) wo ON true
        WHERE 1=1
      `;
      params = [];
      idx = 1;
    } else {
      sql = `
        SELECT a.id, a.device_id, a.alarm_code, a.severity,
               a.active, a.value, a.limit_value,
               a.triggered_at, a.cleared_at,
               a.acknowledged_at, a.ack_note, a.escalated_at, ack.email AS acknowledged_by_email,
               wo.id AS work_order_id, wo.status AS work_order_status,
               d.name AS device_name, d.mqtt_device_id
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
        LEFT JOIN users ack ON ack.id = a.acknowledged_by
        LEFT JOIN LATERAL (SELECT w.id, w.status FROM work_orders w WHERE w.alarm_id = a.id ORDER BY w.created_at DESC LIMIT 1) wo ON true
        WHERE a.tenant_id = $1
      `;
      params = [req.tenantId];
      idx = 2;
    }

    // Per-device RBAC: filter by user's assigned devices
    if (req.deviceMqttIds) {
      sql += ` AND a.device_id = ANY($${idx++})`;
      params.push(req.deviceMqttIds);
    }

    if (active === 'true') {
      sql += ` AND a.active = true`;
    } else if (active === 'false') {
      sql += ` AND a.active = false`;
    }

    // Severity filter: ?severity=critical,warning
    if (req.query.severity) {
      const valid = ['critical', 'warning', 'info'];
      const severities = req.query.severity.split(',').filter(s => valid.includes(s));
      if (severities.length > 0) {
        sql += ` AND a.severity = ANY($${idx++})`;
        params.push(severities);
      }
    }

    if (req.query.from) {
      sql += ` AND a.triggered_at >= $${idx++}`;
      params.push(new Date(req.query.from));
    }
    if (req.query.to) {
      sql += ` AND a.triggered_at < $${idx++}`;
      params.push(new Date(req.query.to));
    }

    sql += ` ORDER BY a.triggered_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/alarms/stats ──────────────────────────────────
// Alarm frequency statistics. Query: from, to
router.get('/stats', filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    let sql, params, nextIdx;
    if (isSuperadmin) {
      sql = `
        SELECT
          alarm_code,
          COUNT(*)::int AS count,
          ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(cleared_at, NOW()) - triggered_at))))::int AS avg_duration_sec
        FROM alarms
        WHERE triggered_at >= $1
          AND triggered_at < $2
      `;
      params = [from, to];
      nextIdx = 3;
    } else {
      sql = `
        SELECT
          alarm_code,
          COUNT(*)::int AS count,
          ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(cleared_at, NOW()) - triggered_at))))::int AS avg_duration_sec
        FROM alarms
        WHERE tenant_id = $1
          AND triggered_at >= $2
          AND triggered_at < $3
      `;
      params = [req.tenantId, from, to];
      nextIdx = 4;
    }

    // Per-device RBAC
    if (req.deviceMqttIds) {
      sql += ` AND device_id = ANY($${nextIdx})`;
      params.push(req.deviceMqttIds);
    }

    sql += ` GROUP BY alarm_code ORDER BY count DESC`;

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id/alarms ───────────────────────────
// Alarms for a specific device. Query: active, from, to, limit, offset
router.get('/:id/alarms', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const active = req.query.active;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Resolve mqtt_device_id — enforce tenant isolation
    const isUuid = isUuidFormat(id);
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    let where = isUuid ? 'id = $1' : 'mqtt_device_id = $1';
    const devParams = [id];
    if (!isSuperadmin && req.tenantId) {
      where += ' AND tenant_id = $2';
      devParams.push(req.tenantId);
    }

    const devRes = await db.query(
      `SELECT mqtt_device_id, tenant_id FROM devices WHERE ${where}`,
      devParams
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }
    const mqttId = devRes.rows[0].mqtt_device_id;
    const deviceTenantId = devRes.rows[0].tenant_id;

    let sql = `
      SELECT id, alarm_code, severity, active, value, limit_value,
             acknowledged_at, acknowledged_by, ack_note, escalated_at,
             triggered_at, cleared_at
      FROM alarms
      WHERE tenant_id = $1 AND device_id = $2
    `;
    const params = [deviceTenantId, mqttId];
    let idx = 3;

    if (active === 'true') {
      sql += ` AND active = true`;
    } else if (active === 'false') {
      sql += ` AND active = false`;
    }

    if (req.query.from) {
      sql += ` AND triggered_at >= $${idx++}`;
      params.push(new Date(req.query.from));
    }
    if (req.query.to) {
      sql += ` AND triggered_at < $${idx++}`;
      params.push(new Date(req.query.to));
    }

    sql += ` ORDER BY triggered_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── Acknowledgement (plan epic 1.6) ───────────────────────

/**
 * Load one alarm for the caller: tenant-scoped (superadmin: any), and for a
 * technician/viewer only when they may see the device (user_devices ∪ user_sites).
 * @returns {Promise<{ alarm: object } | { status: number, error: string, message: string }>}
 */
async function loadAlarmForCaller(req, alarmId) {
  if (!/^\d{1,18}$/.test(String(alarmId))) return { status: 404, error: 'not_found', message: 'Alarm not found' };
  const isSuperadmin = req.user && req.user.role === 'superadmin';
  const params = [alarmId];
  let scope = '';
  if (!isSuperadmin) { params.push(req.tenantId); scope = ' AND a.tenant_id = $2'; }
  const { rows } = await db.query(
    `SELECT a.*, d.id AS device_uuid, t.slug AS tenant_slug
       FROM alarms a
       LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
       LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.id = $1${scope}`,
    params
  );
  if (rows.length === 0) return { status: 404, error: 'not_found', message: 'Alarm not found' };
  const alarm = rows[0];

  if (AUTH_ENABLED && req.user && req.user.role !== 'admin' && !isSuperadmin) {
    if (!alarm.device_uuid) return { status: 403, error: 'forbidden', message: 'Device access denied' };
    const { rows: access } = await db.query(
      `SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2
       UNION
       SELECT 1 FROM user_sites us JOIN devices d ON d.site_id = us.site_id AND d.tenant_id = us.tenant_id
        WHERE us.user_id = $1 AND d.id = $2 AND us.tenant_id = $3
       LIMIT 1`,
      [req.user.id, alarm.device_uuid, req.tenantId]
    );
    if (access.length === 0) return { status: 403, error: 'forbidden', message: 'Device access denied' };
  }
  return { alarm };
}

const ackSchema = z.object({ note: z.string().max(512).optional().nullable() });

// POST /alarms/:id/ack — take an alarm into work (admin, technician)
router.post('/:id/ack', maybeAuthorize('admin', 'technician'), async (req, res, next) => {
  const parsed = ackSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const loaded = await loadAlarmForCaller(req, req.params.id);
    if (loaded.status) return res.status(loaded.status).json({ error: loaded.error, message: loaded.message, status: loaded.status });
    const { alarm } = loaded;
    if (alarm.acknowledged_at) {
      return res.status(409).json({ error: 'already_acknowledged', message: 'Alarm was already acknowledged', status: 409 });
    }
    const { rows } = await db.query(
      `UPDATE alarms SET acknowledged_by = $1, acknowledged_at = now(), ack_note = $2
        WHERE id = $3 AND acknowledged_at IS NULL
        RETURNING id, device_id, alarm_code, severity, active, triggered_at, acknowledged_at, ack_note`,
      [req.user ? req.user.id : null, parsed.data.note?.trim() || null, alarm.id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'already_acknowledged', message: 'Alarm was already acknowledged', status: 409 });
    }
    req.auditContext = { entityId: alarm.device_id, action: 'alarm.ack', changes: { alarm_id: alarm.id, alarm_code: alarm.alarm_code, note: parsed.data.note || null } };
    mqttSvc.emit('alarm_ack', {
      tenantSlug: alarm.tenant_slug, tenantId: alarm.tenant_id, deviceId: alarm.device_id,
      alarmId: alarm.id, alarmCode: alarm.alarm_code, acknowledgedBy: req.user ? req.user.email : null,
    });
    res.json({ data: { ...rows[0], acknowledged_by_email: req.user ? req.user.email : null } });
  } catch (err) {
    next(err);
  }
});

// GET /alarms/:id/deliveries — who was notified about this alarm and how (admin)
router.get('/:id/deliveries', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const loaded = await loadAlarmForCaller(req, req.params.id);
    if (loaded.status) return res.status(loaded.status).json({ error: loaded.error, message: loaded.message, status: loaded.status });
    const { rows } = await db.query(
      `SELECT nl.id, nl.channel, nl.status, nl.error_message, nl.created_at,
              u.email AS user_email, ns.label AS subscriber_label, ns.address AS subscriber_address
         FROM notification_log nl
         LEFT JOIN users u ON u.id = nl.user_id
         LEFT JOIN notification_subscribers ns ON ns.id = nl.subscriber_id
        WHERE nl.alarm_id = $1
        ORDER BY nl.created_at ASC`,
      [loaded.alarm.id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
