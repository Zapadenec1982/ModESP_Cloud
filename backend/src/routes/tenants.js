'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const mqttSvc    = require('../services/mqtt');
const { requireSuperadmin } = require('../middleware/auth');

const router = Router();

const RESERVED_SLUGS = new Set(['__system__', 'pending', 'system', 'admin', 'api']);

// ── Validation schemas ──────────────────────────────────────

const createTenantSchema = z.object({
  name: z.string().min(1).max(128).trim(),
  slug: z.string().min(2).max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Slug must be lowercase alphanumeric with hyphens/underscores'),
  plan: z.enum(['free', 'basic', 'pro', 'enterprise']).default('free'),
});

const updateTenantSchema = z.object({
  name:   z.string().min(1).max(128).trim().optional(),
  plan:   z.enum(['free', 'basic', 'pro', 'enterprise']).optional(),
  active: z.boolean().optional(),
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
      const { rows } = await db.query(`
        SELECT t.id, t.name, t.slug, t.plan, t.active, t.created_at,
               (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id) AS device_count,
               (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active = true) AS user_count
        FROM tenants t
        ORDER BY t.created_at DESC
      `);
      return res.json({ data: rows });
    }

    // Regular admin: own tenant only
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.slug, t.plan, t.active, t.created_at,
             (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id) AS device_count,
             (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active = true) AS user_count
      FROM tenants t
      WHERE t.id = $1
    `, [req.tenantId]);
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

    const { name, slug, plan } = parsed.data;

    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Slug "${slug}" is reserved`,
        status: 400,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO tenants (name, slug, plan)
       VALUES ($1, $2, $3)
       RETURNING id, name, slug, plan, active, created_at`,
      [name, slug, plan]
    );

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

    const { rows } = await db.query(`
      SELECT t.id, t.name, t.slug, t.plan, t.active, t.created_at,
             (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id) AS device_count,
             (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active = true) AS user_count
      FROM tenants t
      WHERE t.id = $1
    `, [id]);

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

    // If deactivating, check for active devices
    if (updates.active === false) {
      const deviceCheck = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM devices WHERE tenant_id = $1 AND status = 'active'`,
        [id]
      );
      if (deviceCheck.rows[0].cnt > 0) {
        return res.status(400).json({
          error: 'validation_failed',
          message: `Cannot deactivate tenant with ${deviceCheck.rows[0].cnt} active device(s). Reassign or disable them first.`,
          status: 400,
        });
      }
    }

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
       RETURNING id, name, slug, plan, active, created_at`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Tenant not found',
        status: 404,
      });
    }

    // Refresh MQTT tenant registry
    await mqttSvc.refreshRegistries();

    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/tenants/:id ─────────────────────────────────
// Soft delete tenant (superadmin only).
// Rejects if tenant has any devices.
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

    // Check for any devices (not just active)
    const deviceCheck = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM devices WHERE tenant_id = $1`,
      [id]
    );
    if (deviceCheck.rows[0].cnt > 0) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Cannot delete tenant with ${deviceCheck.rows[0].cnt} device(s). Reassign them first.`,
        status: 400,
      });
    }

    // Soft delete: deactivate tenant + all its users
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE tenants SET active = false WHERE id = $1 AND active = true
         RETURNING id, name, slug`,
        [id]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'not_found',
          message: 'Tenant not found or already deactivated',
          status: 404,
        });
      }

      // Deactivate all users of this tenant
      await client.query(
        `UPDATE users SET active = false WHERE tenant_id = $1`,
        [id]
      );

      // Revoke all refresh tokens
      await client.query(
        `DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
        [id]
      );

      await client.query('COMMIT');

      // Refresh MQTT tenant registry
      await mqttSvc.refreshRegistries();

      res.json({ data: { deleted: true, tenant: rows[0] } });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
