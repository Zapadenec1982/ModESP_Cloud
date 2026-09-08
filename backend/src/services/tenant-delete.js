'use strict';

/**
 * Removing an organisation's data (plan epics 1.10 and 2.10).
 *
 * purgeTenant  — the organisation stays, with its users, invoices and usage
 *                history, but everything it produced goes and its controllers
 *                return to the pending queue with their credentials. The
 *                lifecycle sweep runs it CLOSED_RETENTION_DAYS after an
 *                organisation was closed.
 * deleteTenant — hard delete: purge, then the accounts and the organisation
 *                row. Shared by DELETE /api/tenants/:id, DELETE /api/tenants/bulk
 *                and src/scripts/purge-demo.js so they can never drift apart.
 *
 * Both run inside the caller's transaction client and resolve null when the
 * organisation does not exist. The audit trail is never deleted: its rows are
 * pseudonymised through audit_log_detach_tenant() (migration 041), the one
 * UPDATE the immutable trigger admits — the trigger is not disabled any more.
 *
 * Demo fleets never existed, so `dropDevices: true` removes the controllers
 * instead of parking them.
 */

const fs = require('fs');
const db = require('./db');

async function removeExportFiles(client, tenantId) {
  const { rows } = await client.query('SELECT file_path FROM tenant_exports WHERE tenant_id = $1 AND file_path IS NOT NULL', [tenantId]);
  for (const r of rows) {
    try { fs.unlinkSync(r.file_path); } catch { /* already gone */ }
  }
}

async function purgeTenant(client, id, { dropDevices = false, now = new Date() } = {}) {
  if (id === db.SYSTEM_TENANT_ID) throw new Error('Cannot purge the system tenant');

  const { rows } = await client.query('SELECT id, name, slug FROM tenants WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const tenant = rows[0];

  const counts = {};
  const wipe = async (table, sql = `DELETE FROM ${table} WHERE tenant_id = $1`) => {
    const r = await client.query(sql, [id]);
    counts[table] = r.rowCount;
  };

  // Children before parents; everything the organisation produced
  await wipe('notification_log');
  await wipe('notification_subscribers');
  await wipe('alarms');
  await wipe('events');
  await wipe('ota_jobs');
  await wipe('ota_rollouts');
  await wipe('firmwares');
  await wipe('service_records');
  await wipe('work_orders');
  await wipe('maintenance_hints');
  await wipe('maintenance_rules');          // the platform default (tenant_id NULL) is untouched
  await wipe('report_schedules');
  await wipe('report_exports');
  await removeExportFiles(client, id);
  await wipe('tenant_exports');
  await wipe('invitations');
  await wipe('user_devices',
    `DELETE FROM user_devices WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)
                                 OR device_id IN (SELECT id FROM devices WHERE tenant_id = $1)`);

  const t = await client.query('DELETE FROM telemetry WHERE tenant_id = $1', [id]);
  const deletedTelemetry = t.rowCount;
  await client.query('DELETE FROM telemetry_hourly WHERE tenant_id = $1', [id]);

  // Controllers: dropped for a demo fleet, otherwise back to the pending queue.
  // mqtt_password_hash stays — a controller that comes back online must still
  // authenticate, and _set_tenant "pending" on boot moves it to the queue.
  let movedDevices = 0, droppedDevices = 0, devices = [];
  if (dropDevices) {
    const d = await client.query('DELETE FROM devices WHERE tenant_id = $1', [id]);
    droppedDevices = d.rowCount;
  } else {
    const m = await client.query(
      `UPDATE devices
          SET tenant_id = $1, status = 'pending', online = false, site_id = NULL, model_id = NULL, claimed_by_tenant_id = NULL
        WHERE tenant_id = $2
        RETURNING mqtt_device_id`,
      [db.SYSTEM_TENANT_ID, id]);
    movedDevices = m.rowCount;
    devices = m.rows.map(r => r.mqtt_device_id);
  }
  await wipe('device_models');
  await wipe('sites');                       // cascades user_sites, site_public_links, weather_observations

  await client.query('UPDATE tenants SET purged_at = $2 WHERE id = $1', [id, now]);
  return { ...tenant, counts, movedDevices, droppedDevices, deletedTelemetry, devices };
}

async function deleteTenant(client, id, { dropDevices = false } = {}) {
  if (id === db.SYSTEM_TENANT_ID) throw new Error('Cannot delete the system tenant');

  const purged = await purgeTenant(client, id, { dropDevices });
  if (!purged) return null;

  // The audit trail keeps the actions, not the people
  await client.query('SELECT audit_log_detach_tenant($1)', [id]);

  // References to these accounts from other organisations' rows are cut, then the accounts go
  const users = 'SELECT id FROM users WHERE tenant_id = $1';
  await client.query(`UPDATE firmwares SET uploaded_by = NULL WHERE uploaded_by IN (${users})`, [id]);
  await client.query(`UPDATE ota_rollouts SET created_by = NULL WHERE created_by IN (${users})`, [id]);
  await client.query(`UPDATE user_devices SET granted_by = NULL WHERE granted_by IN (${users})`, [id]);
  await client.query(`DELETE FROM refresh_tokens WHERE user_id IN (${users})`, [id]);
  await client.query(`DELETE FROM push_subscriptions WHERE user_id IN (${users})`, [id]);
  await client.query('DELETE FROM user_tenants WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM users WHERE tenant_id = $1', [id]);

  await client.query('DELETE FROM tenants WHERE id = $1', [id]);

  const { counts, devices, ...result } = purged;
  return result;
}

module.exports = { deleteTenant, purgeTenant };
