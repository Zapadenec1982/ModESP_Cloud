'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const planMw     = require('../middleware/plan');
const { requireSuperadmin } = require('../middleware/auth');

const router = Router();

const PLANS    = ['free', 'basic', 'pro', 'enterprise', 'partner'];
const STATUSES = ['trial', 'active', 'past_due', 'suspended', 'closed'];

// Columns every tenant read returns (plan limits joined for the usage column)
const TENANT_SELECT = `
  SELECT t.id, t.name, t.slug, t.plan, t.active, t.status, t.created_at,
         t.trial_expires_at, t.suspended_at, t.billing_email, t.legal_name, t.tax_id,
         t.billing_currency, t.contract_started_at,
         p.name AS plan_name, p.max_devices, p.max_sites, p.max_users, p.sampling_sec, p.features,
         COALESCE(s.raw_retention_days, p.retention_days) AS retention_days, s.raw_retention_days,
         (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active') AS device_count,
         (SELECT COUNT(*)::int FROM devices d WHERE d.claimed_by_tenant_id = t.id AND d.status = 'pending') AS pending_count,
         (SELECT COUNT(*)::int FROM sites s WHERE s.tenant_id = t.id) AS site_count,
         (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active = true) AS user_count
    FROM tenants t
    LEFT JOIN plan_limits p ON p.plan = t.plan
    LEFT JOIN tenant_settings s ON s.tenant_id = t.id`;

const RESERVED_SLUGS = new Set(['__system__', 'pending', 'system', 'admin', 'api']);

// ── Validation schemas ──────────────────────────────────────

const createTenantSchema = z.object({
  name: z.string().min(1).max(128).trim(),
  slug: z.string().min(2).max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Slug must be lowercase alphanumeric with hyphens/underscores'),
  plan: z.enum(PLANS).default('free'),
  status: z.enum(STATUSES).optional(),
  trial_expires_at: z.string().datetime().nullable().optional(),
});

const updateTenantSchema = z.object({
  name:   z.string().min(1).max(128).trim().optional(),
  plan:   z.enum(PLANS).optional(),
  active: z.boolean().optional(),
  status: z.enum(STATUSES).optional(),
  trial_expires_at:    z.string().datetime().nullable().optional(),
  billing_email:       z.string().email().max(256).nullable().optional(),
  legal_name:          z.string().max(256).nullable().optional(),
  tax_id:              z.string().max(32).nullable().optional(),
  billing_currency:    z.string().length(3).toUpperCase().optional(),
  contract_started_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const settingsSchema = z.object({
  timezone:                z.string().min(1).max(64).optional(),
  locale:                  z.enum(['uk', 'en', 'pl', 'de']).optional(),
  electricity_rate:        z.number().min(0).max(1000).nullable().optional(),
  electricity_currency:    z.string().length(3).toUpperCase().optional(),
  door_alarm_delay_ms:     z.number().int().min(0).max(7_200_000).nullable().optional(),
  pulldown_alarm_delay_ms: z.number().int().min(0).max(7_200_000).nullable().optional(),
  offline_threshold_ms:    z.number().int().min(30_000).max(3_600_000).nullable().optional(),
  offline_alarm_delay_ms:  z.number().int().min(0).max(86_400_000).nullable().optional(),
  ack_escalation_min:      z.number().int().min(1).max(1440).nullable().optional(),
  // Superadmin only: raw telemetry retention that wins over the plan (grandfathering)
  raw_retention_days:      z.number().int().min(7).max(1100).nullable().optional(),
});

// ── Helpers ─────────────────────────────────────────────────

function isSuperAdmin(req) {
  return req.user && req.user.role === 'superadmin';
}

// ── GET /api/tenants ────────────────────────────────────────
// Superadmin: list all tenants. Regular admin: own tenant only.
router.get('/', async (req, res, next) => {
  try {
    if (isSuperAdmin(req)) {
      const { rows } = await db.query(`${TENANT_SELECT} ORDER BY t.created_at DESC`);
      return res.json({ data: rows });
    }

    // Regular admin: own tenant only
    const { rows } = await db.query(`${TENANT_SELECT} WHERE t.id = $1`, [req.tenantId]);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tenants ───────────────────────────────────────
// Create new tenant (superadmin only).
router.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.errors.map(e => e.message).join(', '),
        status: 400,
      });
    }

    const { name, slug, plan, status, trial_expires_at } = parsed.data;

    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Slug "${slug}" is reserved`,
        status: 400,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO tenants (name, slug, plan, status, trial_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, plan, active, status, trial_expires_at, created_at`,
      [name, slug, plan, status || 'active', trial_expires_at || null]
    );

    // Audit: new tenant details
    req.auditContext = { entityId: rows[0].id, changes: { after: { name, slug, plan, status: rows[0].status } } };

    // Refresh MQTT tenant registry
    await mqttSvc.refreshRegistries();

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    // Unique constraint violation on slug
    if (err.code === '23505' && err.constraint && err.constraint.includes('slug')) {
      return res.status(409).json({
        error: 'conflict',
        message: 'A tenant with this slug already exists',
        status: 409,
      });
    }
    next(err);
  }
});

// ── GET /api/tenants/plans ──────────────────────────────────
// The plan catalogue (any admin: the WebUI shows usage against the limit).
router.get('/plans', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT plan, name, max_devices, max_sites, max_users, retention_days, sampling_sec, features, public
         FROM plan_limits WHERE public = true ORDER BY sort_order`);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── Organisation settings (admin of the organisation, or superadmin) ──

const SETTINGS_SELECT = `
  SELECT t.id AS tenant_id, t.electricity_rate, t.electricity_currency,
         COALESCE(s.timezone, 'Europe/Kyiv') AS timezone, COALESCE(s.locale, 'uk') AS locale,
         s.door_alarm_delay_ms, s.pulldown_alarm_delay_ms, s.offline_threshold_ms, s.offline_alarm_delay_ms,
         s.ack_escalation_min, s.raw_retention_days,
         COALESCE(s.raw_retention_days, p.retention_days) AS retention_days, s.updated_at
    FROM tenants t
    LEFT JOIN tenant_settings s ON s.tenant_id = t.id
    LEFT JOIN plan_limits p ON p.plan = t.plan
   WHERE t.id = $1`;

function settingsDefaults() {
  return {
    door_alarm_delay_ms:     parseInt(process.env.DOOR_ALARM_DELAY_MS, 10)     || 600000,
    pulldown_alarm_delay_ms: parseInt(process.env.PULLDOWN_ALARM_DELAY_MS, 10) || 300000,
    offline_threshold_ms:    parseInt(process.env.OFFLINE_THRESHOLD_MS, 10)    || 90000,
    offline_alarm_delay_ms:  parseInt(process.env.OFFLINE_ALARM_DELAY_MS, 10)  || 120000,
    ack_escalation_min:      parseInt(process.env.ALARM_ACK_ESCALATION_MIN, 10) || 15,
  };
}

function canManageTenant(req, id) {
  return isSuperAdmin(req) || id === req.tenantId;
}

router.get('/:id/settings', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!canManageTenant(req, id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied', status: 403 });
    }
    const { rows } = await db.query(SETTINGS_SELECT, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    }
    res.json({ data: { ...rows[0], defaults: settingsDefaults() } });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/settings', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!canManageTenant(req, id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied', status: 403 });
    }
    if (id === db.SYSTEM_TENANT_ID) {
      return res.status(400).json({ error: 'validation_failed', message: 'Cannot modify the system tenant', status: 400 });
    }
    const parsed = settingsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
    }
    const d = parsed.data;
    if (Object.keys(d).length === 0) {
      return res.status(400).json({ error: 'validation_failed', message: 'No fields to update', status: 400 });
    }
    if (d.raw_retention_days !== undefined && !isSuperAdmin(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'raw_retention_days can only be changed by a superadmin', status: 403 });
    }
    if (d.timezone) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: d.timezone }); }
      catch { return res.status(400).json({ error: 'validation_failed', message: 'timezone must be an IANA time zone', status: 400 }); }
    }

    const { rows: exists } = await db.query('SELECT id FROM tenants WHERE id = $1', [id]);
    if (exists.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    }

    await db.transaction(async (client) => {
      if (d.electricity_rate !== undefined) {
        await client.query('UPDATE tenants SET electricity_rate = $2 WHERE id = $1', [id, d.electricity_rate]);
      }
      if (d.electricity_currency !== undefined) {
        await client.query('UPDATE tenants SET electricity_currency = $2 WHERE id = $1', [id, d.electricity_currency]);
      }
      const cols = ['timezone', 'locale', 'door_alarm_delay_ms', 'pulldown_alarm_delay_ms',
                    'offline_threshold_ms', 'offline_alarm_delay_ms', 'ack_escalation_min', 'raw_retention_days'];
      const present = cols.filter(c => d[c] !== undefined);
      if (present.length) {
        const insertCols = ['tenant_id', ...present, 'updated_at', 'updated_by'];
        const values = [id, ...present.map(c => d[c]), new Date(), req.user ? req.user.id : null];
        const placeholders = values.map((_, i) => `$${i + 1}`);
        const updates = present.map(c => `${c} = EXCLUDED.${c}`).join(', ');
        await client.query(
          `INSERT INTO tenant_settings (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})
           ON CONFLICT (tenant_id) DO UPDATE SET ${updates}, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          values
        );
      }
    });

    req.auditContext = { entityId: id, action: 'tenant.settings', changes: d };
    // The MQTT service caches delays/thresholds per organisation
    await mqttSvc.refreshRegistries();
    const { rows } = await db.query(SETTINGS_SELECT, [id]);
    res.json({ data: { ...rows[0], defaults: settingsDefaults() } });
  } catch (err) {
    next(err);
  }
});


// ── GET /api/tenants/:id ────────────────────────────────────
// Get single tenant (superadmin or own tenant).
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Regular admin can only view own tenant
    if (!isSuperAdmin(req) && id !== req.tenantId) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Access denied',
        status: 403,
      });
    }

    const { rows } = await db.query(`${TENANT_SELECT} WHERE t.id = $1`, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Tenant not found',
        status: 404,
      });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tenants/:id ──────────────────────────────────
// Update tenant (superadmin only).
router.patch('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Cannot modify __system__ tenant
    if (id === db.SYSTEM_TENANT_ID) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Cannot modify the system tenant',
        status: 400,
      });
    }

    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'validation_failed',
        message: parsed.error.errors.map(e => e.message).join(', '),
        status: 400,
      });
    }

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'No fields to update',
        status: 400,
      });
    }

    // Suspending an organisation is exactly what a non-payment needs: its
    // devices keep their configuration, the broker ACL and the login gates
    // stop serving it, and reactivation restores everything (plan epic 1.8).
    // `active` and `status` are kept consistent by trg_tenants_sync_status.
    if (updates.status !== undefined && updates.active !== undefined) delete updates.active;

    // Fetch current state for audit
    const beforeRes = await db.query('SELECT name, plan, active, status FROM tenants WHERE id = $1', [id]);
    const beforeTenant = beforeRes.rows[0];

    // Build dynamic SET clause
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }

    values.push(id);
    const { rows } = await db.query(
      `UPDATE tenants SET ${setClauses.join(', ')}
       WHERE id = $${idx}
       RETURNING id, name, slug, plan, active, status, suspended_at, trial_expires_at,
                 billing_email, legal_name, tax_id, billing_currency, contract_started_at, created_at`,
      values
    );
    planMw.invalidate(id);

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Tenant not found',
        status: 404,
      });
    }

    // An explicit plan change ends the grandfathered raw retention: from now on
    // the organisation keeps what its plan says (plan epic 1.9).
    if (updates.plan !== undefined && beforeTenant && updates.plan !== beforeTenant.plan) {
      await db.query('UPDATE tenant_settings SET raw_retention_days = NULL WHERE tenant_id = $1', [id]);
    }

    // Audit: before/after
    if (beforeTenant) {
      const after = {};
      for (const k of Object.keys(updates)) after[k] = rows[0][k];
      req.auditContext = { entityId: id, changes: { before: beforeTenant, after } };
    }

    // Refresh MQTT tenant registry
    await mqttSvc.refreshRegistries();

    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/tenants/bulk ────────────────────────────────
// Bulk delete tenants (superadmin only).
router.delete('/bulk', requireSuperadmin, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'validation_failed', message: 'ids array required', status: 400 });
    }

    // Filter out system tenant
    const toDelete = ids.filter(id => id !== db.SYSTEM_TENANT_ID);
    if (toDelete.length === 0) {
      return res.status(400).json({ error: 'validation_failed', message: 'Cannot delete system tenant', status: 400 });
    }

    let totalMoved = 0;
    const deleted = [];

    for (const id of toDelete) {
      const result = await db.transaction(async (client) => {
        const { rows } = await client.query(`SELECT id, name, slug FROM tenants WHERE id = $1`, [id]);
        if (rows.length === 0) return null;

        const moved = await client.query(
          `UPDATE devices SET tenant_id = $1 WHERE tenant_id = $2`, [db.SYSTEM_TENANT_ID, id]
        );
        await client.query(`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]);
        await client.query(`DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]);
        await client.query(`DELETE FROM user_tenants WHERE tenant_id = $1`, [id]);
        await client.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);
        await client.query(`DELETE FROM tenants WHERE id = $1`, [id]);

        return { ...rows[0], movedDevices: moved.rowCount };
      });
      if (result) {
        deleted.push(result);
        totalMoved += result.movedDevices;
      }
    }

    await mqttSvc.refreshRegistries();

    req.log?.info?.({ count: deleted.length, totalMoved }, 'Bulk tenant delete');
    res.json({ data: { deleted: deleted.length, movedDevices: totalMoved, tenants: deleted } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/tenants/:id ─────────────────────────────────
// Hard delete tenant (superadmin only).
// Moves orphan devices to __system__, deletes users and data.
router.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Cannot delete __system__ tenant
    if (id === db.SYSTEM_TENANT_ID) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Cannot delete the system tenant',
        status: 400,
      });
    }

    const result = await db.transaction(async (client) => {
      // Verify tenant exists
      const { rows } = await client.query(
        `SELECT id, name, slug FROM tenants WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) return null;
      const tenant = rows[0];

      // Move devices to __system__ tenant
      const moved = await client.query(
        `UPDATE devices SET tenant_id = $1 WHERE tenant_id = $2 RETURNING mqtt_device_id`,
        [db.SYSTEM_TENANT_ID, id]
      );

      // Delete tenant-scoped data (order matters: children before parents)
      await client.query(`DELETE FROM notification_log WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM notification_subscribers WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM alarms WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM events WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM ota_jobs WHERE rollout_id IN (SELECT id FROM ota_rollouts WHERE tenant_id = $1)`, [id]);
      await client.query(`DELETE FROM ota_rollouts WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM firmwares WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM service_records WHERE tenant_id = $1`, [id]);
      // Nullify audit_log references before deleting users/tenant
      // (immutable trigger blocks cascaded updates, so do it explicitly)
      await client.query(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable`);
      await client.query(`UPDATE audit_log SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]);
      await client.query(`UPDATE audit_log SET tenant_id = NULL WHERE tenant_id = $1`, [id]);
      await client.query(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable`);

      // Delete user-related data
      await client.query(
        `DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
        [id]
      );
      await client.query(
        `DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
        [id]
      );
      await client.query(`DELETE FROM user_tenants WHERE tenant_id = $1`, [id]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);

      // Delete the tenant itself
      await client.query(`DELETE FROM tenants WHERE id = $1`, [id]);

      return { ...tenant, movedDevices: moved.rowCount };
    });

    if (!result) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Tenant not found',
        status: 404,
      });
    }

    // Audit
    req.auditContext = { entityId: id, changes: { before: { name: result.name, slug: result.slug } } };

    // Refresh MQTT tenant registry
    await mqttSvc.refreshRegistries();

    req.log?.info?.({ tenantId: id, name: result.name, movedDevices: result.movedDevices }, 'Tenant hard deleted');
    res.json({ data: { deleted: true, tenant: result } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
