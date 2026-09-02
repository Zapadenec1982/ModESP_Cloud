'use strict';

/**
 * Hard delete of an organisation (plan epic 1.10).
 *
 * One procedure shared by DELETE /api/tenants/:id and src/scripts/purge-demo.js
 * so the two can never drift apart. Runs inside the caller's transaction
 * client and returns null when the organisation does not exist.
 *
 * Devices are moved to the system organisation by default — a real controller
 * that comes back online must land in the pending queue, not vanish. Demo
 * fleets never existed, so `dropDevices: true` removes them together with
 * their telemetry and the hourly archive.
 */

const db = require('./db');

async function deleteTenant(client, id, { dropDevices = false } = {}) {
  if (id === db.SYSTEM_TENANT_ID) throw new Error('Cannot delete the system tenant');

  const { rows } = await client.query('SELECT id, name, slug FROM tenants WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const tenant = rows[0];

  // Tenant-scoped data first (children before parents)
  await client.query('DELETE FROM notification_log WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM notification_subscribers WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM alarms WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM events WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM ota_jobs WHERE rollout_id IN (SELECT id FROM ota_rollouts WHERE tenant_id = $1)', [id]);
  await client.query('DELETE FROM ota_rollouts WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM firmwares WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM service_records WHERE tenant_id = $1', [id]);

  let movedDevices = 0, droppedDevices = 0, deletedTelemetry = 0;
  if (dropDevices) {
    const t = await client.query('DELETE FROM telemetry WHERE tenant_id = $1', [id]);
    deletedTelemetry = t.rowCount;
    await client.query('DELETE FROM telemetry_hourly WHERE tenant_id = $1', [id]);
    await client.query('DELETE FROM report_exports WHERE tenant_id = $1', [id]);
    const d = await client.query('DELETE FROM devices WHERE tenant_id = $1', [id]);
    droppedDevices = d.rowCount;
  } else {
    const m = await client.query(
      'UPDATE devices SET tenant_id = $1 WHERE tenant_id = $2 RETURNING mqtt_device_id',
      [db.SYSTEM_TENANT_ID, id]
    );
    movedDevices = m.rowCount;
  }

  // Nullify audit_log references before deleting users/tenant (the immutable
  // trigger blocks cascaded updates, so it is done explicitly)
  await client.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable');
  await client.query('UPDATE audit_log SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)', [id]);
  await client.query('UPDATE audit_log SET tenant_id = NULL WHERE tenant_id = $1', [id]);
  await client.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable');

  // User-related data
  await client.query('DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)', [id]);
  await client.query('DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)', [id]);
  await client.query('DELETE FROM user_tenants WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM users WHERE tenant_id = $1', [id]);

  await client.query('DELETE FROM tenants WHERE id = $1', [id]);

  return { ...tenant, movedDevices, droppedDevices, deletedTelemetry };
}

module.exports = { deleteTenant };
