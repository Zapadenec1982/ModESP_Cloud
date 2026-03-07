'use strict';

const { Router } = require('express');
const db         = require('../services/db');

const router = Router();

// ── GET /api/alarms ───────────────────────────────────────
// List alarms for current tenant. Query: active (bool), from, to, limit, offset
router.get('/', async (req, res, next) => {
  try {
    const active = req.query.active;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let sql = `
      SELECT a.id, a.device_id, a.alarm_code, a.severity,
             a.active, a.value, a.limit_value,
             a.triggered_at, a.cleared_at,
             d.name AS device_name, d.mqtt_device_id
      FROM alarms a
      LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
    `;
    const params = [req.tenantId];
    let idx = 2;

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
router.get('/stats', async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const { rows } = await db.query(`
      SELECT
        alarm_code,
        COUNT(*)::int AS count,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(cleared_at, NOW()) - triggered_at))))::int AS avg_duration_sec
      FROM alarms
      WHERE tenant_id = $1
        AND triggered_at >= $2
        AND triggered_at < $3
      GROUP BY alarm_code
      ORDER BY count DESC
    `, [req.tenantId, from, to]);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id/alarms ───────────────────────────
// Alarms for a specific device. Query: active, from, to, limit, offset
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
      SELECT id, alarm_code, severity, active, value, limit_value,
             triggered_at, cleared_at
      FROM alarms
      WHERE tenant_id = $1 AND device_id = $2
    `;
    const params = [req.tenantId, mqttId];
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
