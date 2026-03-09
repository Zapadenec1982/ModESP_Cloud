'use strict';

const db = require('../services/db');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const MAX_DEVICE_FILTER = 500; // safety cap

/**
 * Middleware for list endpoints (GET /devices, GET /alarms, GET /fleet/summary).
 * Loads user's assigned device IDs into req.deviceFilter (UUID[])
 * and req.deviceMqttIds (string[]).
 *
 * Admin or AUTH_ENABLED=false → req.deviceFilter = null (no restriction).
 * Technician/Viewer → req.deviceFilter = UUID[], req.deviceMqttIds = string[].
 */
function filterDeviceAccess() {
  return async (req, res, next) => {
    // Bypass when auth disabled or user not present
    if (!AUTH_ENABLED || !req.user) {
      req.deviceFilter = null;
      req.deviceMqttIds = null;
      return next();
    }

    // Admin and superadmin see everything
    if (req.user.role === 'admin' || req.user.role === 'superadmin') {
      req.deviceFilter = null;
      req.deviceMqttIds = null;
      return next();
    }

    try {
      const { rows } = await db.query(
        `SELECT ud.device_id, d.mqtt_device_id
         FROM user_devices ud
         JOIN devices d ON d.id = ud.device_id
         WHERE ud.user_id = $1 AND d.tenant_id = $2
         LIMIT $3`,
        [req.user.id, req.tenantId, MAX_DEVICE_FILTER]
      );

      req.deviceFilter  = rows.map(r => r.device_id);
      req.deviceMqttIds = rows.map(r => r.mqtt_device_id);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Middleware for single-device endpoints (GET /devices/:id, POST /:id/command, etc.).
 * Verifies user has access to the device specified by req.params.id.
 *
 * Admin or AUTH_ENABLED=false → pass.
 * Technician/Viewer → single JOIN query; 403 if no access.
 *
 * On success, caches req.resolvedDeviceId (UUID) to avoid repeated lookups.
 */
function checkDeviceAccess() {
  return async (req, res, next) => {
    // Bypass when auth disabled or user not present
    if (!AUTH_ENABLED || !req.user) {
      return next();
    }

    // Admin and superadmin bypass
    if (req.user.role === 'admin' || req.user.role === 'superadmin') {
      return next();
    }

    const id = req.params.id;
    if (!id) return next();

    try {
      const isUuid = id.length > 8;
      const deviceField = isUuid ? 'd.id' : 'd.mqtt_device_id';

      const { rows } = await db.query(
        `SELECT d.id
         FROM devices d
         JOIN user_devices ud ON ud.device_id = d.id AND ud.user_id = $1
         WHERE ${deviceField} = $2 AND d.tenant_id = $3
         LIMIT 1`,
        [req.user.id, id, req.tenantId]
      );

      if (rows.length === 0) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Device access denied',
          status: 403,
        });
      }

      // Cache resolved device UUID to avoid repeated lookups in handler
      req.resolvedDeviceId = rows[0].id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { filterDeviceAccess, checkDeviceAccess };
