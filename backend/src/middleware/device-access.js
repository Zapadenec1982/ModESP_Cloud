'use strict';

const db = require('../services/db');
const { isUuidFormat } = require('../lib/ids');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
// Safety cap. A single site grant covers every device on that site (a store with
// 10 cabinets × 60 stores = 600), so the old 500 was reachable by normal usage.
const MAX_DEVICE_FILTER = 5000;

/**
 * Middleware for list endpoints (GET /devices, GET /alarms, GET /fleet/summary).
 * Loads user's assigned device IDs into req.deviceFilter (UUID[])
 * and req.deviceMqttIds (string[]).
 *
 * The accessible set is per-device grants (user_devices) UNION site grants
 * (user_sites → devices on that site). Both grant tables are scoped to
 * req.tenantId: a user can belong to several tenants (user_tenants /
 * switch-tenant), so a grant held in tenant B must never widen tenant A.
 *
 * Admin or AUTH_ENABLED=false → req.deviceFilter = null (no restriction).
 * Technician/Viewer → req.deviceFilter = UUID[], req.deviceMqttIds = string[].
 * An empty grant set yields [] — never null, which would mean "no restriction".
 */
function filterDeviceAccess() {
  return async (req, res, next) => {
    // Bypass when auth disabled or user not present
    if (!AUTH_ENABLED || !req.user) {
      req.deviceFilter = null;
      req.deviceMqttIds = null;
      return next();
    }

    // Admin and superadmin see everything. So does an API key: it stands for
    // the organisation (created by an admin), not for one person's grants.
    if (req.user.role === 'admin' || req.user.role === 'superadmin' || req.user.apiKey) {
      req.deviceFilter = null;
      req.deviceMqttIds = null;
      return next();
    }

    try {
      const { rows } = await db.query(
        `SELECT DISTINCT d.id AS device_id, d.mqtt_device_id
         FROM devices d
         LEFT JOIN user_devices ud ON ud.device_id = d.id AND ud.user_id = $1
         LEFT JOIN sites       s  ON s.id = d.site_id AND s.tenant_id = d.tenant_id
         LEFT JOIN user_sites  us ON us.site_id = s.id AND us.user_id = $1 AND us.tenant_id = $2
         WHERE d.tenant_id = $2
           AND (ud.user_id IS NOT NULL OR us.user_id IS NOT NULL)
         ORDER BY d.id
         LIMIT $3`,
        [req.user.id, req.tenantId, MAX_DEVICE_FILTER + 1]
      );

      // Truncation is never silent: an access set that was cut short is a security
      // event, not a paging detail. ORDER BY d.id makes the surviving slice stable
      // between requests, so the same devices stay visible until a grant changes.
      if (rows.length > MAX_DEVICE_FILTER) {
        rows.length = MAX_DEVICE_FILTER;
        req.deviceFilterOverflow = true;
        const ctx = { userId: req.user.id, tenantId: req.tenantId, count: MAX_DEVICE_FILTER };
        req.log?.warn?.(ctx, 'device filter cap reached — access set truncated')
          || console.warn('device filter cap reached — access set truncated', ctx);
      }

      req.deviceFilter  = rows.map(r => r.device_id);
      req.deviceMqttIds = rows.map(r => r.mqtt_device_id);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * One device by UUID or mqtt_device_id, if this user holds a grant on it.
 * The grant is user_devices ∪ user_sites, the same union filterDeviceAccess()
 * builds the list from — the two must agree, or a site-granted device would
 * appear in the list and be refused on the detail route.
 *
 * Callers that bypass grants (admin, superadmin, an organisation-wide API key,
 * AUTH_ENABLED=false) must not call this: it answers the grant question only.
 *
 * Exported because the WebSocket layer asks the same question about the same
 * devices. It used to ask a narrower one — user_devices alone — so a technician
 * who reaches a device through a site grant could read it over REST and was
 * refused live data on the very same device.
 *
 * @returns {Promise<string|null>} the device UUID, or null when no grant reaches it
 */
async function grantedDeviceId(userId, tenantId, id) {
  const deviceField = isUuidFormat(id) ? 'd.id' : 'd.mqtt_device_id';
  const { rows } = await db.query(
    `SELECT d.id
     FROM devices d
     LEFT JOIN user_devices ud ON ud.device_id = d.id AND ud.user_id = $1
     LEFT JOIN sites       s  ON s.id = d.site_id AND s.tenant_id = d.tenant_id
     LEFT JOIN user_sites  us ON us.site_id = s.id AND us.user_id = $1 AND us.tenant_id = $3
     WHERE ${deviceField} = $2 AND d.tenant_id = $3
       AND (ud.user_id IS NOT NULL OR us.user_id IS NOT NULL)
     LIMIT 1`,
    [userId, id, tenantId]
  );
  return rows.length === 0 ? null : rows[0].id;
}

/**
 * Every mqtt_device_id this user holds a grant on, as a Set. The WebSocket layer
 * uses it to decide which tenant-wide events a client may see; REST list routes
 * use filterDeviceAccess() instead, which needs the UUIDs as well.
 *
 * @returns {Promise<Set<string>>}
 */
async function grantedMqttIds(userId, tenantId) {
  const { rows } = await db.query(
    `SELECT DISTINCT d.mqtt_device_id
     FROM devices d
     LEFT JOIN user_devices ud ON ud.device_id = d.id AND ud.user_id = $1
     LEFT JOIN sites       s  ON s.id = d.site_id AND s.tenant_id = d.tenant_id
     LEFT JOIN user_sites  us ON us.site_id = s.id AND us.user_id = $1 AND us.tenant_id = $2
     WHERE d.tenant_id = $2
       AND (ud.user_id IS NOT NULL OR us.user_id IS NOT NULL)
     LIMIT $3`,
    [userId, tenantId, MAX_DEVICE_FILTER]
  );
  return new Set(rows.map(r => r.mqtt_device_id));
}

/**
 * Middleware for single-device endpoints (GET /devices/:id, POST /:id/command, etc.).
 * Verifies user has access to the device specified by req.params.id.
 *
 * Admin or AUTH_ENABLED=false → pass.
 * Technician/Viewer → grantedDeviceId(); 403 if no grant reaches the device.
 *
 * On success, caches req.resolvedDeviceId (UUID) to avoid repeated lookups.
 */
function checkDeviceAccess() {
  return async (req, res, next) => {
    // Bypass when auth disabled or user not present
    if (!AUTH_ENABLED || !req.user) {
      return next();
    }

    // Admin, superadmin and organisation-wide API keys bypass
    if (req.user.role === 'admin' || req.user.role === 'superadmin' || req.user.apiKey) {
      return next();
    }

    const id = req.params.id;
    if (!id) return next();

    try {
      const deviceId = await grantedDeviceId(req.user.id, req.tenantId, id);
      if (!deviceId) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Device access denied',
          status: 403,
        });
      }

      // Cache resolved device UUID to avoid repeated lookups in handler
      req.resolvedDeviceId = deviceId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { filterDeviceAccess, checkDeviceAccess, grantedDeviceId, grantedMqttIds };
