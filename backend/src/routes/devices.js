'use strict';

const { Router } = require('express');
const path       = require('path');
const { z }      = require('zod');
const multer     = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const bcrypt     = require('bcrypt');
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

/**
 * Build WHERE clause for device lookup with superadmin bypass.
 * Superadmin: no tenant_id filter. Others: scoped to req.tenantId.
 * Returns { where, params }.
 */
function buildDeviceWhere(id, req) {
  const isUuid = id.length > 8;
  const field = isUuid ? 'id' : 'mqtt_device_id';
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  if (isSuperAdmin) {
    return { where: `${field} = $1`, params: [id] };
  }
  return { where: `${field} = $1 AND tenant_id = $2`, params: [id, req.tenantId] };
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
      // Optional ?tenant_id= filter for scoping (e.g. device assignment modal)
      const filterTenant = req.query.tenant_id;
      sql = `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.serial_number,
                    d.model, d.comment, d.manufactured_at, d.firmware_version,
                    d.online, d.status, d.last_seen, d.created_at,
                    t.slug AS tenant_slug, t.name AS tenant_name
             FROM devices d
             LEFT JOIN tenants t ON t.id = d.tenant_id
             WHERE d.status = 'active'`;
      params = [];
      if (filterTenant) {
        params.push(filterTenant);
        sql += ` AND d.tenant_id = $${params.length}`;
      }
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
router.get('/pending', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, firmware_version, online, last_seen, created_at,
              name, serial_number, location, model
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

    // Notify WS global listeners (Pending Devices page)
    mqttSvc.emit('pending_device', { deviceId: deviceMqttId, action: 'removed' });

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
      `SELECT d.id, d.mqtt_device_id, d.status, d.tenant_id, t.slug AS tenant_slug
       FROM devices d
       LEFT JOIN tenants t ON t.id = d.tenant_id
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

    const deviceUuid = rows[0].id;
    const deviceMqttId = rows[0].mqtt_device_id;
    const oldTenantSlug = rows[0].tenant_slug || 'pending';

    // Get bootstrap password
    const bootstrapKey = process.env.MQTT_BOOTSTRAP_PASSWORD;
    if (!bootstrapKey) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Bootstrap password not configured',
        status: 503,
      });
    }

    // ── Step 1: Send MQTT commands BEFORE changing DB credentials ──
    // Device is still connected with old credentials on old tenant topic.
    // Send bootstrap creds + pending tenant so it can reconnect after DB change.
    let mqttSent = false;
    try {
      mqttSvc.sendJsonCommand(oldTenantSlug, deviceMqttId, '_set_mqtt_creds', {
        user: `device_${deviceMqttId}`,
        pass: bootstrapKey,
      });
      mqttSvc.sendCommand(oldTenantSlug, deviceMqttId, '_set_tenant', 'pending', { qos: 1 });
      mqttSent = true;
    } catch (err) {
      req.log?.warn?.({ err, deviceMqttId }, 'MQTT reset commands failed (device may be offline)');
    }

    // ── Step 2: Update DB — move to SYSTEM tenant, restore bootstrap creds ──
    const bootstrapHash = await bcrypt.hash(bootstrapKey, 12);

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE devices
         SET tenant_id = $1, status = 'pending',
             mqtt_username = $2, mqtt_password_hash = $3
         WHERE id = $4`,
        [db.SYSTEM_TENANT_ID, `device_${deviceMqttId}`, bootstrapHash, deviceUuid]
      );

      // Clear per-device RBAC
      await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
    });

    // Clean up in-memory state
    mqttSvc.removeDeviceState(deviceMqttId);
    await mqttSvc.refreshRegistries();

    res.json({
      data: {
        device_id: deviceUuid,
        mqtt_device_id: deviceMqttId,
        status: 'pending',
        reset: true,
        mqtt_sent: mqttSent,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/:id ───────────────────────────────
// Delete a device (admin: own tenant, superadmin: any).
// Always hard-deletes. If the device reconnects, auto-discovery will re-create it as pending.
// Sends MQTT reset commands first so the device reverts to bootstrap credentials.
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
      `SELECT id, mqtt_device_id, name, status, tenant_id FROM devices WHERE ${whereClause}`,
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

    // Audit: preserve device identity before deletion
    req.auditContext = { entityId: deviceUuid, changes: { before: { name: rows[0].name, mqtt_id: deviceMqttId } } };

    // For active devices, send MQTT reset commands so device reverts to bootstrap credentials
    if (deviceStatus !== 'pending') {
      const bootstrapKey = process.env.MQTT_BOOTSTRAP_PASSWORD;
      if (bootstrapKey) {
        try {
          const tenantRes = await db.query(
            `SELECT slug FROM tenants WHERE id = $1`,
            [rows[0].tenant_id]
          );
          const tenantSlug = tenantRes.rows[0]?.slug || 'pending';
          mqttSvc.sendJsonCommand(tenantSlug, deviceMqttId, '_set_mqtt_creds', {
            user: `device_${deviceMqttId}`,
            pass: bootstrapKey,
          });
          mqttSvc.sendCommand(tenantSlug, deviceMqttId, '_set_tenant', 'pending', { qos: 1 });
        } catch (err) {
          req.log?.warn?.({ err, deviceMqttId }, 'MQTT reset commands failed (device may be offline)');
        }
      }
    }

    // Hard delete: clear all related data + device record
    await db.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
    await db.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
    await db.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);
    await db.query(`DELETE FROM devices WHERE id = $1`, [deviceUuid]);

    mqttSvc.removeDeviceState(deviceMqttId);
    await mqttSvc.refreshRegistries();

    res.json({ data: { deleted: true, mqtt_device_id: deviceMqttId } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/pending/:mqttId/assign ──────────────
// Assign a pending device to the current tenant.
// Body: { name: string, location?: string }
const assignDeviceSchema = z.object({
  name:            z.string().min(1, 'Device name is required').max(100),
  location:        z.string().max(200).optional(),
  model:           z.string().max(100).optional(),
  serial_number:   z.string().max(100).optional(),
  comment:         z.string().max(500).optional(),
  manufactured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').optional(),
  tenant_id:       z.string().uuid().optional(),
});

router.post('/pending/:mqttId/assign', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { mqttId } = req.params;
    const parsed = assignDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.issues[0]?.message || 'Validation failed',
        status: 400,
      });
    }
    const { name, location, model, serial_number, comment, manufactured_at, tenant_id } = parsed.data;

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
        user: newUsername,
        pass: newPassword,
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
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE devices
       SET tenant_id = $1, status = 'active',
           mqtt_username = $2, mqtt_password_hash = $3,
           name = COALESCE($4, name), location = COALESCE($5, location),
           model = COALESCE($6, model), serial_number = COALESCE($7, serial_number),
           comment = COALESCE($8, comment), manufactured_at = COALESCE($9, manufactured_at)
       WHERE id = $10`,
      [targetTenantId, newUsername, hash, name || null, location || null,
       model || null, serial_number || null, comment || null, manufactured_at || null, rows[0].id]
    );

    // Record assign timestamp for stuck-device detection grace period
    mqttSvc.recordAssign(mqttId);

    // Clear retained MQTT messages from pending topics (prevents false auto-reset on restart)
    mqttSvc.clearPendingRetained(mqttId);

    await mqttSvc.refreshRegistries();

    // Notify WS clients that pending device was assigned
    mqttSvc.emit('pending_device', { deviceId: mqttId, action: 'assigned' });

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

// ── POST /api/devices/pending/batch ───────────────────────
// Batch registration via CSV file upload.
// Assigns pending devices immediately; pre-registers unknown ones.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv') return cb(new Error('Only .csv files are accepted'));
    cb(null, true);
  },
});

// Header aliases: export format → internal name
const CSV_HEADER_ALIASES = {
  'device id':       'mqtt_device_id',
  'device_id':       'mqtt_device_id',
  'serial':          'serial_number',
  'manufactured':    'manufactured_at',
  'manufacture date':'manufactured_at',
  'manufactured at': 'manufactured_at',
};

const CSV_FIELDS = {
  mqtt_device_id:   { required: true,  pattern: /^[A-Fa-f0-9]{6,12}$/, maxLen: 12 },
  name:             { required: true,  maxLen: 100 },
  serial_number:    { required: false, maxLen: 100 },
  location:         { required: false, maxLen: 200 },
  model:            { required: false, maxLen: 100 },
  comment:          { required: false, maxLen: 500 },
  manufactured_at:  { required: false, pattern: /^(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/, maxLen: 10 },
};

const MAX_BATCH_ROWS = 200;

function parseCsvBuffer(buffer) {
  // Strip UTF-8 BOM if present (export adds BOM for Excel Cyrillic compat)
  let text = buffer.toString('utf-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const records = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  // Normalize headers via aliases
  return records.map((row, i) => {
    const normalized = { _line: i + 2 };  // +2: 1-indexed + header row
    for (const [key, val] of Object.entries(row)) {
      const normKey = CSV_HEADER_ALIASES[key.toLowerCase()] || key.toLowerCase().replace(/\s+/g, '_');
      normalized[normKey] = val;
    }
    return normalized;
  });
}

function validateCsvRows(rows) {
  const errors = [];
  const seenIds = new Set();

  // Check required headers from first row
  if (rows.length > 0) {
    const firstRow = rows[0];
    for (const [field, rule] of Object.entries(CSV_FIELDS)) {
      if (rule.required && !(field in firstRow)) {
        errors.push({ row: 1, field, message: `Missing required column: ${field}` });
      }
    }
    if (errors.length > 0) return errors;
  }

  for (const row of rows) {
    const line = row._line;
    for (const [field, rule] of Object.entries(CSV_FIELDS)) {
      const val = (row[field] || '').trim();
      if (rule.required && !val) {
        errors.push({ row: line, field, message: `${field} is required` });
        continue;
      }
      if (val && rule.pattern && !rule.pattern.test(val)) {
        errors.push({ row: line, field, message: `${field} has invalid format` });
      }
      if (val && rule.maxLen && val.length > rule.maxLen) {
        errors.push({ row: line, field, message: `${field} exceeds ${rule.maxLen} chars` });
      }
    }

    // Duplicate check within CSV
    const devId = (row.mqtt_device_id || '').trim().toUpperCase();
    if (devId) {
      if (seenIds.has(devId)) {
        errors.push({ row: line, field: 'mqtt_device_id', message: `Duplicate device ID: ${devId}` });
      }
      seenIds.add(devId);
    }
  }

  return errors;
}

router.post('/pending/batch', maybeAuthorize('admin'), csvUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'no_file', message: 'CSV file is required', status: 400 });
    }

    // Parse CSV
    let rows;
    try {
      rows = parseCsvBuffer(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: 'parse_error', message: `CSV parse error: ${e.message}`, status: 400 });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'empty_file', message: 'CSV has no data rows', status: 400 });
    }

    if (rows.length > MAX_BATCH_ROWS) {
      return res.status(400).json({
        error: 'too_many_rows',
        message: `CSV has ${rows.length} rows, maximum is ${MAX_BATCH_ROWS}`,
        status: 400,
      });
    }

    // Phase 1: Validate all rows
    const validationErrors = validateCsvRows(rows);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'CSV validation failed',
        errors: validationErrors,
        status: 400,
      });
    }

    // Determine target tenant
    const isSA = req.user && req.user.role === 'superadmin';
    const tenantIdFromBody = req.body?.tenant_id;
    const targetTenantId = (isSA && tenantIdFromBody) ? tenantIdFromBody : req.tenantId;

    // Verify tenant exists
    const tenantRes = await db.query(`SELECT slug FROM tenants WHERE id = $1`, [targetTenantId]);
    if (tenantRes.rows.length === 0) {
      return res.status(400).json({ error: 'invalid_tenant', message: 'Tenant not found', status: 400 });
    }
    const tenantSlug = tenantRes.rows[0].slug;

    // Phase 2: Process rows sequentially
    const results = [];
    const summary = { total: rows.length, assigned: 0, pre_registered: 0, skipped: 0 };

    // First pass: check device status in DB and generate passwords for pending ones
    for (const row of rows) {
      const mqttId = row.mqtt_device_id.trim().toUpperCase();
      row._mqttId = mqttId;

      const { rows: devRows } = await db.query(
        `SELECT id, status, tenant_id FROM devices WHERE mqtt_device_id = $1`,
        [mqttId]
      );

      if (devRows.length > 0 && devRows[0].status === 'pending' && devRows[0].tenant_id === db.SYSTEM_TENANT_ID) {
        row._action = 'assign';
        row._dbId = devRows[0].id;
        row._password = mqttAuth.generatePassword();
      } else if (devRows.length > 0) {
        row._action = 'skip';
        row._skipReason = 'Device already active';
      } else {
        row._action = 'pre_register';
      }
    }

    // Hash passwords in parallel batches of 8
    const toAssign = rows.filter(r => r._action === 'assign');
    const HASH_BATCH = 8;
    for (let i = 0; i < toAssign.length; i += HASH_BATCH) {
      const batch = toAssign.slice(i, i + HASH_BATCH);
      await Promise.all(batch.map(r =>
        bcrypt.hash(r._password, 12).then(h => { r._hash = h; })
      ));
    }

    // Process each row
    for (const row of rows) {
      const mqttId = row._mqttId;
      const name = (row.name || '').trim();
      const location = (row.location || '').trim() || null;
      const model = (row.model || '').trim() || null;
      const serialNumber = (row.serial_number || '').trim() || null;
      const comment = (row.comment || '').trim() || null;
      let manufacturedAt = (row.manufactured_at || '').trim() || null;
      // Convert DD-MM-YYYY → YYYY-MM-DD for PostgreSQL
      if (manufacturedAt && /^\d{2}-\d{2}-\d{4}$/.test(manufacturedAt)) {
        const [dd, mm, yyyy] = manufacturedAt.split('-');
        manufacturedAt = `${yyyy}-${mm}-${dd}`;
      }

      if (row._action === 'skip') {
        summary.skipped++;
        results.push({
          row: row._line, mqtt_device_id: mqttId, name,
          status: 'skipped', error: row._skipReason,
        });
        continue;
      }

      if (row._action === 'assign') {
        // Same logic as single assign
        const newUsername = `device_${mqttId}`;
        const newPassword = row._password;
        const hash = row._hash;

        // Send MQTT commands
        let sentCreds = false, sentTenant = false;
        try {
          mqttSvc.sendJsonCommand('pending', mqttId, '_set_mqtt_creds', {
            user: newUsername, pass: newPassword,
          });
          sentCreds = true;
        } catch (_) { /* MQTT may be unavailable */ }
        try {
          mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug, { qos: 1 });
          sentTenant = true;
        } catch (_) { /* MQTT may be unavailable */ }

        // Update DB
        await db.query(
          `UPDATE devices
           SET tenant_id = $1, status = 'active',
               mqtt_username = $2, mqtt_password_hash = $3,
               name = COALESCE($4, name), location = COALESCE($5, location),
               model = COALESCE($6, model), serial_number = COALESCE($7, serial_number),
               comment = COALESCE($8, comment), manufactured_at = COALESCE($9, manufactured_at)
           WHERE id = $10`,
          [targetTenantId, newUsername, hash, name || null, location, model, serialNumber, comment, manufacturedAt, row._dbId]
        );

        mqttSvc.recordAssign(mqttId);
        mqttSvc.clearPendingRetained(mqttId);

        summary.assigned++;
        results.push({
          row: row._line, mqtt_device_id: mqttId, name,
          status: 'assigned',
          credentials: {
            username: newUsername,
            password: newPassword,
            mqtt_host: process.env.MQTT_PUBLIC_HOST || req.hostname,
            mqtt_port: 8883,
            sent_via_mqtt: sentCreds,
          },
        });

        // Delay between devices to let each one process MQTT commands
        // and reconnect before sending commands to the next device
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }

      if (row._action === 'pre_register') {
        // Pre-register in SYSTEM tenant
        const { rowCount } = await db.query(
          `INSERT INTO devices (tenant_id, mqtt_device_id, status, name, location, model, serial_number, comment, manufactured_at)
           VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (mqtt_device_id) DO NOTHING`,
          [db.SYSTEM_TENANT_ID, mqttId, name || null, location, model, serialNumber, comment, manufacturedAt]
        );

        if (rowCount === 0) {
          // Race condition: device appeared between validation and processing
          summary.skipped++;
          results.push({
            row: row._line, mqtt_device_id: mqttId, name,
            status: 'skipped', error: 'Device appeared during processing',
          });
        } else {
          summary.pre_registered++;
          results.push({
            row: row._line, mqtt_device_id: mqttId, name,
            status: 'pre_registered',
          });
        }
        continue;
      }
    }

    // Refresh registries once after all assignments
    if (summary.assigned > 0) {
      await mqttSvc.refreshRegistries();
      mqttSvc.emit('pending_device', { action: 'batch_assigned', count: summary.assigned });
    }
    if (summary.pre_registered > 0) {
      mqttSvc.emit('pending_device', { action: 'batch_pre_registered', count: summary.pre_registered });
    }

    res.json({ data: { summary, results } });
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
    const { where, params } = buildDeviceWhere(id, req);

    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, tenant_id, status, mqtt_password_hash FROM devices WHERE ${where}`,
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
    const deviceTenantId = device.tenant_id;
    const isRotation = device.mqtt_password_hash != null;
    const creds = isRotation
      ? await mqttAuth.rotatePassword(deviceTenantId, device.mqtt_device_id)
      : await mqttAuth.provisionDevice(deviceTenantId, device.mqtt_device_id);

    // Try to send via MQTT (zero-touch)
    let sent = false;
    try {
      const routingSlug = await resolveRoutingSlug(device.mqtt_device_id, deviceTenantId);
      mqttSvc.sendJsonCommand(routingSlug, device.mqtt_device_id, '_set_mqtt_creds', {
        user: creds.username,
        pass: creds.password,
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
    const { where, params } = buildDeviceWhere(id, req);

    const { rows } = await db.query(
      `SELECT mqtt_device_id, tenant_id FROM devices WHERE ${where}`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    await mqttAuth.revokeCredentials(rows[0].tenant_id, rows[0].mqtt_device_id);

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
    const { where, params: whereParams } = buildDeviceWhere(id, req);

    // Fetch current state for audit before/after
    const beforeRes = await db.query(
      `SELECT id, name, location, serial_number, model, comment FROM devices WHERE ${where}`,
      whereParams
    );
    const beforeDevice = beforeRes.rows[0];

    // Build dynamic SET clause
    const fields = parsed.data;
    const keys = Object.keys(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map(k => fields[k] ?? null);

    // Append WHERE params after SET values (shift indices)
    const offset = values.length;
    const shiftedWhere = where.replace(/\$(\d+)/g, (_, n) => `$${+n + offset}`);

    const { rows } = await db.query(
      `UPDATE devices
       SET ${setClauses.join(', ')}
       WHERE ${shiftedWhere}
       RETURNING id, mqtt_device_id, name, location, serial_number,
                 model, comment, manufactured_at, firmware_version, status, created_at`,
      [...values, ...whereParams]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    // Audit: before/after for changed fields only
    if (beforeDevice) {
      const before = {}, after = {};
      for (const k of keys) {
        if (beforeDevice[k] !== undefined) before[k] = beforeDevice[k];
        after[k] = rows[0][k];
      }
      req.auditContext = { entityId: rows[0].id, changes: { before, after } };
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
    const { where, params } = buildDeviceWhere(id, req);

    const { rows } = await db.query(
      `SELECT mqtt_device_id, tenant_id, status FROM devices WHERE ${where}`,
      params
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
    const tenantSlug = await resolveRoutingSlug(mqttId, rows[0].tenant_id);

    mqttSvc.sendCommand(tenantSlug, mqttId, key, value);

    // Audit: which command was sent
    req.auditContext = { entityId: mqttId, changes: { key, value: String(value) } };

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
    const { where, params } = buildDeviceWhere(id, req);

    const { rows } = await db.query(
      `SELECT mqtt_device_id, tenant_id, status FROM devices WHERE ${where}`,
      params
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
    const tenantSlug = await resolveRoutingSlug(mqttId, rows[0].tenant_id);

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
    const { where, params } = buildDeviceWhere(id, req);

    // Resolve device UUID (service_records references device.id)
    const devRes = await db.query(
      `SELECT id, tenant_id FROM devices WHERE ${where}`,
      params
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = devRes.rows[0].id;
    const deviceTenantId = devRes.rows[0].tenant_id;
    const { rows } = await db.query(
      `SELECT id, service_date, technician, reason, work_done, created_at
       FROM service_records
       WHERE device_id = $1 AND tenant_id = $2
       ORDER BY service_date DESC`,
      [deviceUuid, deviceTenantId]
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
    const { where, params } = buildDeviceWhere(id, req);

    const devRes = await db.query(
      `SELECT id, tenant_id FROM devices WHERE ${where}`,
      params
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Device ${id} not found`,
        status: 404,
      });
    }

    const deviceUuid = devRes.rows[0].id;
    const deviceTenantId = devRes.rows[0].tenant_id;
    const { service_date, technician, reason, work_done } = parsed.data;

    const { rows } = await db.query(
      `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, service_date, technician, reason, work_done, created_at`,
      [deviceTenantId, deviceUuid, service_date, technician, reason, work_done]
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
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    const { rowCount } = isSuperAdmin
      ? await db.query(`DELETE FROM service_records WHERE id = $1`, [recordId])
      : await db.query(`DELETE FROM service_records WHERE id = $1 AND tenant_id = $2`, [recordId, req.tenantId]);

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
    await db.transaction(async (client) => {
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
    });

    // Record assign timestamp for stuck-device detection grace period
    mqttSvc.recordAssign(mqttId);

    // Rotate MQTT credentials for new tenant (outside transaction — best-effort)
    let creds = null;
    let mqttSent = false;
    try {
      req.log.info({ mqttId, oldSlug, newSlug }, 'Reassign: provisioning new credentials');
      creds = await mqttAuth.provisionDevice(newTenantId, mqttId);

      // Send credentials + tenant via MQTT using OLD slug (device still connected there)
      const routingSlug = mqttSvc.getDeviceRoutingSlug(mqttId, oldSlug);
      req.log.info({ mqttId, routingSlug, newSlug }, 'Reassign: sending MQTT commands');
      mqttSvc.sendJsonCommand(routingSlug, mqttId, '_set_mqtt_creds', {
        user: creds.username,
        pass: creds.password,
      });
      // QoS 1 for reliability — critical configuration command
      mqttSvc.sendCommand(routingSlug, mqttId, '_set_tenant', newSlug, { qos: 1 });
      mqttSent = true;
      req.log.info({ mqttId, routingSlug, newSlug, mqttSent }, 'Reassign: MQTT commands sent');
    } catch (mqttErr) {
      // MQTT send failed (device might be offline) — DB is already updated
      req.log.warn({ err: mqttErr, mqttId }, 'Reassign: MQTT commands failed (device may be offline)');
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
