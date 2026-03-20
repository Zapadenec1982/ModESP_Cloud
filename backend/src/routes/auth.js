'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const authSvc    = require('../services/auth');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const selectTenantSchema = z.object({
  pending_token: z.string().min(1),
  tenant_id:     z.string().uuid(),
});

const switchTenantSchema = z.object({
  tenant_id: z.string().uuid(),
});

// ── Helpers ─────────────────────────────────────────────

async function issueTokens(user, tenantId) {
  const accessToken  = authSvc.generateAccessToken({
    id: user.id, email: user.email, role: user.role, tenantId,
  });
  const refreshToken = authSvc.generateRefreshToken();
  const tokenHash    = authSvc.hashRefreshToken(refreshToken);

  const refreshExpiresIn = parseInt(process.env.JWT_REFRESH_EXPIRES_IN, 10) || 2592000;
  const expiresAt = new Date(Date.now() + refreshExpiresIn * 1000);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, tenant_id)
     VALUES ($1, $2, $3, $4)`,
    [user.id, tokenHash, expiresAt, tenantId]
  );

  return { accessToken, refreshToken };
}

async function getUserTenants(userId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.slug
       FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = $1 AND t.active = true
       ORDER BY t.name`,
    [userId]
  );
  return rows;
}

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
    // Find user by email
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

    // Fetch available tenants from user_tenants
    const tenants = await getUserTenants(user.id);

    // Fallback: if user_tenants is empty (legacy), use users.tenant_id
    if (tenants.length === 0 && user.tenant_id) {
      const { rows: tRows } = await db.query(
        'SELECT id, name, slug FROM tenants WHERE id = $1',
        [user.tenant_id]
      );
      if (tRows.length > 0) tenants.push(tRows[0]);
    }

    if (tenants.length === 0) {
      return res.status(401).json({
        error: 'no_tenant',
        message: 'User is not assigned to any tenant',
        status: 401,
      });
    }

    // Single tenant or superadmin → direct login (no tenant picker)
    // Superadmin always logs into their primary tenant (users.tenant_id)
    // and sees all devices cross-tenant via API bypass.
    if (tenants.length === 1 || user.role === 'superadmin') {
      const loginTenant = user.role === 'superadmin'
        ? tenants.find(t => t.id === user.tenant_id) || tenants[0]
        : tenants[0];
      const { accessToken, refreshToken } = await issueTokens(user, loginTenant.id);
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

      return res.json({
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          user: { id: user.id, email: user.email, role: user.role },
          tenant: loginTenant,
          tenants,
        },
      });
    }

    // Multiple tenants → require tenant selection
    const pendingToken = authSvc.generatePendingToken({
      id: user.id, email: user.email, role: user.role,
    });

    res.json({
      data: {
        require_tenant_select: true,
        pending_token: pendingToken,
        user: { id: user.id, email: user.email, role: user.role },
        tenants,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Login failed') || console.error('Login failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Login failed', status: 500 });
  }
});

// ── POST /auth/select-tenant ────────────────────────────
// Complete login after tenant selection (uses pending_token)

router.post('/select-tenant', async (req, res) => {
  const parsed = selectTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { pending_token, tenant_id } = parsed.data;

  try {
    const payload = authSvc.verifyPendingToken(pending_token);

    // Verify user still active
    const { rows: uRows } = await db.query(
      'SELECT id, email, role, active FROM users WHERE id = $1',
      [payload.sub]
    );
    if (uRows.length === 0 || !uRows[0].active) {
      return res.status(401).json({
        error: 'account_disabled', message: 'Account not found or disabled', status: 401,
      });
    }
    const user = uRows[0];

    // Verify membership
    const { rows: mRows } = await db.query(
      'SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2',
      [user.id, tenant_id]
    );
    if (mRows.length === 0) {
      return res.status(403).json({
        error: 'forbidden', message: 'Not a member of this tenant', status: 403,
      });
    }

    const { accessToken, refreshToken } = await issueTokens(user, tenant_id);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Fetch tenant info
    const { rows: tRows } = await db.query(
      'SELECT id, name, slug FROM tenants WHERE id = $1', [tenant_id]
    );
    const tenants = await getUserTenants(user.id);

    res.json({
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: { id: user.id, email: user.email, role: user.role },
        tenant: tRows[0] || null,
        tenants,
      },
    });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'invalid_token', message: 'Pending token invalid or expired', status: 401,
      });
    }
    req.log?.error?.({ err }, 'Select tenant failed') || console.error('Select tenant failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Select tenant failed', status: 500 });
  }
});

// ── POST /auth/switch-tenant ────────────────────────────
// Switch active tenant (requires valid access token)

router.post('/switch-tenant', authenticate, async (req, res) => {
  const parsed = switchTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { tenant_id } = parsed.data;
  const userId = req.user.id;
  const isSuperAdmin = req.user.role === 'superadmin';

  try {
    // Superadmin can switch to any tenant; others need membership
    if (!isSuperAdmin) {
      const { rows } = await db.query(
        'SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenant_id]
      );
      if (rows.length === 0) {
        return res.status(403).json({
          error: 'forbidden', message: 'Not a member of this tenant', status: 403,
        });
      }
    }

    // Verify tenant exists and is active
    const { rows: tRows } = await db.query(
      'SELECT id, name, slug FROM tenants WHERE id = $1 AND active = true',
      [tenant_id]
    );
    if (tRows.length === 0) {
      return res.status(404).json({
        error: 'not_found', message: 'Tenant not found', status: 404,
      });
    }

    // Issue new tokens with new tenant context
    const user = { id: userId, email: req.user.email, role: req.user.role };
    const { accessToken, refreshToken } = await issueTokens(user, tenant_id);

    const tenants = await getUserTenants(userId);

    res.json({
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        tenant: tRows[0],
        tenants,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Switch tenant failed') || console.error('Switch tenant failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Switch tenant failed', status: 500 });
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
    // Find token — use rt.tenant_id (preserves selected tenant context)
    const { rows } = await db.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked,
              COALESCE(rt.tenant_id, u.tenant_id) AS tenant_id,
              u.email, u.role, u.active
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
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, tenant_id)
       VALUES ($1, $2, $3, $4)`,
      [row.user_id, newTokenHash, expiresAt, row.tenant_id]
    );

    // Fetch user's tenants for frontend
    const tenants = await getUserTenants(row.user_id);

    res.json({
      data: {
        access_token:  accessToken,
        refresh_token: newRefreshToken,
        tenants,
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
    // Fetch user info before revoking so audit middleware can log who logged out
    const tokenRow = await db.query(
      `SELECT rt.user_id, rt.tenant_id, u.email, u.role
       FROM refresh_tokens rt
       LEFT JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );
    if (tokenRow.rows.length) {
      const t = tokenRow.rows[0];
      req.user = { id: t.user_id, email: t.email, role: t.role, tenantId: t.tenant_id };
    }

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

// ── Password reset (public — user submits code + new password) ──────

const { timingSafeEqual } = require('crypto');

const resetPasswordSchema = z.object({
  email:        z.string().email(),
  reset_code:   z.string().length(16),
  new_password: z.string().min(8),
});

router.post('/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { email, reset_code, new_password } = parsed.data;

  try {
    const { rows } = await db.query(
      `SELECT id, password_reset_code, password_reset_expires
       FROM users WHERE email = $1 AND active = true`,
      [email]
    );

    if (!rows.length || !rows[0].password_reset_code) {
      return res.status(400).json({
        error: 'invalid_code', message: 'Invalid or expired reset code', status: 400,
      });
    }

    const user = rows[0];

    // Timing-safe comparison
    const codeBuf     = Buffer.from(user.password_reset_code, 'utf8');
    const providedBuf = Buffer.from(reset_code, 'utf8');
    if (codeBuf.length !== providedBuf.length || !timingSafeEqual(codeBuf, providedBuf)) {
      return res.status(400).json({
        error: 'invalid_code', message: 'Invalid or expired reset code', status: 400,
      });
    }

    // Check expiry
    if (new Date(user.password_reset_expires) < new Date()) {
      return res.status(400).json({
        error: 'code_expired', message: 'Reset code has expired', status: 400,
      });
    }

    // Hash new password, clear reset fields, revoke all refresh tokens
    const hash = await authSvc.hashPassword(new_password);
    await db.query(
      `UPDATE users SET password_hash = $1, password_reset_code = NULL, password_reset_expires = NULL
       WHERE id = $2`,
      [hash, user.id]
    );
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [user.id]);

    req.auditContext = { entityId: user.id, action: 'auth.password_reset' };

    res.json({ data: { message: 'Password has been reset' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Password reset failed') || console.error('Password reset failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Password reset failed', status: 500 });
  }
});

module.exports = router;
