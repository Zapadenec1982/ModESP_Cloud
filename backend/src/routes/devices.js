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
const geocodeSvc = require('../services/geocode');
const { authorize } = require('../middleware/auth');
const { filterDeviceAccess, checkDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');
const stateMeta  = require('../config/state_meta.json');
const { DANGEROUS_KEYS, validateCommandValue } = require('../config/command-policy');
const { normalizeClaimCode } = require('../lib/claim-code');
const planMw = require('../middleware/plan');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

const router = Router();

// Writable keys + their metadata (type/min/max/step) for command validation
const writableKeys = new Set(stateMeta.subscribeKeys);
const metaByKey = new Map(stateMeta.meta.map(m => [m.key, m]));

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
  const isUuid = isUuidFormat(id);
  const field = isUuid ? 'id' : 'mqtt_device_id';
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  if (isSuperAdmin) {
    return { where: `${field} = $1`, params: [id] };
  }
  return { where: `${field} = $1 AND tenant_id = $2`, params: [id, req.tenantId] };
}

// ── Site join (devices ↔ sites) ───────────────────────────
// The `s.tenant_id = d.tenant_id` predicate is MANDATORY on every devices↔sites
// join in the codebase. There is deliberately no composite FK on
// (tenant_id, site_id) — five code paths move a device to another tenant, and a
// composite FK would turn each of them into a runtime 23503. The join predicate
// is what guarantees a stale cross-tenant site_id resolves to NULLs instead of
// leaking another tenant's address.
const SITE_JOIN = `LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id`;

// Site columns exposed on the device payloads.
//
// site_id comes from `s.id`, not `d.site_id`, so the block is self-consistent:
// a non-null site_id always arrives with a readable site_name. A device carrying a
// site_id the join cannot reach (another tenant's site, left behind by a tenant
// move) reports the whole block as NULL instead of an id with no site behind it.
//
// NOTE: d.latitude / d.longitude stay RAW here — never COALESCE'd with the site
// coordinates. The fleet map computes its "без координат" list from
// `latitude == null` and clears a device position by PATCHing {latitude: null},
// so a COALESCE'd alias would make both look broken. The COALESCE belongs in
// /api/map/devices, nowhere else.
const SITE_COLUMNS = `s.id AS site_id,
              s.name AS site_name, s.city AS site_city, s.region AS site_region,
              s.country AS site_country,
              s.latitude AS site_latitude, s.longitude AS site_longitude`;

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
                    d.latitude, d.longitude,
                    ${SITE_COLUMNS},
                    t.slug AS tenant_slug, t.name AS tenant_name
             FROM devices d
             LEFT JOIN tenants t ON t.id = d.tenant_id
             ${SITE_JOIN}
             WHERE d.status = 'active'`;
      params = [];
      if (filterTenant) {
        params.push(filterTenant);
        sql += ` AND d.tenant_id = $${params.length}`;
      }
    } else {
      // Aliased as `d` (it used to be unaliased): the sites join brings a second
      // `id` column into scope, so every reference must be qualified.
      sql = `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.serial_number,
                    d.model, d.comment, d.manufactured_at, d.firmware_version,
                    d.online, d.status, d.last_seen, d.created_at,
                    d.latitude, d.longitude,
                    ${SITE_COLUMNS}
             FROM devices d
             ${SITE_JOIN}
             WHERE d.tenant_id = $1 AND d.status <> 'deleted'`;
      params = [req.tenantId];
    }

    // Per-device RBAC: non-admin users see only assigned devices
    if (req.deviceFilter) {
      const idx = params.length + 1;
      sql += ` AND d.id = ANY($${idx})`;
      params.push(req.deviceFilter);
    }

    sql += ` ORDER BY d.name NULLS LAST, d.mqtt_device_id`;

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
        // null = device never published the key (older firmware) — UI hides the indicator
        door_open:    live ? live['equipment.door_open'] ?? null : null,
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
    // Plan epic 1.7: an organisation sees only the pending devices it has claimed
    // with the code printed on the controller; the superadmin sees the queue.
    const isSuperAdmin = !AUTH_ENABLED || !req.user || req.user.role === 'superadmin';
    const claimScope   = isSuperAdmin ? '' : ' AND d.claimed_by_tenant_id = $2';
    const claimParams  = isSuperAdmin ? [db.SYSTEM_TENANT_ID] : [db.SYSTEM_TENANT_ID, req.tenantId];
    // Pending devices live in the SYSTEM tenant, which owns no sites, so the
    // joined columns are always NULL here. They are selected anyway so the
    // pending row has the same shape as an assigned one — and the join predicate
    // makes a stale site_id resolve to NULL instead of another tenant's address.
    const { rows } = await db.query(
      `SELECT d.id, d.mqtt_device_id, d.firmware_version, d.online, d.last_seen, d.created_at,
              d.name, d.serial_number, d.location, d.model,
              d.claim_code, d.claimed_by_tenant_id,
              ${SITE_COLUMNS}
       FROM devices d
       ${SITE_JOIN}
       WHERE d.tenant_id = $1 AND d.status = 'pending'${claimScope}
       ORDER BY d.created_at DESC`,
      claimParams
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

// ── DELETE /api/devices/pending/:mqttId ──────────────────────
// Delete a pending device from the system (any admin).
// Allows re-registration of the same device_id.
router.delete('/pending/:mqttId', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { mqttId } = req.params;

    // Find pending device in SYSTEM tenant (an organisation may only touch
    // devices it has claimed; the superadmin any)
    const isSuperAdmin = !AUTH_ENABLED || !req.user || req.user.role === 'superadmin';
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id FROM devices
       WHERE mqtt_device_id = $1 AND tenant_id = $2 AND status = 'pending'
         ${isSuperAdmin ? '' : 'AND claimed_by_tenant_id = $3'}`,
      isSuperAdmin ? [mqttId, db.SYSTEM_TENANT_ID] : [mqttId, db.SYSTEM_TENANT_ID, req.tenantId]
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

    // Delete related records (alarms/telemetry/events use VARCHAR device_id, not FK).
    // Atomic so a mid-sequence failure can't leave a half-deleted device.
    await db.transaction(async (client) => {
      await client.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
      // user_devices + service_records have ON DELETE CASCADE, but explicit is safer
      await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
      await client.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);
      // Delete the device itself
      await client.query(`DELETE FROM devices WHERE id = $1`, [deviceUuid]);
    });

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

// ── POST /api/devices/:id/reset-pending ─────────────────────
// Reset a stuck device back to pending status with bootstrap credentials.
// Use when device was assigned but failed to save new MQTT credentials.
router.post('/:id/reset-pending', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = isUuidFormat(id);
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    // Look up device.
    // Qualify with `d.` — the lookup below joins `tenants t`, which also has an
    // `id` column, so a bare `id = $1` is ambiguous and Postgres rejects the whole
    // statement. That made reset-pending return 500 for any UUID route param while
    // still working when addressed by mqtt_device_id — which is why it went
    // unnoticed: the UI addresses devices by their mqtt id.
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

    // ── Step 1: Tell device to switch to pending namespace ──
    // We do NOT send _set_mqtt_creds — device keeps its current NVS credentials.
    // This is intentional: if the device is offline, it comes back with its old
    // unique credentials which still match the DB hash (we don't overwrite it).
    // If the device is online, it receives _set_tenant and reconnects to the
    // pending namespace with its current credentials — auth still passes.
    let mqttSent = false;
    try {
      mqttSvc.sendCommand(oldTenantSlug, deviceMqttId, '_set_tenant', 'pending', { qos: 1 });
      mqttSent = true;
    } catch (err) {
      req.log?.warn?.({ err, deviceMqttId }, 'MQTT reset command failed (device may be offline)');
    }

    // ── Step 2: Update DB — move to SYSTEM tenant, keep existing credentials ──
    // mqtt_password_hash is intentionally NOT updated: device must be able to
    // reconnect with its current credentials (online or offline scenario).
    await db.transaction(async (client) => {
      await client.query(
        `UPDATE devices
         SET tenant_id = $1, status = 'pending',
             mqtt_username = $2,
             site_id = NULL,
             assigned_at = NULL
         WHERE id = $3`,
        [db.SYSTEM_TENANT_ID, `device_${deviceMqttId}`, deviceUuid]
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

// ── DELETE /api/devices/:id ─────────────────────────────────
// Delete a device (admin: own tenant, superadmin: any).
// Always hard-deletes. If the device reconnects, auto-discovery will re-create it as pending.
// Sends MQTT reset commands first so the device reverts to bootstrap credentials.
router.delete('/:id', maybeAuthorize('admin'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = isUuidFormat(id);
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

    // Soft delete: keep device record + credentials so the device can reconnect
    // and appear in Pending if it comes back online after deletion.
    // Related data (telemetry, alarms, events) is deleted immediately.
    // The device record is hard-deleted after 7 days by the cleanup job in mqtt.js.
    // Atomic so a mid-sequence failure can't leave a half-deleted device.
    await db.transaction(async (client) => {
      await client.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM ota_jobs WHERE device_id = $1`, [deviceMqttId]);
      await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
      await client.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);
      await client.query(
        `UPDATE devices
         SET status = 'deleted', deleted_at = NOW(),
             tenant_id = $1, name = NULL, comment = NULL,
             site_id = NULL,
             assigned_at = NULL
         WHERE id = $2`,
        [db.SYSTEM_TENANT_ID, deviceUuid]
      );
    });

    mqttSvc.removeDeviceState(deviceMqttId);
    await mqttSvc.refreshRegistries();

    res.json({ data: { deleted: true, mqtt_device_id: deviceMqttId } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/devices/bulk ─────────────────────────────────
// Bulk delete devices (admin: own tenant, superadmin: any).
router.delete('/bulk', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'validation_failed', message: 'ids array required', status: 400 });
    }

    const isSuperAdmin = req.user && req.user.role === 'superadmin';
    const deleted = [];
    const failed = [];

    for (const id of ids) {
      try {
        const isUuid = isUuidFormat(id);
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
        if (rows.length === 0) continue;

        const deviceUuid = rows[0].id;
        const deviceMqttId = rows[0].mqtt_device_id;

        // Atomic per device so a mid-sequence failure can't leave a half-deleted row.
        await db.transaction(async (client) => {
          await client.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
          await client.query(`DELETE FROM telemetry WHERE device_id = $1`, [deviceMqttId]);
          await client.query(`DELETE FROM events WHERE device_id = $1`, [deviceMqttId]);
          await client.query(`DELETE FROM ota_jobs WHERE device_id = $1`, [deviceMqttId]);
          await client.query(`DELETE FROM user_devices WHERE device_id = $1`, [deviceUuid]);
          await client.query(`DELETE FROM service_records WHERE device_id = $1`, [deviceUuid]);
          await client.query(
            `UPDATE devices
             SET status = 'deleted', deleted_at = NOW(),
                 tenant_id = $1, name = NULL, comment = NULL,
                 site_id = NULL,
                 assigned_at = NULL
             WHERE id = $2`,
            [db.SYSTEM_TENANT_ID, deviceUuid]
          );
        });

        mqttSvc.removeDeviceState(deviceMqttId);
        deleted.push({ id: deviceUuid, mqtt_device_id: deviceMqttId });
      } catch (err) {
        req.log?.warn?.({ err, deviceId: id }, 'Bulk delete: failed to delete device');
        failed.push({ id, error: err.message });
      }
    }

    if (deleted.length > 0) await mqttSvc.refreshRegistries();

    req.log?.info?.({ deleted: deleted.length, failed: failed.length }, 'Bulk device delete');
    res.json({ data: { deleted: deleted.length, failed: failed.length, devices: deleted, errors: failed } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/recover ─────────────────────────────
// Force-recover a device that is stuck (wrong credentials in NVS, factory-reset, etc.)
// Upserts the device as pending with bootstrap credentials so it can reconnect.
// Use when: device was factory-reset AND was previously soft-deleted (edge case).
router.post('/recover', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const raw = req.body?.mqtt_device_id;
    if (!raw || typeof raw !== 'string' || !/^[A-Fa-f0-9]{6,12}$/.test(raw)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'mqtt_device_id must be a 6-12 char hex string (e.g. C7B0E9)',
        status: 400,
      });
    }
    const mqtt_device_id = raw.toUpperCase();

    // An organisation admin may recover its own devices (or an id nobody owns);
    // another organisation's device is not theirs to reset to pending.
    const isSuperAdmin = !AUTH_ENABLED || !req.user || req.user.role === 'superadmin';
    if (!isSuperAdmin) {
      const { rows: owner } = await db.query(
        'SELECT tenant_id, status FROM devices WHERE mqtt_device_id = $1', [mqtt_device_id]);
      if (owner.length && owner[0].tenant_id !== req.tenantId && owner[0].tenant_id !== db.SYSTEM_TENANT_ID) {
        return res.status(404).json({ error: 'not_found', message: `Device ${mqtt_device_id} not found`, status: 404 });
      }
      if (owner.length && owner[0].tenant_id === db.SYSTEM_TENANT_ID) {
        const { rows: claim } = await db.query(
          'SELECT claimed_by_tenant_id FROM devices WHERE mqtt_device_id = $1', [mqtt_device_id]);
        if (claim[0].claimed_by_tenant_id && claim[0].claimed_by_tenant_id !== req.tenantId) {
          return res.status(404).json({ error: 'not_found', message: `Device ${mqtt_device_id} not found`, status: 404 });
        }
      }
    }

    const bootstrapKey = process.env.MQTT_BOOTSTRAP_PASSWORD;
    if (!bootstrapKey) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Bootstrap password not configured',
        status: 503,
      });
    }

    const bootstrapHash = await bcrypt.hash(bootstrapKey, 12);

    // Upsert: if device exists (even if deleted), reset to pending with bootstrap creds.
    // If device doesn't exist at all, create it fresh.
    // The recovering organisation keeps the device in its own pending list
    // (claimed_by_tenant_id); the superadmin leaves it unclaimed.
    const claimedBy = isSuperAdmin ? null : req.tenantId;
    await db.query(
      `INSERT INTO devices (tenant_id, mqtt_device_id, status, mqtt_username, mqtt_password_hash, online, last_seen,
                            claim_code, claimed_by_tenant_id)
       VALUES ($1, $2, 'pending', $3, $4, false, NOW(), $5, $6)
       ON CONFLICT (mqtt_device_id) DO UPDATE
         SET status = 'pending', deleted_at = NULL,
             tenant_id = EXCLUDED.tenant_id,
             mqtt_username = EXCLUDED.mqtt_username,
             mqtt_password_hash = EXCLUDED.mqtt_password_hash,
             site_id = NULL,
             assigned_at = NULL,
             claim_code = COALESCE(devices.claim_code, EXCLUDED.claim_code),
             claimed_by_tenant_id = COALESCE($6, devices.claimed_by_tenant_id)`,
      [db.SYSTEM_TENANT_ID, mqtt_device_id, `device_${mqtt_device_id}`, bootstrapHash,
       require('../lib/claim-code').generateClaimCode(), claimedBy]
    );
    req.auditContext = { entityId: mqtt_device_id, action: 'device.recover' };

    // The device is back to pending; a retained `_set_tenant <old slug>` left by
    // autoReassignDevice would otherwise be replayed on its next subscribe and undo this.
    try {
      mqttSvc.setPendingTenantHint(mqtt_device_id, 'pending');
    } catch (_) { /* MQTT may be unavailable — the DB reset still stands */ }

    await mqttSvc.refreshRegistries();

    res.json({
      data: {
        mqtt_device_id,
        status: 'pending',
        message: 'Device recovery initiated. It will appear in Pending Devices when it reconnects with bootstrap credentials.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/claim ───────────────────────────────
// An organisation admin types the code printed on the controller; from then on
// the pending device shows up in that organisation's queue and can be assigned.
router.post('/claim', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const code = normalizeClaimCode(req.body?.claim_code);
    if (!code) {
      return res.status(400).json({
        error: 'validation_failed', message: 'claim_code must be the 6-12 character code printed on the controller', status: 400,
      });
    }
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, claimed_by_tenant_id, online, last_seen, firmware_version
         FROM devices
        WHERE claim_code = $1 AND status = 'pending' AND tenant_id = $2`,
      [code, db.SYSTEM_TENANT_ID]
    );
    if (rows.length !== 1) {
      return res.status(404).json({ error: 'not_found', message: 'No pending controller with this code', status: 404 });
    }
    const dev = rows[0];
    if (dev.claimed_by_tenant_id && dev.claimed_by_tenant_id !== req.tenantId) {
      return res.status(409).json({ error: 'conflict', message: 'This controller was already claimed by another organization', status: 409 });
    }
    await db.query('UPDATE devices SET claimed_by_tenant_id = $1 WHERE id = $2', [req.tenantId, dev.id]);
    req.auditContext = { entityId: dev.mqtt_device_id, action: 'device.claim', changes: { claim_code: code } };
    res.json({ data: { id: dev.id, mqtt_device_id: dev.mqtt_device_id, online: dev.online, last_seen: dev.last_seen, firmware_version: dev.firmware_version, claimed: true } });
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

    // Verify device exists and is pending — and, for an organisation admin,
    // that the organisation has claimed it with the controller's code.
    const { rows } = await db.query(
      `SELECT id, mqtt_device_id, status FROM devices
       WHERE mqtt_device_id = $1 AND tenant_id = $2 AND status = 'pending'
         ${isSuperAdmin ? '' : 'AND claimed_by_tenant_id = $3'}`,
      isSuperAdmin ? [mqttId, db.SYSTEM_TENANT_ID] : [mqttId, db.SYSTEM_TENANT_ID, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: `Pending device ${mqttId} not found`,
        status: 404,
      });
    }

    // Look up tenant slug for MQTT command
    // Plan capacity (plan epic 1.8): the organisation's active devices against max_devices
    const cap = await planMw.checkCapacity(targetTenantId, 'devices');
    if (!cap.ok) return planMw.planLimitResponse(res, cap);

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
      // QoS 1 for reliability — this is a critical configuration command.
      // RETAINED: the DB is about to flip this row to 'active', which revokes the
      // device's pending prefix everywhere except migration 022's self-closing grant.
      // A non-retained publish is dropped outright if the device is not subscribed at
      // this instant, which is precisely the failure this whole change exists to fix.
      // Retained, the instruction waits on the topic and is delivered on the device's
      // next subscribe. It is overwritten, never blanked — see setPendingTenantHint.
      mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug, { qos: 1, retain: true });
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
           comment = COALESCE($8, comment), manufactured_at = COALESCE($9, manufactured_at),
           site_id = NULL,
           assigned_at = NOW()
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

// ── POST /api/devices/pending/batch ─────────────────────────
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
// (unlisted headers are lower-cased with spaces → underscores, so "Site Name"
//  already normalizes to site_name and needs no alias)
const CSV_HEADER_ALIASES = {
  'device id':       'mqtt_device_id',
  'device_id':       'mqtt_device_id',
  'serial':          'serial_number',
  'manufactured':    'manufactured_at',
  'manufacture date':'manufactured_at',
  'manufactured at': 'manufactured_at',
  'site':            'site_name',
  'address':         'address_line',
};

// maxLen for the site columns mirrors the sites DDL in 021_sites.sql — a longer
// value must fail CSV validation, not blow up mid-import with a 22001.
const CSV_FIELDS = {
  mqtt_device_id:   { required: true,  pattern: /^[A-Fa-f0-9]{6,12}$/, maxLen: 12 },
  name:             { required: true,  maxLen: 100 },
  serial_number:    { required: false, maxLen: 100 },
  location:         { required: false, maxLen: 200 },
  model:            { required: false, maxLen: 100 },
  comment:          { required: false, maxLen: 500 },
  manufactured_at:  { required: false, pattern: /^(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/, maxLen: 10 },
  // Site (торгова точка) columns — all optional, all ignored unless site_name is set
  site_name:        { required: false, maxLen: 256 },
  country:          { required: false, maxLen: 64 },
  region:           { required: false, maxLen: 128 },
  city:             { required: false, maxLen: 128 },
  address_line:     { required: false, maxLen: 256 },
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

// ── CSV import: sites (торгові точки) ─────────────────────
// Optional site_name / country / region / city / address_line columns. A row whose
// site_name is unknown creates the site; geocoding is fire-and-forget so a 200-row
// import never waits on a 1 req/s geocoder.

// geo_source flips to 'failed' after this many fruitless attempts (mirrors routes/sites.js)
const GEO_FAIL_AFTER_ATTEMPTS = 3;

// Columns read back from `sites` whenever the import touches one
const IMPORT_SITE_COLUMNS = `id, tenant_id, name, country_code, country, region, city,
                             address_line, postal_code, latitude, longitude, geo_source`;

function csvField(row, field) {
  return (row[field] || '').trim() || null;
}

function truncate(value, maxLen) {
  const s = (value === undefined || value === null) ? '' : String(value).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/**
 * Split the free-text `country` column: a bare 2-letter value is an ISO 3166-1
 * alpha-2 code ("UA"), anything longer is a country name ("Україна", "Poland").
 * The code matters — geocode.js refuses a result whose country contradicts it.
 */
function splitCountry(value) {
  if (!value) return { country_code: null, country: null };
  return /^[A-Za-z]{2}$/.test(value)
    ? { country_code: value.toUpperCase(), country: null }
    : { country_code: null, country: truncate(value, CSV_FIELDS.country.maxLen) };
}

/**
 * Find (case/whitespace-insensitively, matching uq_sites_tenant_name) or create the
 * site named in a CSV row. Existing sites are linked as-is and never modified: an
 * import must not silently overwrite an address an admin curated by hand.
 *
 * @returns {Promise<{ site: object, created: boolean }|null>} null only if the row lost
 *          a race and the site vanished again — the device is then imported without one.
 */
async function findOrCreateImportSite(tenantId, siteName, address) {
  const select = `SELECT ${IMPORT_SITE_COLUMNS} FROM sites
                   WHERE tenant_id = $1 AND lower(btrim(name)) = lower(btrim($2::text))`;

  const found = await db.query(select, [tenantId, siteName]);
  if (found.rows.length > 0) return { site: found.rows[0], created: false };

  const inserted = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city, address_line)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${IMPORT_SITE_COLUMNS}`,
    [tenantId, truncate(siteName, CSV_FIELDS.site_name.maxLen),
     address.country_code, address.country, address.region, address.city, address.address_line]
  );
  if (inserted.rows.length > 0) return { site: inserted.rows[0], created: true };

  // Concurrent import inserted the same name first — read it back.
  const again = await db.query(select, [tenantId, siteName]);
  return again.rows.length > 0 ? { site: again.rows[0], created: false } : null;
}

/**
 * Fire-and-forget geocode of a freshly imported site. Never awaited by the request
 * handler and never rejects: a geocoder outage must not fail a CSV import.
 * Honours GEOCODER_BULK_ENABLED — when bulk geocoding is off the site simply stays
 * geo_source='none' for the operator to geocode by hand from the Sites page.
 */
async function geocodeImportedSite(site, log) {
  try {
    const out = (await geocodeSvc.resolveAddress({
      name:         site.name,
      address_line: site.address_line,
      city:         site.city,
      region:       site.region,
      postal_code:  site.postal_code,
      country:      site.country,
      country_code: site.country_code,
    }, { lane: 'bulk' })) || {};

    // BUSY means the queue was full or the wait budget expired while the job keeps
    // running — not the address's fault, so it must not count as an attempt.
    if (out.status === geocodeSvc.OUTCOME.DISABLED || out.status === geocodeSvc.OUTCOME.BUSY) return;

    if (out.status === geocodeSvc.OUTCOME.OK && out.result) {
      const addr = out.result.address || {};
      // A mangled query fails silently and confidently — corrupted Cyrillic once
      // resolved to French departments with high importance and no error. Never
      // store coordinates that contradict the country the CSV named.
      const want = (site.country_code || '').trim().toUpperCase();
      const got  = (addr.country_code || '').trim().toUpperCase();
      if (want && got && want !== got) {
        await recordImportGeocodeFailure(site, `country_mismatch:${got}`, log);
        return;
      }

      await db.query(
        `UPDATE sites
            SET latitude      = $1,
                longitude     = $2,
                geo_source    = 'geocoded',
                geo_precision = $3,
                geocoded_at   = NOW(),
                osm_type      = $4,
                osm_id        = $5,
                country_code  = COALESCE(NULLIF(btrim(country_code), ''), $6),
                country       = COALESCE(NULLIF(btrim(country), ''), $7),
                region        = COALESCE(NULLIF(btrim(region), ''), $8),
                city          = COALESCE(NULLIF(btrim(city), ''), $9),
                address_line  = COALESCE(NULLIF(btrim(address_line), ''), $10),
                postal_code   = COALESCE(NULLIF(btrim(postal_code), ''), $11),
                geo_attempts  = 0,
                geo_error     = NULL,
                updated_at    = NOW()
          WHERE id = $12 AND tenant_id = $13`,
        [
          out.result.latitude, out.result.longitude,
          truncate(out.result.precision, 16),
          truncate(out.result.osm_type, 16),
          Number.isFinite(out.result.osm_id) ? out.result.osm_id : null,
          addr.country_code ? String(addr.country_code).trim().toUpperCase().slice(0, 2) : null,
          truncate(addr.country, 64),
          // Kyiv has special status and carries no `state`: group it under its own
          // name rather than creating an "unknown region" bucket in geo-stats.
          truncate(addr.region || addr.city, 128),
          truncate(addr.city, 128),
          truncate(addr.address_line, 256),
          truncate(addr.postal_code, 16),
          site.id, site.tenant_id,
        ]
      );
      return;
    }

    const reason = out.status === geocodeSvc.OUTCOME.FAILED ? 'provider_error' : 'no_match';
    await recordImportGeocodeFailure(site, reason, log);
  } catch (err) {
    log?.warn?.({ err, siteId: site.id }, 'CSV import: background geocode failed');
  }
}

/**
 * Failure bookkeeping. Coordinates, geo_source, geo_precision and geocoded_at are
 * left untouched — a provider outage must not wipe a site off the map.
 */
async function recordImportGeocodeFailure(site, reason, log) {
  try {
    await db.query(
      `UPDATE sites
          SET geo_attempts        = geo_attempts + 1,
              geo_last_attempt_at = NOW(),
              geo_error           = $3,
              geo_source          = CASE WHEN geo_source = 'none' AND geo_attempts + 1 >= $4
                                         THEN 'failed' ELSE geo_source END,
              updated_at          = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [site.id, site.tenant_id, String(reason).slice(0, 200), GEO_FAIL_AFTER_ATTEMPTS]
    );
  } catch (err) {
    log?.warn?.({ err, siteId: site.id }, 'CSV import: could not record geocode failure');
  }
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
    const summary = {
      total: rows.length, assigned: 0, pre_registered: 0, skipped: 0,
      sites_created: 0, devices_with_site: 0,
    };

    // One lookup per distinct site name per import, not per row: a 200-row import
    // of one store must not run 200 identical SELECTs.
    const siteCache = new Map();
    const bulkGeocode = geocodeSvc.isBulkEnabled();

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
        // Optional site link. Only the assign path may set site_id: the device's
        // tenant becomes targetTenantId here, whereas a pre_register row stays in
        // the SYSTEM tenant, which owns no sites. The address columns are ignored
        // without a site_name — there is no other key to identify a site by.
        let siteId = null, siteName = null;
        const csvSiteName = csvField(row, 'site_name');
        if (csvSiteName) {
          const cacheKey = csvSiteName.toLowerCase();
          try {
            let resolved = siteCache.get(cacheKey);
            if (resolved === undefined) {
              const { country_code, country } = splitCountry(csvField(row, 'country'));
              resolved = await findOrCreateImportSite(targetTenantId, csvSiteName, {
                country_code,
                country,
                region:       truncate(csvField(row, 'region'), CSV_FIELDS.region.maxLen),
                city:         truncate(csvField(row, 'city'), CSV_FIELDS.city.maxLen),
                address_line: truncate(csvField(row, 'address_line'), CSV_FIELDS.address_line.maxLen),
              });
              siteCache.set(cacheKey, resolved);

              if (resolved && resolved.created) {
                summary.sites_created++;
                // Fire-and-forget: never awaited, so a 1 req/s geocoder cannot
                // stall the import. Errors are swallowed inside the helper.
                if (bulkGeocode) {
                  geocodeImportedSite(resolved.site, req.log).catch(() => {});
                }
              }
            }
            if (resolved) {
              siteId = resolved.site.id;
              siteName = resolved.site.name;
              summary.devices_with_site++;
            }
          } catch (err) {
            // A bad site must not cost the operator the device row.
            req.log?.warn?.({ err, site: csvSiteName, row: row._line }, 'CSV import: site link failed');
          }
        }

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
          // Retained for the same reason as the single-assign path above.
          mqttSvc.sendCommand('pending', mqttId, '_set_tenant', tenantSlug, { qos: 1, retain: true });
          sentTenant = true;
        } catch (_) { /* MQTT may be unavailable */ }

        // Update DB
        await db.query(
          `UPDATE devices
           SET tenant_id = $1, status = 'active',
               mqtt_username = $2, mqtt_password_hash = $3,
               name = COALESCE($4, name), location = COALESCE($5, location),
               model = COALESCE($6, model), serial_number = COALESCE($7, serial_number),
               comment = COALESCE($8, comment), manufactured_at = COALESCE($9, manufactured_at),
               site_id = $10,
               assigned_at = NOW()
           WHERE id = $11`,
          [targetTenantId, newUsername, hash, name || null, location, model, serialNumber, comment, manufacturedAt, siteId, row._dbId]
        );

        mqttSvc.recordAssign(mqttId);
        mqttSvc.clearPendingRetained(mqttId);

        summary.assigned++;
        results.push({
          row: row._line, mqtt_device_id: mqttId, name,
          status: 'assigned',
          site_id: siteId,
          site_name: siteName,
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
        // Pre-register in SYSTEM tenant. site_id is deliberately NOT set — the
        // SYSTEM tenant owns no sites, and the row's site columns are applied
        // later, when the device is actually assigned to a real tenant.
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

// ── GET /api/devices/:id ────────────────────────────────────
// Full device detail: DB record + live state from stateMap.
router.get('/:id', checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;

    // Support both UUID and mqtt_device_id
    const isUuid = isUuidFormat(id);
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
              d.latitude, d.longitude,
              ${SITE_COLUMNS},
              d.mqtt_username, (d.mqtt_password_hash IS NOT NULL) AS has_mqtt_credentials,
              d.tenant_id, t.slug AS tenant_slug,
              d.model_id, d.compressor_kw, d.evap_fan_kw, d.cond_fan_kw,
              d.defrost_heater_kw, d.standby_kw,
              m.name AS model_name,
              m.compressor_kw AS model_compressor_kw, m.evap_fan_kw AS model_evap_fan_kw,
              m.cond_fan_kw AS model_cond_fan_kw, m.defrost_heater_kw AS model_defrost_heater_kw,
              m.standby_kw AS model_standby_kw, m.energy_source AS model_energy_source
       FROM devices d
       JOIN tenants t ON t.id = d.tenant_id
       LEFT JOIN device_models m ON d.model_id = m.id
       ${SITE_JOIN}
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

// ── POST /api/devices/:id/mqtt-credentials ────────────────────
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

// ── DELETE /api/devices/:id/mqtt-credentials ──────────────────
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

// ── PATCH /api/devices/:id ──────────────────────────────────
// Update device properties (name, location, serial_number, model, comment, manufactured_at).
const powerField = z.number().min(0).max(100).nullable().optional();

const updateDeviceSchema = z.object({
  name:              z.string().max(128).optional(),
  location:          z.string().max(256).optional(),
  serial_number:     z.string().max(64).optional(),
  model:             z.string().max(64).optional(),
  comment:           z.string().max(2000).optional(),
  manufactured_at:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional().nullable(),
  model_id:          z.string().uuid().nullable().optional(),
  compressor_kw:     powerField,
  evap_fan_kw:       powerField,
  cond_fan_kw:       powerField,
  defrost_heater_kw: powerField,
  standby_kw:        powerField,
  latitude:          z.number().min(-90).max(90).nullable().optional(),
  longitude:         z.number().min(-180).max(180).nullable().optional(),
  site_id:           z.string().uuid().nullable().optional(),
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

    // Fetch current state for audit before/after (tenant_id also gates site_id below)
    const beforeRes = await db.query(
      `SELECT id, tenant_id, name, location, serial_number, model, comment, latitude, longitude, site_id
       FROM devices WHERE ${where}`,
      whereParams
    );
    const beforeDevice = beforeRes.rows[0];

    // Build dynamic SET clause
    const fields = parsed.data;

    // site_id is an ACCESS-CONTROL field, not a label: middleware/device-access.js
    // grants a device to everyone holding a user_sites row for its site. A
    // technician who can see this one device could otherwise detach it and strip
    // it from every colleague whose access came from the site grant, or attach it
    // to another site and widen a third party's access. Every other way to change
    // site membership (POST/DELETE /api/users/:id/sites, DELETE /api/sites/:id
    // ?force=true) is admin-only; this one must match.
    if ('site_id' in fields && AUTH_ENABLED && req.user
        && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Only an admin may change a device site',
        status: 403,
      });
    }

    // A device may only be assigned to a site of its OWN tenant. The check runs
    // against the device row's tenant_id, not req.tenantId: a superadmin PATCHes
    // cross-tenant, so req.tenantId is merely the tenant they are acting as.
    // Without this a tenant-A admin could PATCH site_id to any observed tenant-B
    // site UUID. When beforeDevice is missing the UPDATE below 404s on its own.
    if (fields.site_id != null && beforeDevice) {
      const { rows: siteRows } = await db.query(
        `SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`,
        [fields.site_id, beforeDevice.tenant_id]
      );
      if (siteRows.length === 0) {
        return res.status(400).json({
          error: 'invalid_site',
          message: 'Site does not belong to this tenant',
          status: 400,
        });
      }
    }

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
                 model, comment, manufactured_at, firmware_version, status, created_at,
                 latitude, longitude, site_id`,
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

// ── POST /api/devices/:id/command ─────────────────────────────
// Send a command to a device. Body: { key, value }
// Viewers are read-only: the role gate comes BEFORE the per-device check so a
// viewer with device access still gets 403 here. Values are validated against
// state_meta.json and the keys in command-policy.js need an explicit confirm.
router.post('/:id/command', maybeAuthorize('admin', 'technician'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { key, confirm } = req.body || {};
    let { value } = req.body || {};

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

    const meta = metaByKey.get(key);
    if (meta) {
      const check = validateCommandValue(meta, value);
      if (!check.ok) {
        return res.status(400).json({ error: 'validation_failed', message: check.message, status: 400 });
      }
      value = check.value;
    }

    if (DANGEROUS_KEYS.has(key) && confirm !== true) {
      return res.status(400).json({
        error: 'confirmation_required',
        message: `"${key}" changes how the equipment runs — resend with confirm: true`,
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

    // Audit: which command was sent (GET /devices/:id/commands reads these rows back)
    req.auditContext = {
      entityId: mqttId, action: 'device.command',
      changes: { key, value: String(value), confirmed: confirm === true, dangerous: DANGEROUS_KEYS.has(key) },
    };

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

// ── GET /api/devices/:id/commands ─────────────────────────────
// Command history from the audit log (organisation admins; superadmin any).
router.get('/:id/commands', maybeAuthorize('admin'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { where, params } = buildDeviceWhere(id, req);
    const { rows } = await db.query(`SELECT mqtt_device_id, tenant_id FROM devices WHERE ${where}`, params);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: `Device ${id} not found`, status: 404 });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const isSuperAdmin = req.user && req.user.role === 'superadmin';
    const scope = isSuperAdmin ? '' : ' AND (a.tenant_id = $3 OR a.tenant_id IS NULL)';
    const q = [rows[0].mqtt_device_id, limit];
    if (!isSuperAdmin) q.push(req.tenantId);
    const { rows: cmds } = await db.query(
      `SELECT a.id, a.created_at, a.user_email, a.user_role, a.status_code, a.ip,
              a.changes->>'key' AS key, a.changes->>'value' AS value,
              (a.changes->>'confirmed')::boolean AS confirmed,
              (a.changes->>'dangerous')::boolean AS dangerous
         FROM audit_log a
        WHERE a.action = 'device.command' AND a.entity_id = $1${scope}
        ORDER BY a.created_at DESC
        LIMIT $2`,
      q
    );
    res.json({ data: cmds });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/devices/:id/request-state ───────────────────────
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

// ── GET /api/devices/:id/service-records ────────────────────
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

// ── POST /api/devices/:id/service-records ───────────────────
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

// ── POST /api/devices/:id/reassign ──────────────────────────────
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
    const isUuid = isUuidFormat(id);
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

    // 1. Generate new credentials BEFORE changing DB
    //    (device is still online with old creds — we must send MQTT commands first)
    const username = `device_${mqttId}`;
    const password = mqttAuth.generatePassword();
    const hash = await bcrypt.hash(password, 10);

    // 2. Send MQTT commands while device is still connected with old credentials
    let mqttSent = false;
    try {
      const routingSlug = mqttSvc.getDeviceRoutingSlug(mqttId, oldSlug);
      req.log?.info?.({ mqttId, routingSlug, newSlug }, 'Reassign: sending MQTT commands before DB update');
      mqttSvc.sendJsonCommand(routingSlug, mqttId, '_set_mqtt_creds', {
        user: username,
        pass: password,
      });
      mqttSvc.sendCommand(routingSlug, mqttId, '_set_tenant', newSlug, { qos: 1 });
      mqttSent = true;
      req.log?.info?.({ mqttId, routingSlug, newSlug, mqttSent }, 'Reassign: MQTT commands sent');
    } catch (mqttErr) {
      req.log?.warn?.({ err: mqttErr, mqttId }, 'Reassign: MQTT commands failed (device may be offline)');
    }

    // 3. Update DB: move tenant + rotate credentials in one transaction
    await db.transaction(async (client) => {
      await client.query(
        `UPDATE devices SET tenant_id = $1, status = 'active',
                mqtt_username = $2, mqtt_password_hash = $3,
                site_id = NULL,
                assigned_at = NOW()
         WHERE id = $4`,
        [newTenantId, username, hash, device.id]
      );
      await client.query(
        `DELETE FROM user_devices WHERE device_id = $1`,
        [device.id]
      );
    });

    // Record assign timestamp for stuck-device detection grace period
    mqttSvc.recordAssign(mqttId);

    // Repoint the retained tenant hint on the pending prefix, AFTER the move is
    // committed. autoReassignDevice may have left `_set_tenant <old slug>` there, and a
    // retained command is replayed on every future subscribe — it would drag the device
    // straight back into the tenant it was just moved out of. Overwritten, never blanked
    // (an empty payload on a cmd topic is itself delivered) — see setPendingTenantHint.
    try {
      mqttSvc.setPendingTenantHint(mqttId, newSlug);
    } catch (_) { /* MQTT may be unavailable — the DB move still stands */ }

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
        credentials_rotated: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
