'use strict';

const { Router } = require('express');
const db         = require('../services/db');

const router = Router();

// ── GET /api/devices/:id/telemetry ────────────────────────
// Query params: hours (default 24), channels (comma-separated, default all)
router.get('/:id/telemetry', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours    = Math.min(parseInt(req.query.hours, 10) || 24, 168); // max 7 days
    const channels = req.query.channels
      ? req.query.channels.split(',').map(c => c.trim())
      : null;

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

    // Build query
    let sql = `
      SELECT time, channel, value
      FROM telemetry
      WHERE tenant_id = $1
        AND device_id = $2
        AND time > NOW() - INTERVAL '1 hour' * $3
    `;
    const params = [req.tenantId, mqttId, hours];

    if (channels && channels.length > 0) {
      sql += ` AND channel = ANY($4)`;
      params.push(channels);
    }

    sql += ` ORDER BY time ASC`;

    const { rows } = await db.query(sql, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
