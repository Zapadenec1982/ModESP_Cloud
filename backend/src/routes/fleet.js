'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const { filterDeviceAccess } = require('../middleware/device-access');

const router = Router();

// ── GET /api/fleet/summary ──────────────────────────────
// Superadmin sees platform-wide stats; others see tenant-scoped stats.
router.get('/summary', filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';

    // Build WHERE clause depending on role
    let deviceWhere, alarmWhere, deviceParams, alarmParams;

    if (isSuperadmin) {
      // Platform-wide: only active devices, no tenant filter
      deviceWhere = `WHERE status = 'active'`;
      alarmWhere  = `WHERE active = true`;
      deviceParams = [];
      alarmParams  = [];
      // Alarm 24h — same but with time filter
    } else {
      deviceWhere = `WHERE tenant_id = $1`;
      alarmWhere  = `WHERE tenant_id = $1 AND active = true`;
      deviceParams = [req.tenantId];
      alarmParams  = [req.tenantId];
    }

    // Per-device RBAC filter
    if (req.deviceFilter) {
      const idx = deviceParams.length + 1;
      deviceWhere += ` AND id = ANY($${idx})`;
      deviceParams.push(req.deviceFilter);
    }
    if (req.deviceMqttIds) {
      const idx = alarmParams.length + 1;
      alarmWhere += ` AND device_id = ANY($${idx})`;
      alarmParams.push(req.deviceMqttIds);
    }

    // Alarm 24h params (clone alarm params + add time filter)
    const alarm24hWhere = isSuperadmin
      ? `WHERE triggered_at > NOW() - INTERVAL '24 hours'`
      : `WHERE tenant_id = $1 AND triggered_at > NOW() - INTERVAL '24 hours'`;
    let alarm24hFull = alarm24hWhere;
    if (req.deviceMqttIds) {
      const idx = alarmParams.length; // same position as in alarmParams
      alarm24hFull += ` AND device_id = ANY($${idx})`;
    }

    const [devicesRes, activeAlarmsRes, recentAlarmsRes] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE online = true)::int  AS online,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active
        FROM devices
        ${deviceWhere}
      `, deviceParams),

      db.query(`
        SELECT COUNT(*)::int AS count
        FROM alarms
        ${alarmWhere}
      `, alarmParams),

      db.query(`
        SELECT COUNT(*)::int AS count
        FROM alarms
        ${alarm24hFull}
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
