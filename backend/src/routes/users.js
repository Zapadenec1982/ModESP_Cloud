'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const authSvc    = require('../services/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const createUserSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
  role:     z.enum(['admin', 'technician', 'viewer']).default('viewer'),
});

const updateUserSchema = z.object({
  email:    z.string().email().optional(),
  role:     z.enum(['admin', 'technician', 'viewer']).optional(),
  active:   z.boolean().optional(),
});

const updateProfileSchema = z.object({
  email:        z.string().email().optional(),
  password:     z.string().min(6).optional(),
  old_password: z.string().optional(),
});

const deviceAccessSchema = z.object({
  device_id: z.string().uuid(),
});

// ── GET /users — list (admin, tenant-scoped) ────────────

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, role, active, created_at, last_login
       FROM users WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.tenantId]
    );
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

// ── POST /users — create (admin) ────────────────────────

router.post('/', async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { email, password, role } = parsed.data;

  try {
    const hash = await authSvc.hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, active, created_at`,
      [req.tenantId, email, hash, role]
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

// ── PUT /users/:id — update (admin) ─────────────────────

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
  const sets = [];
  const params = [];
  let idx = 1;

  if (data.email !== undefined) { sets.push(`email = $${idx++}`); params.push(data.email); }
  if (data.role  !== undefined) { sets.push(`role = $${idx++}`);  params.push(data.role);  }
  if (data.active !== undefined) { sets.push(`active = $${idx++}`); params.push(data.active); }

  if (sets.length === 0) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'Nothing to update',
      status: 400,
    });
  }

  params.push(req.params.id, req.tenantId);

  try {
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx}
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

// ── DELETE /users/:id — soft delete (admin) ─────────────

router.delete('/:id', async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user.id) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Cannot delete your own account',
        status: 400,
      });
    }

    const { rows } = await db.query(
      `UPDATE users SET active = false WHERE id = $1 AND tenant_id = $2
       RETURNING id, email, role, active`,
      [req.params.id, req.tenantId]
    );

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

// ── POST /users/:id/devices — grant device access ───────

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
    await db.query(
      `INSERT INTO user_devices (user_id, device_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, parsed.data.device_id]
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

module.exports = router;
