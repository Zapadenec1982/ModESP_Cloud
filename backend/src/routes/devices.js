'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const stateMeta  = require('../config/state_meta.json');

const router = Router();

// Build Set of writable keys for command validation
const writableKeys = new Set(stateMeta.subscribeKeys);

// ── GET /api/devices ──────────────────────────────────────
// List all devices for current tenant. Augments DB data with live state.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, name, location, serial_number,
              firmware_version, online, status, last_seen, created_at
       FROM devices
       WHERE tenant_id = $1
       ORDER BY name NULLS LAST, mqtt_device_id`,
      [req.tenantId]
    );

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

// ── POST /api/devices/pending/:mqttId/assign ──────────────
// Assign a pending device to the current tenant.
// Body: { name?: string, location?: string }
router.post('/pending/:mqttId/assign', async (req, res, next) => {
  try {
    const { mqttId } = req.params;
    const { name, location } = req.body || {};

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
      [req.tenantId]
    );
    if (tenantRes.rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_tenant',
        message: 'Tenant not found',
        status: 400,
      });
    }
    const tenantSlug = tenantRes.rows[0].slug;

    // Move device to the target tenant
    await db.query(
      `UPDATE devices
       SET tenant_id = $1, status = 'active', name = COALESCE($2, name), location = COALESCE($3, location)
       WHERE id = $4`,
      [req.tenantId, name || null, location || null, rows[0].id]
    );

    // Send _set_tenant command to the device via MQTT
    try {
      mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug);
    } catch (err) {
      // MQTT might be disconnected — device will get the command on reconnect
      // Still, the DB assignment is done, so we proceed
    }

    res.json({
      data: {
        device_id: rows[0].id,
        mqtt_device_id: mqttId,
        tenant_id: req.tenantId,
        status: 'active',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id ──────────────────────────────────
// Full device detail: DB record + live state from stateMap.
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Support both UUID and mqtt_device_id
    const isUuid = id.length > 8;
    const whereClause = isUuid
      ? 'id = $1 AND tenant_id = $2'
      : 'mqtt_device_id = $1 AND tenant_id = $2';

    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, name, location, serial_number,
              firmware_version, proto_version, online, status,
              last_seen, last_state, created_at
       FROM devices WHERE ${whereClause}`,
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
    const mqttId = device.mqtt_device_id;

    // Merge DB last_state with live stateMap
    const liveState = mqttSvc.getDeviceState(mqttId);
    const meta      = mqttSvc.getDeviceMeta(mqttId);
    const mergedState = {
      ...(device.last_state || {}),
      ...(liveState || {}),
    };

    res.json({
      data: {
        ...device,
        online:     meta ? meta.online : device.online,
        last_seen:  meta ? new Date(meta.lastSeen).toISOString() : device.last_seen,
        last_state: mergedState,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/command ─────────────────────────
// Send a command to a device. Body: { key, value }
router.post('/:id/command', async (req, res, next) => {
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
    const deviceStatus = rows[0].status;

    // Resolve MQTT topic prefix:
    // Pending devices listen on modesp/v1/pending/{id}/cmd/+
    // Active devices listen on modesp/v1/{tenant_slug}/{id}/cmd/+
    let tenantSlug;
    if (deviceStatus === 'pending') {
      tenantSlug = 'pending';
    } else {
      const tenantRes = await db.query(
        `SELECT slug FROM tenants WHERE id = $1`,
        [req.tenantId]
      );
      tenantSlug = tenantRes.rows[0]?.slug || 'pending';
    }

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
router.post('/:id/request-state', async (req, res, next) => {
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
    const deviceStatus = rows[0].status;

    let tenantSlug;
    if (deviceStatus === 'pending') {
      tenantSlug = 'pending';
    } else {
      const tenantRes = await db.query(
        `SELECT slug FROM tenants WHERE id = $1`,
        [req.tenantId]
      );
      tenantSlug = tenantRes.rows[0]?.slug || 'pending';
    }

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

module.exports = router;
