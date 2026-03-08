'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const { filterDeviceAccess } = require('../middleware/device-access');

const router = Router();

// ── GET /api/fleet/summary ──────────────────────────────
router.get('/summary', filterDeviceAccess(), async (req, res, next) => {
  try {
    // Build WHERE clause for per-device RBAC
    const deviceFilterSql = req.deviceFilter
      ? ` AND id = ANY($2)`
      : '';
    const deviceParams = req.deviceFilter
      ? [req.tenantId, req.deviceFilter]
      : [req.tenantId];

    const alarmFilterSql = req.deviceMqttIds
      ? ` AND device_id = ANY($2)`
      : '';
    const alarmParams = req.deviceMqttIds
      ? [req.tenantId, req.deviceMqttIds]
      : [req.tenantId];

    const [devicesRes, activeAlarmsRes, recentAlarmsRes] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE online = true)::int  AS online,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active
        FROM devices
        WHERE tenant_id = $1${deviceFilterSql}
      `, deviceParams),

      db.query(`
        SELECT COUNT(*)::int AS count
        FROM alarms
        WHERE tenant_id = $1 AND active = true${alarmFilterSql}
      `, alarmParams),

      db.query(`
        SELECT COUNT(*)::int AS count
        FROM alarms
        WHERE tenant_id = $1
          AND triggered_at > NOW() - INTERVAL '24 hours'${alarmFilterSql}
      `, alarmParams),
    ]);

    const devices = devicesRes.rows[0];

    res.json({
      data: {
        devices_total:  devices.total,
        devices_online: devices.online,
        devices_active: devices.active,
        alarms_active:  activeAlarmsRes.rows[0].count,
        alarms_24h:     recentAlarmsRes.rows[0].count,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
