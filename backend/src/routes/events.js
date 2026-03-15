'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const { checkDeviceAccess } = require('../middleware/device-access');

const router = Router();

// ── GET /api/devices/:id/events ──────────────────────────
// Per-device events list. Query: event_type, from, to, limit, offset
router.get('/:id/events', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
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
      SELECT id, event_type, payload, time
      FROM events
      WHERE tenant_id = $1 AND device_id = $2
    `;
    const params = [deviceTenantId, mqttId];
    let idx = 3;

    if (req.query.event_type) {
      sql += ` AND event_type = $${idx++}`;
      params.push(req.query.event_type);
    }

    if (req.query.from) {
      sql += ` AND time >= $${idx++}`;
      params.push(new Date(req.query.from));
    }
    if (req.query.to) {
      sql += ` AND time < $${idx++}`;
      params.push(new Date(req.query.to));
    }

    sql += ` ORDER BY time DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
