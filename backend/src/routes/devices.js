'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const mqttAuth   = require('../services/mqtt-auth');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const stateMeta  = require('../config/state_meta.json');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

const router = Router();

// Build Set of writable keys for command validation
const writableKeys = new Set(stateMeta.subscribeKeys);

// Auth helper: skip authorize middleware when AUTH_ENABLED=false
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

/**
 * Resolve the actual MQTT topic slug to reach a device.
 * Prefers the observed slug from stateMap (where device is really publishing)
 * over the DB tenant slug (where we *think* it should be).
 */
async function resolveRoutingSlug(mqttId, tenantId) {
  // DB fallback: look up tenant slug
  const tenantRes = await db.query(
    `SELECT slug FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const dbSlug = tenantRes.rows[0]?.slug || 'pending';
  // Prefer observed slug from live MQTT data
  return mqttSvc.getDeviceRoutingSlug(mqttId, dbSlug);
}

// ── GET /api/devices ──────────────────────────────────────
// List devices. Superadmin sees ALL active devices cross-tenant.
// Admin/tech/viewer see only their tenant (+ per-device RBAC for non-admin).
router.get('/', filterDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';

    let sql, params;
    if (isSuperadmin) {
      // Cross-tenant: all active devices with tenant info
      sql = `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.serial_number,
                    d.model, d.comment, d.manufactured_at, d.firmware_version,
                    d.online, d.status, d.last_seen, d.created_at,
                    t.slug AS tenant_slug, t.name AS tenant_name
             FROM devices d
             LEFT JOIN tenants t ON t.id = d.tenant_id
             WHERE d.status = 'active'`;
      params = [];
    } else {
      sql = `SELECT id, mqtt_device_id, name, location, serial_number,
                    model, comment, manufactured_at, firmware_version,
                    online, status, last_seen, created_at
             FROM devices
             WHERE tenant_id = $1`;
      params = [req.tenantId];
    }

    // Per-device RBAC: non-admin users see only assigned devices
    if (req.deviceFilter) {
      const idx = params.length + 1;
      sql += ` AND ${isSuperadmin ? 'd.' : ''}id = ANY($${idx})`;
      params.push(req.deviceFilter);
    }

    sql += ` ORDER BY ${isSuperadmin ? 'd.' : ''}name NULLS LAST, ${isSuperadmin ? 'd.' : ''}mqtt_device_id`;

    const { rows } = await db.query(sql, params);

    // Augment with live alarm_active from stateMap
    const devices = rows.map(row => {
      const live = mqttSvc.getDeviceState(row.mqtt_device_id);
      const meta = mqttSvc.getDeviceMeta(row.mqtt_device_id);
      return {
        ...row,
        // Override online status with live data if available
        online:       meta ? meta.online : row.online,
        last_seen:    meta ? new Date(meta.lastSeen).toISOString() : row.last_seen,
        alarm_active: live ? !!live['protection.alarm_active'] : false,
        air_temp:     live ? live['equipment.air_temp'] ?? null : null,
      };
    });

    res.json({ data: devices });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/pending ──────────────────────────────
// List pending (unassigned) devices — from SYSTEM tenant.
router.get('/pending', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, firmware_version, online, last_seen, created_at
       FROM devices
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [db.SYSTEM_TENANT_ID]
    );

    const devices = rows.map(row => {
      const meta = mqttSvc.getDeviceMeta(row.mqtt_device_id);
      return {
        ...row,
        online:   meta ? meta.online : row.online,
        last_seen: meta ? new Date(meta.lastSeen).toISOString() : row.last_seen,
      };
    });

    res.json({ data: devices });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/pending/:mqttId ────────────────────
// Delete a pending device from the system (any admin).
// Allows re-registration of the same device_id.
router.delete('/pending/:mqttId', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { mqttId } = req.params;

    // Find pending device in SYSTEM tenant
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id FROM devices
       WHERE mqtt_device_id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [mqttId, db.SYSTEM_TENANT_ID]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Pending device ${mqttId} not found`,
        status: 404,
      });
    }

    const deviceUuid = rows[0].id;
    const deviceMqttId = rows[0].mqtt_device_id;

    // Delete related records (alarms/telemetry/events use VARCHAR device_id, not FK)
    await db.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
    // user_devices + service_records have ON DELETE CASCADE, but explicit is safer
    await db.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
    await db.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);
    // Delete the device itself
    await db.query(`DELETE FROM devices WHERE id = $1`, [deviceUuid]);

    // Clean up in-memory state + refresh registries immediately
    mqttSvc.removeDeviceState(deviceMqttId);
    await mqttSvc.refreshRegistries();

    res.json({ data: { deleted: true, mqtt_device_id: deviceMqttId } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/reset-pending ──────────────────
// Reset a stuck device back to pending status with bootstrap credentials.
// Use when device was assigned but failed to save new MQTT credentials.
router.post('/:id/reset-pending', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    // Look up device
    let whereClause, params;
    if (isSuperAdmin) {
      whereClause = isUuid ? 'id = $1' : 'mqtt_device_id = $1';
      params = [id];
    } else {
      whereClause = isUuid
        ? 'id = $1 AND tenant_id = $2'
        : 'mqtt_device_id = $1 AND tenant_id = $2';
      params = [id, req.tenantId];
    }

    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, status FROM devices WHERE ${whereClause}`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = rows[0].id;
    const deviceMqttId = rows[0].mqtt_device_id;

    // Get bootstrap password hash
    const bootstrapKey = process.env.MQTT_BOOTSTRAP_PASSWORD;
    if (!bootstrapKey) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Bootstrap password not configured',
        status: 503,
      });
    }

    const bcrypt = require('bcrypt');
    const bootstrapHash = await bcrypt.hash(bootstrapKey, 12);

    // Reset device: move to SYSTEM tenant, set status to pending, restore bootstrap creds
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE devices
         SET tenant_id = $1, status = 'pending',
             mqtt_username = $2, mqtt_password_hash = $3
         WHERE id = $4`,
        [db.SYSTEM_TENANT_ID, `device_${deviceMqttId}`, bootstrapHash, deviceUuid]
      );

      // Clear per-device RBAC
      await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Clean up in-memory state
    mqttSvc.removeDeviceState(deviceMqttId);
    await mqttSvc.refreshRegistries();

    res.json({
      data: {
        device_id: deviceUuid,
        mqtt_device_id: deviceMqttId,
        status: 'pending',
        reset: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/:id ───────────────────────────────
// Delete a device (admin: own tenant, superadmin: any).
// Active/disabled devices → soft reset to pending (keeps go-auth credentials).
// Pending devices → hard delete (device can reconnect via go-auth bootstrap fallback).
router.delete('/:id', maybeAuthorize('admin'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    let whereClause, params;
    if (isSuperAdmin) {
      whereClause = isUuid ? 'id = $1' : 'mqtt_device_id = $1';
      params = [id];
    } else {
      whereClause = isUuid
        ? 'id = $1 AND tenant_id = $2'
        : 'mqtt_device_id = $1 AND tenant_id = $2';
      params = [id, req.tenantId];
    }

    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, status FROM devices WHERE ${whereClause}`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = rows[0].id;
    const deviceMqttId = rows[0].mqtt_device_id;
    const deviceStatus = rows[0].status;

    // Clear all history data regardless of status
    await db.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
    await db.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);

    if (deviceStatus === 'pending') {
      // Pending → hard delete (go-auth bootstrap fallback will let device reconnect)
      await db.query(`DELETE FROM devices WHERE id = $1`, [deviceUuid]);
      mqttSvc.removeDeviceState(deviceMqttId);
      await mqttSvc.refreshRegistries();

      res.json({ data: { deleted: true, mqtt_device_id: deviceMqttId } });
    } else {
      // Active/disabled → soft reset to pending with bootstrap credentials
      const bootstrapHash = mqttSvc.getBootstrapHash();
      if (!bootstrapHash) {
        // Fallback: hard delete if bootstrap not configured
        await db.query(`DELETE FROM devices WHERE id = $1`, [deviceUuid]);
        mqttSvc.removeDeviceState(deviceMqttId);
        await mqttSvc.refreshRegistries();
        return res.json({ data: { deleted: true, mqtt_device_id: deviceMqttId } });
      }

      await db.query(
        `UPDATE devices
         SET tenant_id = $1, status = 'pending',
             mqtt_username = $2, mqtt_password_hash = $3,
             name = NULL, location = NULL, serial_number = NULL,
             model = NULL, comment = NULL, manufactured_at = NULL,
             firmware_version = NULL, last_state = NULL, online = false
         WHERE id = $4`,
        [db.SYSTEM_TENANT_ID, `device_${deviceMqttId}`, bootstrapHash, deviceUuid]
      );

      mqttSvc.removeDeviceState(deviceMqttId);
      await mqttSvc.refreshRegistries();

      res.json({
        data: { reset: true, deleted_history: true, mqtt_device_id: deviceMqttId, new_status: 'pending' },
      });
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/pending/:mqttId/assign ──────────────
// Assign a pending device to the current tenant.
// Body: { name?: string, location?: string }
router.post('/pending/:mqttId/assign', async (req, res, next) => {
  try {
    const { mqttId } = req.params;
    const { name, location, model, serial_number, comment, tenant_id } = req.body || {};

    // Superadmin can assign to any tenant; regular admin assigns to own tenant
    const isSuperAdmin = req.user && req.user.role === 'superadmin';
    const targetTenantId = (isSuperAdmin && tenant_id) ? tenant_id : req.tenantId;

    // Verify device exists and is pending
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, status FROM devices
       WHERE mqtt_device_id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [mqttId, db.SYSTEM_TENANT_ID]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Pending device ${mqttId} not found`,
        status: 404,
      });
    }

    // Look up tenant slug for MQTT command
    const tenantRes = await db.query(
      `SELECT slug FROM tenants WHERE id = $1`,
      [targetTenantId]
    );
    if (tenantRes.rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_tenant',
        message: 'Tenant not found',
        status: 400,
      });
    }
    const tenantSlug = tenantRes.rows[0].slug;

    // Generate unique MQTT credentials (password in plain text for MQTT delivery)
    const newUsername = `device_${mqttId}`;
    const newPassword = mqttAuth.generatePassword();

    // Send credentials + tenant via MQTT BEFORE changing DB status.
    // The device is still 'pending', so Mosquitto ACL allows delivery on
    // the pending topic. If we changed status first, ACL would block delivery
    // because the device would need the new tenant prefix.
    let sentCreds = false;
    try {
      // 1. Send credentials first (firmware saves but does NOT reconnect)
      mqttSvc.sendJsonCommand('pending', mqttId, '_set_mqtt_creds', {
        username: newUsername,
        password: newPassword,
      });
      sentCreds = true;
    } catch (err) {
      // MQTT unavailable — admin will see credentials in response for manual entry
    }

    let sentTenant = false;
    try {
      // 2. Send tenant (firmware saves + reconnects with new credentials)
      // QoS 1 for reliability — this is a critical configuration command
      mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug, { qos: 1 });
      sentTenant = true;
    } catch (err) {
      // MQTT might be disconnected — device will get the command on reconnect
    }

    // Now update DB: move device to tenant, set status active, store hashed password
    const hash = await require('bcrypt').hash(newPassword, 12);
    await db.query(
      `UPDATE devices
       SET tenant_id = $1, status = 'active',
           mqtt_username = $2, mqtt_password_hash = $3,
           name = COALESCE($4, name), location = COALESCE($5, location),
           model = COALESCE($6, model), serial_number = COALESCE($7, serial_number),
           comment = COALESCE($8, comment)
       WHERE id = $9`,
      [targetTenantId, newUsername, hash, name || null, location || null,
       model || null, serial_number || null, comment || null, rows[0].id]
    );

    // Record assign timestamp for stuck-device detection grace period
    mqttSvc.recordAssign(mqttId);

    await mqttSvc.refreshRegistries();

    res.json({
      data: {
        device_id: rows[0].id,
        mqtt_device_id: mqttId,
        tenant_id: targetTenantId,
        status: 'active',
        tenant_slug: tenantSlug,
        mqtt_credentials: {
          username: newUsername,
          password: newPassword,
          mqtt_host: process.env.MQTT_PUBLIC_HOST || req.hostname,
          mqtt_port: 8883,
          sent_via_mqtt: sentCreds,
        },
        mqtt_commands_sent: sentCreds && sentTenant,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id ──────────────────────────────────
// Full device detail: DB record + live state from stateMap.
router.get('/:id', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;

    // Support both UUID and mqtt_device_id
    const isUuid = id.length > 8;
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    // Superadmin can view any device; regular users scoped to their tenant
    let whereClause, params;
    if (isSuperAdmin) {
      whereClause = isUuid ? 'd.id = $1' : 'd.mqtt_device_id = $1';
      params = [id];
    } else {
      whereClause = isUuid
        ? 'd.id = $1 AND d.tenant_id = $2'
        : 'd.mqtt_device_id = $1 AND d.tenant_id = $2';
      params = [id, req.tenantId];
    }

    const { rows } = await db.query(
      `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.serial_number,
              d.model, d.comment, d.manufactured_at, d.firmware_version, d.proto_version,
              d.online, d.status, d.last_seen, d.last_state, d.created_at,
              d.mqtt_username, (d.mqtt_password_hash IS NOT NULL) AS has_mqtt_credentials,
              d.tenant_id, t.slug AS tenant_slug
       FROM devices d
       JOIN tenants t ON t.id = d.tenant_id
       WHERE ${whereClause}`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const device = rows[0];
    const mqttId = device.mqtt_device_id;

    // Merge DB last_state with live stateMap
    const liveState = mqttSvc.getDeviceState(mqttId);
    const meta      = mqttSvc.getDeviceMeta(mqttId);
    const mergedState = {
      ...(device.last_state || {}),
      ...(liveState || {}),
    };

    // Fetch users with access to this device
    let users = [];
    if (AUTH_ENABLED) {
      const usersRes = await db.query(
        `SELECT u.id, u.email, u.role
         FROM user_devices ud
         JOIN users u ON u.id = ud.user_id
         WHERE ud.device_id = $1 AND u.tenant_id = $2 AND u.active = true
         ORDER BY u.email`,
        [device.id, req.tenantId]
      );
      users = usersRes.rows;
    }

    res.json({
      data: {
        ...device,
        online:     meta ? meta.online : device.online,
        last_seen:  meta ? new Date(meta.lastSeen).toISOString() : device.last_seen,
        last_state: mergedState,
        users,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/mqtt-credentials ────────────────
// Generate or rotate MQTT credentials. Returns plaintext password once.
// Attempts to send via MQTT for zero-touch; falls back to manual display.
router.post('/:id/mqtt-credentials', maybeAuthorize('admin'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, status, mqtt_password_hash FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const device = rows[0];
    const isRotation = device.mqtt_password_hash != null;
    const creds = isRotation
      ? await mqttAuth.rotatePassword(req.tenantId, device.mqtt_device_id)
      : await mqttAuth.provisionDevice(req.tenantId, device.mqtt_device_id);

    // Try to send via MQTT (zero-touch)
    let sent = false;
    try {
      const routingSlug = await resolveRoutingSlug(device.mqtt_device_id, req.tenantId);
      mqttSvc.sendJsonCommand(routingSlug, device.mqtt_device_id, '_set_mqtt_creds', {
        username: creds.username,
        password: creds.password,
      });
      sent = true;
    } catch (err) {
      // MQTT unavailable — fallback to manual
    }

    res.json({
      data: {
        ...creds,
        mqtt_host: process.env.MQTT_PUBLIC_HOST || req.hostname,
        mqtt_port: 8883,
        sent_via_mqtt: sent,
        rotated: isRotation,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/:id/mqtt-credentials ──────────────
// Revoke MQTT credentials — device can no longer connect.
router.delete('/:id/mqtt-credentials', maybeAuthorize('admin'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const { rows } = await db.query(
      `SELECT mqtt_device_id FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    await mqttAuth.revokeCredentials(req.tenantId, rows[0].mqtt_device_id);

    res.json({ data: { revoked: true } });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/devices/:id ────────────────────────────────
// Update device properties (name, location, serial_number, model, comment, manufactured_at).
const updateDeviceSchema = z.object({
  name:            z.string().max(128).optional(),
  location:        z.string().max(256).optional(),
  serial_number:   z.string().max(64).optional(),
  model:           z.string().max(64).optional(),
  comment:         z.string().max(2000).optional(),
  manufactured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional().nullable(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field is required',
});

router.patch('/:id', maybeAuthorize('admin', 'technician'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const parsed = updateDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.errors[0]?.message || 'Invalid input',
        status: 400,
      });
    }

    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereField = isUuid ? 'id' : 'mqtt_device_id';

    // Build dynamic SET clause
    const fields = parsed.data;
    const keys = Object.keys(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map(k => fields[k] || null);

    // tenant_id param index
    const tenantIdx = values.length + 1;
    const idIdx = values.length + 2;

    const { rows } = await db.query(
      `UPDATE devices
       SET ${setClauses.join(', ')}
       WHERE ${whereField} = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING id, mqtt_device_id, name, location, serial_number,
                 model, comment, manufactured_at, firmware_version, status, created_at`,
      [...values, req.tenantId, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/command ─────────────────────────
// Send a command to a device. Body: { key, value }
router.post('/:id/command', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { key, value } = req.body || {};

    if (!key || value === undefined) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'key and value are required',
        status: 400,
      });
    }

    // Validate the key is writable
    if (!writableKeys.has(key)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Key "${key}" is not a writable parameter`,
        status: 400,
      });
    }

    // Look up device (including status to determine MQTT topic prefix)
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const { rows } = await db.query(
      `SELECT mqtt_device_id, status FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const mqttId = rows[0].mqtt_device_id;

    // Use observed MQTT slug (where device actually publishes) with DB fallback
    const tenantSlug = await resolveRoutingSlug(mqttId, req.tenantId);

    mqttSvc.sendCommand(tenantSlug, mqttId, key, value);

    res.json({
      data: { device_id: mqttId, key, value, sent: true },
    });
  } catch (err) {
    if (err.message === 'MQTT not connected') {
      return res.status(503).json({
        error: 'mqtt_unavailable',
        message: 'MQTT broker is not connected',
        status: 503,
      });
    }
    next(err);
  }
});

// ── POST /api/devices/:id/request-state ───────────────────
// Ask device to republish all 48 state keys (clears ESP32 publish cache).
router.post('/:id/request-state', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const { rows } = await db.query(
      `SELECT mqtt_device_id, status FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const mqttId = rows[0].mqtt_device_id;

    // Use observed MQTT slug (where device actually publishes) with DB fallback
    const tenantSlug = await resolveRoutingSlug(mqttId, req.tenantId);

    mqttSvc.requestFullState(tenantSlug, mqttId);

    res.json({
      data: { device_id: mqttId, requested: true },
    });
  } catch (err) {
    if (err.message === 'MQTT not connected') {
      return res.status(503).json({
        error: 'mqtt_unavailable',
        message: 'MQTT broker is not connected',
        status: 503,
      });
    }
    next(err);
  }
});

// ── GET /api/devices/:id/service-records ────────────────
// List service records for a device.
router.get('/:id/service-records', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    // Resolve device UUID (service_records references device.id)
    const devRes = await db.query(
      `SELECT id FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = devRes.rows[0].id;
    const { rows } = await db.query(
      `SELECT id, service_date, technician, reason, work_done, created_at
       FROM service_records
       WHERE device_id = $1 AND tenant_id = $2
       ORDER BY service_date DESC`,
      [deviceUuid, req.tenantId]
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/service-records ───────────────
// Add a service record for a device.
const serviceRecordSchema = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  technician:   z.string().min(1).max(128),
  reason:       z.string().min(1).max(2000),
  work_done:    z.string().min(1).max(2000),
});

router.post('/:id/service-records', maybeAuthorize('admin', 'technician'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const parsed = serviceRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.errors[0]?.message || 'Invalid input',
        status: 400,
      });
    }

    const { id } = req.params;
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const devRes = await db.query(
      `SELECT id FROM devices WHERE ${whereClause}`,
      [id, req.tenantId]
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = devRes.rows[0].id;
    const { service_date, technician, reason, work_done } = parsed.data;

    const { rows } = await db.query(
      `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, service_date, technician, reason, work_done, created_at`,
      [req.tenantId, deviceUuid, service_date, technician, reason, work_done]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/:deviceId/service-records/:recordId ─
// Remove a service record.
router.delete('/:id/service-records/:recordId', maybeAuthorize('admin', 'technician'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { recordId } = req.params;

    const { rowCount } = await db.query(
      `DELETE FROM service_records WHERE id = $1 AND tenant_id = $2`,
      [recordId, req.tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Service record not found',
        status: 404,
      });
    }

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/reassign ──────────────────────────
// Move device to a different tenant (superadmin only).
// Rotates MQTT credentials and sends _set_tenant command.
router.post('/:id/reassign', async (req, res, next) => {
  try {
    // Only superadmin can reassign across tenants
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Superadmin access required',
        status: 403,
      });
    }

    const reassignSchema = z.object({
      tenant_id: z.string().uuid(),
    });
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.errors.map(e => e.message).join(', '),
        status: 400,
      });
    }

    const { tenant_id: newTenantId } = parsed.data;
    const { id } = req.params;

    // Reject reassign to __system__ tenant
    if (newTenantId === db.SYSTEM_TENANT_ID) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Cannot reassign device to the system tenant',
        status: 400,
      });
    }

    // Look up device (support both UUID and mqtt_device_id)
    const isUuid = id.length > 8;
    const whereField = isUuid ? 'id' : 'mqtt_device_id';
    const deviceRes = await db.query(
      `SELECT d.id, d.mqtt_device_id, d.tenant_id, d.status, t.slug AS old_slug
       FROM devices d
       JOIN tenants t ON t.id = d.tenant_id
       WHERE d.${whereField} = $1`,
      [id]
    );

    if (deviceRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Device not found',
        status: 404,
      });
    }

    const device = deviceRes.rows[0];

    // Reject if same tenant
    if (device.tenant_id === newTenantId) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Device is already in this tenant',
        status: 400,
      });
    }

    // Verify target tenant exists and is active
    const tenantRes = await db.query(
      `SELECT id, slug, active FROM tenants WHERE id = $1`,
      [newTenantId]
    );
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Target tenant not found',
        status: 404,
      });
    }
    if (!tenantRes.rows[0].active) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Target tenant is inactive',
        status: 400,
      });
    }

    const newSlug = tenantRes.rows[0].slug;
    const oldSlug = device.old_slug;
    const mqttId = device.mqtt_device_id;

    // Transaction: move device + clear RBAC
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Move device to new tenant
      await client.query(
        `UPDATE devices SET tenant_id = $1, status = 'active' WHERE id = $2`,
        [newTenantId, device.id]
      );

      // Clear per-device RBAC (old tenant users lose access)
      await client.query(
        `DELETE FROM user_devices WHERE device_id = $1`,
        [device.id]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Record assign timestamp for stuck-device detection grace period
    mqttSvc.recordAssign(mqttId);

    // Rotate MQTT credentials for new tenant (outside transaction — best-effort)
    let creds = null;
    let mqttSent = false;
    try {
      creds = await mqttAuth.provisionDevice(newTenantId, mqttId);

      // Send credentials + tenant via MQTT using OLD slug (device still connected there)
      const routingSlug = mqttSvc.getDeviceRoutingSlug(mqttId, oldSlug);
      mqttSvc.sendJsonCommand(routingSlug, mqttId, '_set_mqtt_creds', {
        username: creds.username,
        password: creds.password,
      });
      // QoS 1 for reliability — critical configuration command
      mqttSvc.sendCommand(routingSlug, mqttId, '_set_tenant', newSlug, { qos: 1 });
      mqttSent = true;
    } catch (mqttErr) {
      // MQTT send failed (device might be offline) — DB is already updated
      console.error('MQTT reassign commands failed (device may be offline):', mqttErr.message);
    }

    // Update in-memory state
    mqttSvc.updateDeviceStateMap(mqttId, newTenantId, newSlug);
    await mqttSvc.refreshRegistries();

    res.json({
      data: {
        device_id: device.id,
        mqtt_device_id: mqttId,
        old_tenant: oldSlug,
        new_tenant: newSlug,
        mqtt_commands_sent: mqttSent,
        credentials_rotated: !!creds,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
