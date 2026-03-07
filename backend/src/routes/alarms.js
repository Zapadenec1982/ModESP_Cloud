'use strict';

const { Router } = require('express');
const db         = require('../services/db');

const router = Router();

// ── GET /api/alarms ───────────────────────────────────────
// List alarms for current tenant. Query: active (bool), limit, offset
router.get('/', async (req, res, next) => {
  try {
    const active = req.query.active;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql = `
      SELECT a.id, a.device_id, a.alarm_code, a.severity,
             a.active, a.triggered_at, a.cleared_at,
             d.name AS device_name, d.mqtt_device_id
      FROM alarms a
      LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
    `;
    const params = [req.tenantId];

    if (active === 'true') {
      sql += ` AND a.active = true`;
    } else if (active === 'false') {
      sql += ` AND a.active = false`;
    }

    sql += ` ORDER BY a.triggered_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id/alarms ───────────────────────────
// Alarms for a specific device.
router.get('/:id/alarms', async (req, res, next) => {
  try {
    const { id } = req.params;
    const active = req.query.active;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Resolve mqtt_device_id
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const devRes = await db.query(
      `SELECT mqtt_device_id FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }
    const mqttId = devRes.rows[0].mqtt_device_id;

    let sql = `
      SELECT id, alarm_code, severity, active, triggered_at, cleared_at
      FROM alarms
      WHERE tenant_id = $1 AND device_id = $2
    `;
    const params = [req.tenantId, mqttId];

    if (active === 'true') {
      sql += ` AND active = true`;
    } else if (active === 'false') {
      sql += ` AND active = false`;
    }

    sql += ` ORDER BY triggered_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
