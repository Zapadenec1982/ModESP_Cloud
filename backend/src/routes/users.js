'use strict';

const { Router }  = require('express');
const { z }       = require('zod');
const crypto      = require('crypto');
const db          = require('../services/db');
const authSvc     = require('../services/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const createUserSchema = z.object({
  email:     z.string().email(),
  password:  z.string().min(8),
  role:      z.enum(['admin', 'technician', 'viewer']).default('viewer'),
  tenant_id: z.string().uuid().optional(),   // superadmin only — create in another tenant
});

const updateUserSchema = z.object({
  email:     z.string().email().optional(),
  role:      z.enum(['admin', 'technician', 'viewer']).optional(),
  active:    z.boolean().optional(),
  tenant_id: z.string().uuid().optional(),   // superadmin only — reassign to another tenant
});

const updateProfileSchema = z.object({
  email:        z.string().email().optional(),
  password:     z.string().min(8).optional(),
  old_password: z.string().optional(),
});

const deviceAccessSchema = z.object({
  device_id: z.string().uuid(),
});

// ── GET /users — list (admin: tenant-scoped, superadmin: all) ─

router.get('/', async (req, res) => {
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  try {
    let rows;
    if (isSuperAdmin) {
      // Superadmin sees ALL users cross-tenant with tenant memberships
      ({ rows } = await db.query(
        `SELECT u.id, u.email, u.role, u.active, u.created_at, u.last_login,
                u.tenant_id, u.telegram_id, t.name AS tenant_name, t.slug AS tenant_slug
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         ORDER BY t.name, u.created_at DESC`
      ));
      // Attach tenant memberships array to each user
      const { rows: memberships } = await db.query(
        `SELECT ut.user_id, t.id AS tenant_id, t.name, t.slug
           FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
           ORDER BY t.name`
      );
      const memMap = {};
      for (const m of memberships) {
        if (!memMap[m.user_id]) memMap[m.user_id] = [];
        memMap[m.user_id].push({ id: m.tenant_id, name: m.name, slug: m.slug });
      }
      for (const u of rows) {
        u.tenants = memMap[u.id] || [{ id: u.tenant_id, name: u.tenant_name, slug: u.tenant_slug }];
      }
    } else {
      ({ rows } = await db.query(
        `SELECT id, email, role, active, created_at, last_login, telegram_id
         FROM users WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [req.tenantId]
      ));
    }
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List users failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list users', status: 500 });
  }
});

// ── GET /users/me — self profile ────────────────────────

router.get('/me', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, role, active, created_at, last_login, push_token, telegram_id
       FROM users WHERE id = $1 AND tenant_id = $2`,
      [req.user.id, req.tenantId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    req.log?.error?.({ err }, 'Get profile failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to get profile', status: 500 });
  }
});

// ── PUT /users/me — update own profile ──────────────────

router.put('/me', async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { email, password, old_password } = parsed.data;

  try {
    // If changing password, verify old password
    if (password) {
      if (!old_password) {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'old_password is required to change password',
          status: 400,
        });
      }

      const { rows } = await db.query(
        'SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2',
        [req.user.id, req.tenantId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
      }

      const valid = await authSvc.comparePassword(old_password, rows[0].password_hash);
      if (!valid) {
        return res.status(400).json({
          error: 'invalid_password',
          message: 'Current password is incorrect',
          status: 400,
        });
      }
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (email) {
      sets.push(`email = $${idx++}`);
      params.push(email);
    }
    if (password) {
      const hash = await authSvc.hashPassword(password);
      sets.push(`password_hash = $${idx++}`);
      params.push(hash);
    }

    if (sets.length === 0) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Nothing to update',
        status: 400,
      });
    }

    params.push(req.user.id, req.tenantId);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx}
       RETURNING id, email, role, active`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    req.log?.error?.({ err }, 'Update profile failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update profile', status: 500 });
  }
});

// ── POST /users/me/telegram-link — generate link code ────

router.post('/me/telegram-link', async (req, res) => {
  try {
    const code = crypto.randomBytes(8).toString('hex');  // 16 hex chars
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min TTL

    await db.query(
      `UPDATE users SET telegram_link_code = $1, telegram_link_expires = $2
       WHERE id = $3 AND tenant_id = $4`,
      [code, expires, req.user.id, req.tenantId]
    );

    res.json({ data: { link_code: code, expires_at: expires.toISOString() } });
  } catch (err) {
    req.log?.error?.({ err }, 'Generate telegram link failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to generate link', status: 500 });
  }
});

// ── DELETE /users/me/telegram-link — unlink Telegram ─────

router.delete('/me/telegram-link', async (req, res) => {
  try {
    await db.query(
      `UPDATE users SET telegram_id = NULL, telegram_link_code = NULL, telegram_link_expires = NULL
       WHERE id = $1 AND tenant_id = $2`,
      [req.user.id, req.tenantId]
    );
    res.json({ data: { message: 'Telegram unlinked' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Unlink telegram failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to unlink', status: 500 });
  }
});

// ── POST /users — create (admin / superadmin) ───────────

router.post('/', async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { email, password, role, tenant_id } = parsed.data;
  const isSuperAdmin = req.user && req.user.role === 'superadmin';

  // Only superadmin can specify tenant_id
  const targetTenantId = (isSuperAdmin && tenant_id) ? tenant_id : req.tenantId;

  try {
    const hash = await authSvc.hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, active, created_at`,
      [targetTenantId, email, hash, role]
    );
    // Also add to user_tenants junction table
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [rows[0].id, targetTenantId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') { // unique violation
      return res.status(409).json({
        error: 'conflict',
        message: 'User with this email already exists',
        status: 409,
      });
    }
    req.log?.error?.({ err }, 'Create user failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to create user', status: 500 });
  }
});

// ── PUT /users/:id — update (admin / superadmin) ────────

router.put('/:id', async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const data = parsed.data;
  const isSuperAdmin = req.user && req.user.role === 'superadmin';

  try {
    // ── Role hierarchy check: fetch target user ──
    const targetQ = isSuperAdmin
      ? 'SELECT id, role FROM users WHERE id = $1'
      : 'SELECT id, role FROM users WHERE id = $1 AND tenant_id = $2';
    const targetParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows: targetRows } = await db.query(targetQ, targetParams);

    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const targetUser = targetRows[0];

    // Admin cannot modify superadmin
    if (targetUser.role === 'superadmin' && !isSuperAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Cannot modify superadmin user',
        status: 403,
      });
    }

    // Only superadmin can use tenant_id field
    if (data.tenant_id && !isSuperAdmin) {
      delete data.tenant_id;
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (data.email !== undefined)     { sets.push(`email = $${idx++}`);     params.push(data.email); }
    if (data.role  !== undefined)     { sets.push(`role = $${idx++}`);      params.push(data.role);  }
    if (data.active !== undefined)    { sets.push(`active = $${idx++}`);    params.push(data.active); }
    if (data.tenant_id !== undefined) { sets.push(`tenant_id = $${idx++}`); params.push(data.tenant_id); }

    if (sets.length === 0) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'Nothing to update',
        status: 400,
      });
    }

    // Superadmin: no tenant_id filter; admin: scoped to own tenant
    let whereClause;
    if (isSuperAdmin) {
      params.push(req.params.id);
      whereClause = `WHERE id = $${idx++}`;
    } else {
      params.push(req.params.id, req.tenantId);
      whereClause = `WHERE id = $${idx++} AND tenant_id = $${idx}`;
    }

    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} ${whereClause}
       RETURNING id, email, role, active`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'conflict',
        message: 'User with this email already exists',
        status: 409,
      });
    }
    req.log?.error?.({ err }, 'Update user failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update user', status: 500 });
  }
});

// ── DELETE /users/:id — soft delete (admin / superadmin) ──

router.delete('/:id', async (req, res) => {
  const isSuperAdmin = req.user && req.user.role === 'superadmin';

  try {
    // Prevent self-deletion
    if (req.params.id === req.user.id) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Cannot delete your own account',
        status: 400,
      });
    }

    // ── Role hierarchy check ──
    const checkQ = isSuperAdmin
      ? 'SELECT role FROM users WHERE id = $1'
      : 'SELECT role FROM users WHERE id = $1 AND tenant_id = $2';
    const checkParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows: checkRows } = await db.query(checkQ, checkParams);

    if (checkRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Admin cannot delete superadmin
    if (checkRows[0].role === 'superadmin' && !isSuperAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Cannot modify superadmin user',
        status: 403,
      });
    }

    // Deactivate
    const delQ = isSuperAdmin
      ? `UPDATE users SET active = false WHERE id = $1 RETURNING id, email, role, active`
      : `UPDATE users SET active = false WHERE id = $1 AND tenant_id = $2 RETURNING id, email, role, active`;
    const delParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows } = await db.query(delQ, delParams);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Revoke all refresh tokens
    await db.query(
      'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1',
      [req.params.id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    req.log?.error?.({ err }, 'Delete user failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to delete user', status: 500 });
  }
});

// ── POST /users/:id/telegram-link — admin generates code for user ─

router.post('/:id/telegram-link', async (req, res) => {
  const isSuperAdmin = req.user && req.user.role === 'superadmin';

  try {
    // Verify target user belongs to this tenant (or superadmin)
    const checkQ = isSuperAdmin
      ? 'SELECT id, email FROM users WHERE id = $1 AND active = true'
      : 'SELECT id, email FROM users WHERE id = $1 AND tenant_id = $2 AND active = true';
    const checkParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows } = await db.query(checkQ, checkParams);

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const code = crypto.randomBytes(8).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    const updateQ = isSuperAdmin
      ? `UPDATE users SET telegram_link_code = $1, telegram_link_expires = $2 WHERE id = $3`
      : `UPDATE users SET telegram_link_code = $1, telegram_link_expires = $2 WHERE id = $3 AND tenant_id = $4`;
    const updateParams = isSuperAdmin
      ? [code, expires, req.params.id]
      : [code, expires, req.params.id, req.tenantId];
    await db.query(updateQ, updateParams);

    res.json({ data: { link_code: code, expires_at: expires.toISOString(), email: rows[0].email } });
  } catch (err) {
    req.log?.error?.({ err }, 'Generate telegram link for user failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to generate link', status: 500 });
  }
});

// ── GET /users/:id/tenants — list tenant memberships (superadmin) ──

router.get('/:id/tenants', async (req, res) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'forbidden', message: 'Superadmin only', status: 403 });
  }
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.slug, ut.created_at
         FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1
         ORDER BY t.name`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List user tenants failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list tenants', status: 500 });
  }
});

// ── POST /users/:id/tenants — add to tenant (superadmin) ──

const addTenantSchema = z.object({ tenant_id: z.string().uuid() });

router.post('/:id/tenants', async (req, res) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'forbidden', message: 'Superadmin only', status: 403 });
  }
  const parsed = addTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed', message: 'tenant_id (UUID) is required', status: 400,
    });
  }

  const { tenant_id } = parsed.data;
  try {
    // Verify user and tenant exist
    const { rows: uCheck } = await db.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (uCheck.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }
    const { rows: tCheck } = await db.query('SELECT id FROM tenants WHERE id = $1', [tenant_id]);
    if (tCheck.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    }

    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, tenant_id]
    );

    // Return updated membership list
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.slug
         FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1 ORDER BY t.name`,
      [req.params.id]
    );
    res.status(201).json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'Add user tenant failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to add tenant', status: 500 });
  }
});

// ── DELETE /users/:id/tenants/:tenantId — remove from tenant (superadmin) ──

router.delete('/:id/tenants/:tenantId', async (req, res) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'forbidden', message: 'Superadmin only', status: 403 });
  }

  const userId = req.params.id;
  const tenantId = req.params.tenantId;

  try {
    // Check membership count — cannot remove last tenant
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM user_tenants WHERE user_id = $1',
      [userId]
    );
    if (countRows[0].cnt <= 1) {
      return res.status(400).json({
        error: 'bad_request', message: 'Cannot remove last tenant membership', status: 400,
      });
    }

    await db.query(
      'DELETE FROM user_tenants WHERE user_id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );

    // If removed tenant was the user's default, switch to another
    const { rows: uRows } = await db.query(
      'SELECT tenant_id FROM users WHERE id = $1', [userId]
    );
    if (uRows.length > 0 && uRows[0].tenant_id === tenantId) {
      const { rows: remaining } = await db.query(
        `SELECT tenant_id FROM user_tenants WHERE user_id = $1 LIMIT 1`, [userId]
      );
      if (remaining.length > 0) {
        await db.query(
          'UPDATE users SET tenant_id = $1 WHERE id = $2',
          [remaining[0].tenant_id, userId]
        );
      }
    }

    // Return updated list
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.slug
         FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1 ORDER BY t.name`,
      [userId]
    );
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'Remove user tenant failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to remove tenant', status: 500 });
  }
});

// ── GET /users/:id/devices — list assigned devices ───────

router.get('/:id/devices', async (req, res) => {
  try {
    const isSuperAdmin = req.user && req.user.role === 'superadmin';

    // Lookup target user — superadmin can see any user, others only same tenant
    const userSql = isSuperAdmin
      ? 'SELECT id, tenant_id FROM users WHERE id = $1'
      : 'SELECT id, tenant_id FROM users WHERE id = $1 AND tenant_id = $2';
    const userParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const userCheck = await db.query(userSql, userParams);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const targetTenantId = userCheck.rows[0].tenant_id;

    const { rows } = await db.query(
      `SELECT d.id, d.mqtt_device_id, d.name, d.location, d.model, d.online
       FROM user_devices ud
       JOIN devices d ON d.id = ud.device_id
       WHERE ud.user_id = $1 AND d.tenant_id = $2
       ORDER BY d.name NULLS LAST, d.mqtt_device_id`,
      [req.params.id, targetTenantId]
    );

    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List user devices failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list user devices', status: 500 });
  }
});

// ── PUT /users/:id/devices — bulk replace device access ──

const bulkDevicesSchema = z.object({
  device_ids: z.array(z.string().uuid()).max(500),
});

router.put('/:id/devices', async (req, res) => {
  const parsed = bulkDevicesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0]?.message || 'device_ids (UUID[]) is required',
      status: 400,
    });
  }

  const { device_ids } = parsed.data;
  const userId = req.params.id;
  const isSuperAdmin = req.user && req.user.role === 'superadmin';

  try {
    // Lookup target user — superadmin can manage any user, others only same tenant
    const userSql = isSuperAdmin
      ? 'SELECT id, tenant_id FROM users WHERE id = $1'
      : 'SELECT id, tenant_id FROM users WHERE id = $1 AND tenant_id = $2';
    const userParams = isSuperAdmin ? [userId] : [userId, req.tenantId];
    const userCheck = await db.query(userSql, userParams);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const targetTenantId = userCheck.rows[0].tenant_id;

    // Verify all device_ids belong to the target user's tenant
    if (device_ids.length > 0) {
      const devCheck = await db.query(
        `SELECT COUNT(*)::int AS count FROM devices
         WHERE id = ANY($1) AND tenant_id = $2`,
        [device_ids, targetTenantId]
      );
      if (devCheck.rows[0].count !== device_ids.length) {
        return res.status(400).json({
          error: 'invalid_devices',
          message: 'Some device_ids do not belong to this tenant',
          status: 400,
        });
      }
    }

    // Transactional bulk replace: DELETE all + multi-row INSERT
    await db.transaction(async (client) => {
      await client.query('DELETE FROM user_devices WHERE user_id = $1', [userId]);

      if (device_ids.length > 0) {
        const grantedBy = req.user?.id || null;
        // Build multi-row VALUES
        const placeholders = device_ids.map((_, i) =>
          `($1, $${i + 2}, $${device_ids.length + 2}, NOW())`
        );
        await client.query(
          `INSERT INTO user_devices (user_id, device_id, granted_by, granted_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          [userId, ...device_ids, grantedBy]
        );
      }
    });

    res.json({ data: { message: 'Device access updated', count: device_ids.length } });
  } catch (err) {
    req.log?.error?.({ err }, 'Bulk update user devices failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update device access', status: 500 });
  }
});

// ── POST /users/:id/devices — grant single device access ───────

router.post('/:id/devices', async (req, res) => {
  const parsed = deviceAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'device_id (UUID) is required',
      status: 400,
    });
  }

  try {
    // Verify device belongs to this tenant
    const devCheck = await db.query(
      'SELECT id FROM devices WHERE id = $1 AND tenant_id = $2',
      [parsed.data.device_id, req.tenantId]
    );
    if (devCheck.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Device not found in tenant', status: 404 });
    }

    const grantedBy = req.user?.id || null;
    await db.query(
      `INSERT INTO user_devices (user_id, device_id, granted_by, granted_at)
       VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
      [req.params.id, parsed.data.device_id, grantedBy]
    );
    res.status(201).json({ data: { message: 'Device access granted' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Grant device access failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to grant access', status: 500 });
  }
});

// ── DELETE /users/:id/devices/:deviceId — revoke ────────

router.delete('/:id/devices/:deviceId', async (req, res) => {
  try {
    // Verify target user belongs to this tenant
    const userCheck = await db.query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    await db.query(
      'DELETE FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [req.params.id, req.params.deviceId]
    );
    res.json({ data: { message: 'Device access revoked' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke device access failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke access', status: 500 });
  }
});

// ══════════════════════════════════════════════════════════
// ── Push Subscriptions (Web Push API) ────────────────────
// ══════════════════════════════════════════════════════════

const pushSubSchema = z.object({
  endpoint:   z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
});

// POST /users/me/push-subscription — save Web Push subscription
router.post('/me/push-subscription', async (req, res) => {
  const parsed = pushSubSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { endpoint, keys } = parsed.data;
  const userId   = req.user.id || req.user.sub;
  const tenantId = req.tenantId;

  try {
    const { rows } = await db.query(
      `INSERT INTO push_subscriptions (user_id, tenant_id, endpoint, key_p256dh, key_auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET
         key_p256dh = EXCLUDED.key_p256dh,
         key_auth   = EXCLUDED.key_auth,
         user_id    = EXCLUDED.user_id,
         tenant_id  = EXCLUDED.tenant_id,
         active     = true,
         user_agent = EXCLUDED.user_agent
       RETURNING id`,
      [userId, tenantId, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
    );
    res.json({ data: { id: rows[0].id, message: 'Subscription saved' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Save push subscription failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to save subscription', status: 500 });
  }
});

// DELETE /users/me/push-subscription — remove Web Push subscription by endpoint
router.delete('/me/push-subscription', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'endpoint is required',
      status: 400,
    });
  }

  const userId = req.user.id || req.user.sub;

  try {
    await db.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [userId, endpoint]
    );
    res.json({ data: { message: 'Subscription removed' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Delete push subscription failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to remove subscription', status: 500 });
  }
});

// ── Password reset (admin generates code for user) ────────

router.post('/:id/password-reset', async (req, res) => {
  try {
    const userId = req.params.id;
    const isSuperAdmin = req.user.role === 'superadmin';

    // Verify target user exists (scoped to tenant for admin, any for superadmin)
    const checkQ = isSuperAdmin
      ? 'SELECT id, email FROM users WHERE id = $1 AND active = true'
      : `SELECT u.id, u.email FROM users u
         JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $2
         WHERE u.id = $1 AND u.active = true`;
    const checkParams = isSuperAdmin ? [userId] : [userId, req.tenantId];
    const { rows } = await db.query(checkQ, checkParams);

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const code    = crypto.randomBytes(8).toString('hex'); // 16 hex chars
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await db.query(
      'UPDATE users SET password_reset_code = $1, password_reset_expires = $2 WHERE id = $3',
      [code, expires, userId]
    );

    req.auditContext = { entityId: userId, action: 'user.password_reset_generate' };

    res.json({
      data: {
        reset_code:  code,
        expires_at:  expires.toISOString(),
        email:       rows[0].email,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Generate password reset code failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to generate reset code', status: 500 });
  }
});

module.exports = router;
