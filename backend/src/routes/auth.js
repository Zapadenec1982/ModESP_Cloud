'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const authSvc    = require('../services/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

// ── POST /auth/login ────────────────────────────────────

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { email, password } = parsed.data;

  try {
    // Find user by email (across all tenants — email+tenant is unique)
    const { rows } = await db.query(
      `SELECT id, tenant_id, email, password_hash, role, active
       FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: 'invalid_credentials',
        message: 'Invalid email or password',
        status: 401,
      });
    }

    const user = rows[0];

    if (!user.active) {
      return res.status(401).json({
        error: 'account_disabled',
        message: 'Account is disabled',
        status: 401,
      });
    }

    const valid = await authSvc.comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        error: 'invalid_credentials',
        message: 'Invalid email or password',
        status: 401,
      });
    }

    // Generate tokens
    const accessToken  = authSvc.generateAccessToken({
      id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id,
    });
    const refreshToken = authSvc.generateRefreshToken();
    const tokenHash    = authSvc.hashRefreshToken(refreshToken);

    const refreshExpiresIn = parseInt(process.env.JWT_REFRESH_EXPIRES_IN, 10) || 2592000;
    const expiresAt = new Date(Date.now() + refreshExpiresIn * 1000);

    // Store refresh token hash
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    // Update last_login
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    res.json({
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: {
          id:    user.id,
          email: user.email,
          role:  user.role,
        },
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Login failed') || console.error('Login failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Login failed', status: 500 });
  }
});

// ── POST /auth/refresh ──────────────────────────────────

router.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'refresh_token is required',
      status: 400,
    });
  }

  const { refresh_token } = parsed.data;
  const tokenHash = authSvc.hashRefreshToken(refresh_token);

  try {
    // Find token
    const { rows } = await db.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked,
              u.email, u.role, u.tenant_id, u.active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: 'invalid_token',
        message: 'Invalid refresh token',
        status: 401,
      });
    }

    const row = rows[0];

    if (row.revoked || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'token_expired',
        message: 'Refresh token expired or revoked',
        status: 401,
      });
    }

    if (!row.active) {
      return res.status(401).json({
        error: 'account_disabled',
        message: 'Account is disabled',
        status: 401,
      });
    }

    // Rotation: revoke old token, issue new pair
    await db.query(
      'UPDATE refresh_tokens SET revoked = true WHERE id = $1',
      [row.id]
    );

    const accessToken     = authSvc.generateAccessToken({
      id: row.user_id, email: row.email, role: row.role, tenantId: row.tenant_id,
    });
    const newRefreshToken = authSvc.generateRefreshToken();
    const newTokenHash    = authSvc.hashRefreshToken(newRefreshToken);

    const refreshExpiresIn = parseInt(process.env.JWT_REFRESH_EXPIRES_IN, 10) || 2592000;
    const expiresAt = new Date(Date.now() + refreshExpiresIn * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [row.user_id, newTokenHash, expiresAt]
    );

    res.json({
      data: {
        access_token:  accessToken,
        refresh_token: newRefreshToken,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Refresh failed') || console.error('Refresh failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Token refresh failed', status: 500 });
  }
});

// ── POST /auth/logout ───────────────────────────────────

router.post('/logout', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'refresh_token is required',
      status: 400,
    });
  }

  const { refresh_token } = parsed.data;
  const tokenHash = authSvc.hashRefreshToken(refresh_token);

  try {
    await db.query(
      'UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1',
      [tokenHash]
    );
    res.json({ data: { message: 'Logged out' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Logout failed') || console.error('Logout failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Logout failed', status: 500 });
  }
});

module.exports = router;
