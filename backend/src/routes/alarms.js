'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');

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
               d.name AS device_name, d.mqtt_device_id,
               t.slug AS tenant_slug, t.name AS tenant_name
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
        LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE 1=1
      `;
      params = [];
      idx = 1;
    } else {
      sql = `
        SELECT a.id, a.device_id, a.alarm_code, a.severity,
               a.active, a.value, a.limit_value,
               a.triggered_at, a.cleared_at,
               d.name AS device_name, d.mqtt_device_id
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
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
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    let sql = `
      SELECT
        alarm_code,
        COUNT(*)::int AS count,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(cleared_at, NOW()) - triggered_at))))::int AS avg_duration_sec
      FROM alarms
      WHERE tenant_id = $1
        AND triggered_at >= $2
        AND triggered_at < $3
    `;
    const params = [req.tenantId, from, to];

    // Per-device RBAC
    if (req.deviceMqttIds) {
      sql += ` AND device_id = ANY($4)`;
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
    const isUuid = id.length > 8;
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

module.exports = router;
