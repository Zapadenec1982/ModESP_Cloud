'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const crypto     = require('crypto');
const db         = require('../services/db');
const authSvc    = require('../services/auth');
const emailSvc   = require('../services/email');
const { authenticate } = require('../middleware/auth');
const { passwordSchema } = require('../lib/password-policy');
const registrationSvc = require('../services/registration');
const sessionsSvc = require('../services/sessions');
const mfaSvc      = require('../services/mfa');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const selectTenantSchema = z.object({
  pending_token: z.string().min(1),
  tenant_id:     z.string().uuid(),
});

const switchTenantSchema = z.object({
  tenant_id: z.string().uuid(),
});

// ── Helpers ─────────────────────────────────────────────

/**
 * The role a session gets inside one organisation (plan epic 2.5): a
 * superadmin is a superadmin everywhere; everyone else carries the role of
 * their membership row (user_tenants.role), falling back to the account role
 * for a membership created before migration 036.
 */
async function roleFor(userId, tenantId) {
  const { rows } = await db.query(
    `SELECT u.role AS base_role, ut.role AS member_role
       FROM users u
       LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $2
      WHERE u.id = $1`,
    [userId, tenantId]
  );
  if (rows.length === 0) return null;
  const { base_role, member_role } = rows[0];
  if (base_role === 'superadmin') return 'superadmin';
  return member_role || base_role;
}

/**
 * Open a session for `user` in `tenantId` — or continue the session
 * `familyId` (token refresh, tenant switch). The refresh token goes to the
 * httpOnly cookie and the body through sessionsSvc.attach() (plan epic 2.9).
 */
async function issueTokens(user, tenantId, req, familyId = null) {
  const role = (await roleFor(user.id, tenantId)) || user.role;
  return sessionsSvc.issue({ user, role, tenantId, req, familyId });
}

/** The public shape of a signed-in user. */
function userPayload(user, role) {
  return { id: user.id, email: user.email, role, locale: user.locale || null, timezone: user.timezone || null };
}

// Organisations a session may run in: trial, active and past_due. A suspended
// or closed organisation is invisible at login, refused on switch-tenant and
// dropped at token refresh (plan epic 1.8).
const OPEN_STATUSES = ['trial', 'active', 'past_due'];
// A closed organisation stays open to sign in — read-only, until it is purged (plan epic 2.10)
const LOGIN_STATUSES = [...OPEN_STATUSES, 'closed'];

// The home organisation (users.tenant_id) counts as a membership even when no
// user_tenants row exists for it — accounts created by scripts before migration
// 010 or by seed-admin have none, and must not be locked out of their own
// organisation. The role there is the account role.
const MEMBER_TENANTS_SQL = `
  SELECT t.id, t.name, t.slug, t.status, t.plan, t.parent_tenant_id, t.trial_expires_at, t.closed_at, t.purged_at,
         COALESCE(ut.role, CASE WHEN u.role = 'superadmin' THEN 'admin' ELSE u.role END) AS role,
         COALESCE(p.features, '[]'::jsonb) AS features
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id OR t.id IN (SELECT m.tenant_id FROM user_tenants m WHERE m.user_id = u.id)
    LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = t.id
    LEFT JOIN plan_limits p ON p.plan = t.plan
   WHERE u.id = $1`;

/** A closed organisation says how long it stays readable (plan epic 2.10). */
function withReadOnlyUntil(row) {
  if (!row || !row.closed_at) return row;
  const days = require('../services/tenant-lifecycle').closedRetentionDays();
  return { ...row, read_only_until: days < 0 ? null : new Date(new Date(row.closed_at).getTime() + days * 86_400_000) };
}

async function getUserTenants(userId) {
  const { rows } = await db.query(
    `${MEMBER_TENANTS_SQL} AND t.status = ANY($2::text[]) ORDER BY t.name`,
    [userId, LOGIN_STATUSES]
  );
  return rows.map(withReadOnlyUntil);
}

/** Membership test used by select-tenant and switch-tenant: a row, or the home organisation. */
async function isMember(userId, tenantId) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2
     UNION SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [userId, tenantId]
  );
  return rows.length > 0;
}

/** One organisation as the session sees it (plan and features included, plan epic 2.5). */
async function tenantSummary(tenantId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.slug, t.status, t.plan, t.parent_tenant_id, t.trial_expires_at, COALESCE(p.features, '[]'::jsonb) AS features,
            t.closed_at, t.purged_at,
            CASE WHEN t.closed_at IS NULL OR $2 < 0 THEN NULL ELSE t.closed_at + make_interval(days => $2) END AS read_only_until
       FROM tenants t LEFT JOIN plan_limits p ON p.plan = t.plan WHERE t.id = $1`,
    [tenantId, require('../services/tenant-lifecycle').closedRetentionDays()]
  );
  return rows[0] || null;
}

function tenantSuspended(res) {
  return res.status(401).json({
    error: 'tenant_suspended',
    message: 'This organization is suspended. Contact your administrator or support.',
    status: 401,
  });
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
      `SELECT id, tenant_id, email, password_hash, role, active, locale, timezone, email_verified_at, mfa_enabled_at
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

    // A self-registered administrator proves the address first (plan epic 2.1)
    if (!user.email_verified_at) {
      return res.status(401).json({
        error: 'email_not_verified',
        message: 'Confirm your e-mail address with the link we sent you, then sign in',
        status: 401,
      });
    }

    // Second factor (plan epic 2.9): the password alone is not a login
    if (user.mfa_enabled_at) {
      return res.json({
        data: {
          require_mfa: true,
          mfa_token: authSvc.generateMfaToken({ id: user.id, email: user.email, role: user.role }),
          user: { id: user.id, email: user.email },
        },
      });
    }

    return await finishLogin(req, res, user);
  } catch (err) {
    req.log?.error?.({ err }, 'Login failed') || console.error('Login failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Login failed', status: 500 });
  }
});

/**
 * The tail of a login once every factor is in: pick the organisation (or ask
 * for one) and open the session. Shared by /login and /mfa/verify.
 */
async function finishLogin(req, res, user) {
  try {
    // Fetch available tenants from user_tenants
    const tenants = await getUserTenants(user.id);

    // Fallback: if user_tenants is empty (legacy), use users.tenant_id
    let suspendedOnly = false;
    if (tenants.length === 0 && user.tenant_id) {
      const { rows: tRows } = await db.query(
        'SELECT id, name, slug, status, closed_at, purged_at FROM tenants WHERE id = $1',
        [user.tenant_id]
      );
      if (tRows.length > 0) {
        if (LOGIN_STATUSES.includes(tRows[0].status)) tenants.push(withReadOnlyUntil(tRows[0]));
        else suspendedOnly = true;
      }
    } else if (tenants.length === 0) {
      const { rows: any } = await db.query(
        `SELECT 1 FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id WHERE ut.user_id = $1 LIMIT 1`, [user.id]);
      suspendedOnly = any.length > 0;
    }

    if (tenants.length === 0) {
      // A registration a superadmin has not approved yet is suspended, but the
      // message is a different one (plan epic 2.1)
      if (suspendedOnly && user.tenant_id) {
        const { rows: home } = await db.query('SELECT registered_at, approved_at FROM tenants WHERE id = $1', [user.tenant_id]);
        if (registrationSvc.awaitingApproval(home[0])) {
          return res.status(401).json({
            error: 'pending_approval',
            message: 'Your organisation is awaiting approval. We will e-mail you as soon as it is ready.',
            status: 401,
          });
        }
      }
      if (suspendedOnly) return tenantSuspended(res);
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
      const session = await issueTokens(user, loginTenant.id, req);
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

      return res.json({
        data: sessionsSvc.attach(res, session, {
          access_token: session.accessToken,
          // role = the role inside loginTenant (user_tenants.role), not the account role
          user: userPayload(user, session.role),
          tenant: loginTenant,
          tenants,
        }),
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
        user: userPayload(user, user.role),
        tenants,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Login failed') || console.error('Login failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Login failed', status: 500 });
  }
}

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
      'SELECT id, email, role, active, locale, timezone FROM users WHERE id = $1',
      [payload.sub]
    );
    if (uRows.length === 0 || !uRows[0].active) {
      return res.status(401).json({
        error: 'account_disabled', message: 'Account not found or disabled', status: 401,
      });
    }
    const user = uRows[0];

    // Verify membership
    if (!await isMember(user.id, tenant_id)) {
      return res.status(403).json({
        error: 'forbidden', message: 'Not a member of this tenant', status: 403,
      });
    }

    const session = await issueTokens(user, tenant_id, req);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const tenant  = await tenantSummary(tenant_id);
    const tenants = await getUserTenants(user.id);

    res.json({
      data: sessionsSvc.attach(res, session, {
        access_token: session.accessToken,
        user: userPayload(user, session.role),
        tenant,
        tenants,
      }),
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
    if (!isSuperAdmin && !await isMember(userId, tenant_id)) {
      return res.status(403).json({
        error: 'forbidden', message: 'Not a member of this tenant', status: 403,
      });
    }

    // Verify tenant exists and is open for sessions
    const tenant = await tenantSummary(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        error: 'not_found', message: 'Tenant not found', status: 404,
      });
    }
    if (!LOGIN_STATUSES.includes(tenant.status)) return tenantSuspended(res);

    // Issue new tokens with new tenant context — and the role held THERE (plan
    // epic 2.5) — inside the same session (plan epic 2.9)
    const user = { id: userId, email: req.user.email, role: req.user.role };
    const session = await issueTokens(user, tenant_id, req, req.user.sid || null);

    const tenants = await getUserTenants(userId);

    res.json({
      data: sessionsSvc.attach(res, session, {
        access_token: session.accessToken,
        role: session.role,
        tenant,
        tenants,
      }),
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Switch tenant failed') || console.error('Switch tenant failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Switch tenant failed', status: 500 });
  }
});

// ── POST /auth/refresh ──────────────────────────────────

//
// The refresh token comes in the body (API clients) or in the httpOnly cookie
// with the X-CSRF-Token header (the WebUI), see services/sessions.js. Each
// token is single-use: a token seen twice closes its whole session.

function tokenFrom(req, res) {
  try {
    return sessionsSvc.presentedToken(req);
  } catch (err) {
    res.status(403).json({ error: 'csrf_required', message: 'Missing or invalid CSRF token', status: 403 });
    return null;
  }
}

router.post('/refresh', async (req, res) => {
  const presented = tokenFrom(req, res);
  if (!presented) return;
  if (!presented.token) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'refresh_token is required',
      status: 400,
    });
  }

  try {
    let row;
    try {
      row = await sessionsSvc.lookup(presented.token);
    } catch (err) {
      if (err.code === 'token_reused') {
        sessionsSvc.detach(res);
        return res.status(401).json({ error: 'token_reused', message: err.message, status: 401 });
      }
      if (err.code === 'token_expired') {
        return res.status(401).json({ error: 'token_expired', message: 'Refresh token expired or revoked', status: 401 });
      }
      return res.status(401).json({ error: 'invalid_token', message: 'Invalid refresh token', status: 401 });
    }

    // A suspended organisation ends the session at the next refresh (≤ 15 min).
    if (row.role !== 'superadmin' && row.tenant_status && !LOGIN_STATUSES.includes(row.tenant_status)) {
      return tenantSuspended(res);
    }

    if (!row.active) {
      return res.status(401).json({
        error: 'account_disabled',
        message: 'Account is disabled',
        status: 401,
      });
    }

    // Rotation: retire the presented token, issue the next one in the same session
    await sessionsSvc.retire(row);
    const user = { id: row.user_id, email: row.email, role: row.role, locale: row.locale, timezone: row.timezone };
    const session = await issueTokens(user, row.tenant_id, req, row.family_id);

    // Fetch user's tenants for frontend
    const tenants = await getUserTenants(row.user_id);

    res.json({
      data: sessionsSvc.attach(res, session, {
        access_token: session.accessToken,
        role: session.role,
        tenants,
      }),
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Refresh failed') || console.error('Refresh failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Token refresh failed', status: 500 });
  }
});

// ── POST /auth/logout ───────────────────────────────────

// Ends the whole session the token belongs to (every rotation of it), and
// clears the cookie. Accepts the token from the body or from the cookie.
router.post('/logout', async (req, res) => {
  const presented = tokenFrom(req, res);
  if (!presented) return;
  if (!presented.token) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'refresh_token is required',
      status: 400,
    });
  }

  try {
    // Fetch user info before revoking so audit middleware can log who logged out
    const tokenRow = await db.query(
      `SELECT rt.user_id, rt.tenant_id, u.email, u.role
       FROM refresh_tokens rt
       LEFT JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [authSvc.hashRefreshToken(presented.token)]
    );
    if (tokenRow.rows.length) {
      const t = tokenRow.rows[0];
      req.user = { id: t.user_id, email: t.email, role: t.role, tenantId: t.tenant_id };
    }

    await sessionsSvc.revokeByToken(presented.token);
    sessionsSvc.detach(res);
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
  new_password: passwordSchema,
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

// ── POST /auth/forgot-password (public) ──────────────────
//
// Self-service half of the reset flow. The response is identical whether or
// not the address exists; the code is the same 16-hex value the admin flow
// generates, so POST /auth/reset-password serves both. Without an email
// channel the request is logged and the admin code path remains the fallback.

function appBaseUrl() {
  return (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/+$/, '');
}

const forgotPasswordSchema = z.object({
  email: z.string().email().max(256),
  lang:  z.enum(['uk', 'en', 'pl', 'de']).optional(),
});

router.post('/forgot-password', async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const generic = { data: { message: 'If an account with that email exists, a reset link has been sent' } };

  try {
    const { rows } = await db.query(
      'SELECT id, email FROM users WHERE lower(email) = $1 AND active = true LIMIT 1', [email]);
    if (rows.length === 0) return res.json(generic);

    const user    = rows[0];
    const code    = crypto.randomBytes(8).toString('hex');   // 16 hex chars, as the admin flow
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    await db.query(
      'UPDATE users SET password_reset_code = $1, password_reset_expires = $2 WHERE id = $3',
      [code, expires, user.id]
    );

    const link = `${appBaseUrl()}/#/reset?email=${encodeURIComponent(user.email)}&code=${code}`;
    let sent = false;
    try {
      sent = await emailSvc.sendPasswordReset({ to: user.email, link, code, lang: parsed.data.lang, expiresMinutes: 30 });
    } catch (err) {
      req.log?.error?.({ err, userId: user.id }, 'Password reset email failed');
    }
    if (!sent) {
      req.log?.warn?.({ userId: user.id }, 'Password reset requested but no email channel is configured — admin reset code path remains');
    }
    req.auditContext = { entityId: user.id, action: 'auth.password_reset_request', changes: { email_sent: sent } };
    res.json(generic);
  } catch (err) {
    req.log?.error?.({ err }, 'Forgot password failed');
    res.status(500).json({ error: 'internal_error', message: 'Password reset request failed', status: 500 });
  }
});

// ── Invitations (public) ─────────────────────────────────

async function loadInvitation(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(
    `SELECT i.*, t.name AS tenant_name, t.slug AS tenant_slug, t.active AS tenant_active
       FROM invitations i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1`,
    [hash]
  );
  return rows[0] || null;
}

function invitationState(inv) {
  if (!inv) return 'not_found';
  if (inv.accepted_at) return 'accepted';
  if (inv.revoked_at) return 'revoked';
  if (new Date(inv.expires_at) < new Date()) return 'expired';
  if (!inv.tenant_active) return 'tenant_inactive';
  return 'open';
}

const INVITE_STATE_MESSAGE = {
  not_found:       'Invitation not found',
  accepted:        'This invitation has already been used',
  revoked:         'This invitation was revoked',
  expired:         'This invitation has expired — ask your administrator for a new one',
  tenant_inactive: 'This organization is not active',
};

function rejectInvitation(res, state) {
  const status = state === 'not_found' ? 404 : 410;
  return res.status(status).json({ error: `invitation_${state}`, message: INVITE_STATE_MESSAGE[state], status });
}

// GET /auth/invite/:token — what the invitee is about to accept
router.get('/invite/:token', async (req, res) => {
  try {
    const inv = await loadInvitation(req.params.token);
    const state = invitationState(inv);
    if (state !== 'open') return rejectInvitation(res, state);

    const { rows } = await db.query('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [inv.email.toLowerCase()]);
    res.json({
      data: {
        email:         inv.email,
        role:          inv.role,
        tenant:        { name: inv.tenant_name, slug: inv.tenant_slug },
        existing_user: rows.length > 0,
        expires_at:    inv.expires_at,
      },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Load invitation failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to load invitation', status: 500 });
  }
});

const acceptInviteSchema = z.object({
  password:     z.string().min(1).max(256),
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'The terms of service must be accepted' }) }),
});

// POST /auth/invite/:token/accept — set a password (new account) or prove the
// existing one (account joining another organisation); logs the user in.
router.post('/invite/:token/accept', async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const { password } = parsed.data;

  try {
    const inv = await loadInvitation(req.params.token);
    const state = invitationState(inv);
    if (state !== 'open') return rejectInvitation(res, state);
    const email = inv.email.toLowerCase();

    const outcome = await db.transaction(async (client) => {
      const { rows: locked } = await client.query(
        'SELECT accepted_at, revoked_at FROM invitations WHERE id = $1 FOR UPDATE', [inv.id]);
      if (locked[0].accepted_at || locked[0].revoked_at) return { error: 'gone' };

      const { rows: uRows } = await client.query(
        'SELECT id, email, role, password_hash, active, tenant_id FROM users WHERE lower(email) = $1 LIMIT 1', [email]);

      let user;
      let created = false;
      if (uRows.length) {
        user = uRows[0];
        if (!user.active) return { error: 'account_disabled' };
        const ok = await authSvc.comparePassword(password, user.password_hash);
        if (!ok) return { error: 'invalid_password' };
        // The role is per membership (plan epic 2.5): an existing account joins
        // this organisation with the role it was invited for.
        await client.query(
          `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
          [user.id, inv.tenant_id, inv.role]);
        // The link went to this very address: it is verified from here on (plan epic 2.1)
        await client.query(
          `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), email_verify_hash = NULL,
                            email_verify_expires = NULL, terms_accepted_at = now() WHERE id = $1`, [user.id]);
      } else {
        const pw = passwordSchema.safeParse(password);
        if (!pw.success) return { error: 'weak_password', message: pw.error.issues[0].message };
        const hash = await authSvc.hashPassword(password);
        const { rows } = await client.query(
          `INSERT INTO users (tenant_id, email, password_hash, role, email_verified_at, terms_accepted_at)
           VALUES ($1, $2, $3, $4, now(), now()) RETURNING id, email, role, tenant_id`,
          [inv.tenant_id, inv.email, hash, inv.role]);
        user = rows[0];
        created = true;
        await client.query(
          'INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [user.id, inv.tenant_id, inv.role]);
      }
      await client.query(
        'UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [inv.id, user.id]);
      return { user, created };
    });

    if (outcome.error === 'gone')             return rejectInvitation(res, 'accepted');
    if (outcome.error === 'account_disabled') return res.status(401).json({ error: 'account_disabled', message: 'Account is disabled', status: 401 });
    if (outcome.error === 'invalid_password') return res.status(401).json({ error: 'invalid_credentials', message: 'Password of the existing account is incorrect', status: 401 });
    if (outcome.error === 'weak_password')    return res.status(400).json({ error: 'validation_failed', message: outcome.message, status: 400 });

    const { user, created } = outcome;
    const session = await issueTokens(user, inv.tenant_id, req);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const tenants = await getUserTenants(user.id);

    req.auditContext = {
      entityId: user.id, action: 'auth.invite_accept',
      changes: { invitation_id: inv.id, tenant_id: inv.tenant_id, created },
    };
    res.status(created ? 201 : 200).json({
      data: sessionsSvc.attach(res, session, {
        access_token: session.accessToken,
        user:    { id: user.id, email: user.email, role: user.role },
        tenant:  { id: inv.tenant_id, name: inv.tenant_name, slug: inv.tenant_slug },
        tenants,
        created,
      }),
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Accept invitation failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to accept invitation', status: 500 });
  }
});

// ── Self-registration (public, plan epic 2.1) ────────────
//
// Organisation + first administrator on the free plan with a 14-day trial.
// REGISTRATION_MODE decides whether the endpoint is open at all and whether a
// superadmin approves each registration; with an e-mail channel the address
// is verified before the first login (services/registration.js).

/** What the registration page needs before it renders. */
router.get('/registration', (_req, res) => {
  res.json({
    data: {
      mode:               registrationSvc.mode(),
      email_verification: registrationSvc.verificationRequired(),
      trial_days:         registrationSvc.trialDays(),
    },
  });
});

const registerSchema = z.object({
  organisation: z.string().trim().min(2, 'Organisation name must be at least 2 characters').max(128),
  email:        z.string().trim().email().max(256),
  password:     passwordSchema,
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'The terms of service must be accepted' }) }),
  lang:         z.enum(['uk', 'en', 'pl', 'de']).optional(),
  website:      z.string().max(200).optional(),   // honeypot: people never see it, bots fill it
});

function sessionPayload(res, session, user, tenant, tenants) {
  return sessionsSvc.attach(res, session, {
    access_token: session.accessToken,
    user: userPayload(user, session.role),
    tenant,
    tenants,
  });
}

router.post('/register', async (req, res) => {
  if (registrationSvc.mode() === 'off') {
    return res.status(403).json({ error: 'registration_closed', message: 'Self-registration is not open on this server', status: 403 });
  }
  const parsed = registerSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const { organisation, email, password, lang, website } = parsed.data;
  // A filled honeypot answers as if it worked and creates nothing.
  if (website && website.trim()) return res.status(201).json({ data: { received: true } });

  try {
    const result = await registrationSvc.register({ organisation, email, password, lang, ip: req.ip || null, log: req.log });
    const { tenant, user, verificationRequired, approvalRequired, emailSent } = result;
    req.auditContext = {
      entityId: tenant.id, action: 'auth.register',
      changes: { tenant_id: tenant.id, slug: tenant.slug, email: user.email, mode: registrationSvc.mode(), email_sent: emailSent },
    };

    const data = {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, trial_expires_at: tenant.trial_expires_at },
      verification_required: verificationRequired,
      approval_required:     approvalRequired,
      email_sent:            emailSent,
    };
    // Nothing left to wait for: sign in right away, as invitation acceptance does.
    if (!verificationRequired && !approvalRequired) {
      const session = await issueTokens(user, tenant.id, req);
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
      Object.assign(data, sessionPayload(res, session, user, await tenantSummary(tenant.id), await getUserTenants(user.id)));
    }
    res.status(201).json({ data });
  } catch (err) {
    if (err.code === 'email_taken') {
      return res.status(409).json({ error: 'email_taken', message: 'An account with this e-mail already exists — sign in or reset the password', status: 409 });
    }
    req.log?.error?.({ err }, 'Registration failed');
    res.status(500).json({ error: 'internal_error', message: 'Registration failed', status: 500 });
  }
});

const verifyEmailSchema = z.object({
  email: z.string().trim().email().max(256),
  code:  z.string().regex(/^[0-9a-f]{64}$/, 'Invalid verification code'),
});

// The link from the verification e-mail lands here (#/verify?email=…&code=…).
// A verified administrator whose organisation is already open is signed in.
router.post('/verify-email', async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const { user, alreadyVerified } = await registrationSvc.verifyEmail(parsed.data);
    req.auditContext = { entityId: user.id, action: 'auth.verify_email', changes: { already_verified: alreadyVerified } };

    const tenant = await tenantSummary(user.tenant_id);
    const { rows: home } = await db.query('SELECT registered_at, approved_at FROM tenants WHERE id = $1', [user.tenant_id]);
    const approvalRequired = registrationSvc.awaitingApproval(home[0]);
    const data = { verified: true, approval_required: approvalRequired };
    if (!approvalRequired && tenant && OPEN_STATUSES.includes(tenant.status)) {
      const session = await issueTokens(user, tenant.id, req);
      await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
      Object.assign(data, sessionPayload(res, session, user, tenant, await getUserTenants(user.id)));
    }
    res.json({ data });
  } catch (err) {
    if (err.code === 'invalid_code' || err.code === 'code_expired') {
      return res.status(400).json({ error: err.code, message: err.message, status: 400 });
    }
    req.log?.error?.({ err }, 'E-mail verification failed');
    res.status(500).json({ error: 'internal_error', message: 'Verification failed', status: 500 });
  }
});

const resendSchema = z.object({
  email: z.string().trim().email().max(256),
  lang:  z.enum(['uk', 'en', 'pl', 'de']).optional(),
});

// Same answer whether or not the address exists or is already verified.
router.post('/resend-verification', async (req, res) => {
  const parsed = resendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const sent = await registrationSvc.resendVerification({ ...parsed.data, log: req.log });
    req.auditContext = { action: 'auth.resend_verification', changes: { email_sent: sent } };
    res.json({ data: { message: 'If that address is waiting for verification, a new link has been sent' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Resend verification failed');
    res.status(500).json({ error: 'internal_error', message: 'Request failed', status: 500 });
  }
});

// ── Second factor (plan epic 2.9) ────────────────────────
//
// /mfa/verify is the second half of a login (public, rate-limited, keyed by
// the five-minute mfa_token); the rest manages the authenticator of the
// signed-in account.

const mfaVerifySchema = z.object({
  mfa_token: z.string().min(1),
  code:      z.string().trim().min(6).max(16),
});

router.post('/mfa/verify', async (req, res) => {
  const parsed = mfaVerifySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    let payload;
    try {
      payload = authSvc.verifyMfaToken(parsed.data.mfa_token);
    } catch {
      return res.status(401).json({ error: 'invalid_token', message: 'Sign in again — the code window has closed', status: 401 });
    }
    const { rows } = await db.query(
      `SELECT id, tenant_id, email, role, active, locale, timezone, mfa_enabled_at FROM users WHERE id = $1`, [payload.sub]);
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: 'account_disabled', message: 'Account not found or disabled', status: 401 });
    }
    const check = await mfaSvc.verify(user.id, parsed.data.code);
    if (!check.ok) {
      req.auditContext = { entityId: user.id, action: 'auth.mfa_failed' };
      return res.status(401).json({ error: 'invalid_mfa_code', message: 'The code is wrong or was already used', status: 401 });
    }
    req.auditContext = { entityId: user.id, action: 'auth.mfa_verify', changes: { method: check.method } };
    return await finishLogin(req, res, user);
  } catch (err) {
    req.log?.error?.({ err }, 'MFA verify failed');
    res.status(500).json({ error: 'internal_error', message: 'Verification failed', status: 500 });
  }
});

router.get('/mfa', authenticate, async (req, res) => {
  try {
    const s = await mfaSvc.status(req.user.id);
    if (!s) return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    res.json({ data: s });
  } catch (err) {
    req.log?.error?.({ err }, 'MFA status failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to read MFA status', status: 500 });
  }
});

router.post('/mfa/setup', authenticate, async (req, res) => {
  try {
    const s = await mfaSvc.status(req.user.id);
    if (s && s.enabled) {
      return res.status(409).json({ error: 'mfa_enabled', message: 'MFA is already enabled — disable it first', status: 409 });
    }
    const data = await mfaSvc.setup(req.user.id, req.user.email);
    req.auditContext = { entityId: req.user.id, action: 'auth.mfa_setup' };
    res.json({ data });
  } catch (err) {
    req.log?.error?.({ err }, 'MFA setup failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to start MFA setup', status: 500 });
  }
});

const mfaCodeSchema = z.object({ code: z.string().trim().min(6).max(16) });

// The first code from the app: the secret becomes live, the backup codes are
// shown once, and every other session of the account is signed out — they
// never passed the second factor.
router.post('/mfa/enable', authenticate, async (req, res) => {
  const parsed = mfaCodeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const codes = await mfaSvc.enable(req.user.id, parsed.data.code);
    if (!codes) return res.status(400).json({ error: 'invalid_mfa_code', message: 'The code does not match — check the time on the phone and try the next one', status: 400 });
    const closed = await sessionsSvc.revokeAll(req.user.id, req.user.sid || null);
    req.auditContext = { entityId: req.user.id, action: 'auth.mfa_enable', changes: { sessions_closed: closed } };
    res.json({ data: { enabled: true, backup_codes: codes, sessions_closed: closed } });
  } catch (err) {
    if (err.code === 'no_setup') return res.status(409).json({ error: 'no_setup', message: 'Start the setup first', status: 409 });
    req.log?.error?.({ err }, 'MFA enable failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to enable MFA', status: 500 });
  }
});

const mfaDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code:     z.string().trim().min(6).max(16),
});

// Password and a current code (or a backup code): both, so neither a stolen
// session nor a stolen phone alone can switch the factor off.
router.post('/mfa/disable', authenticate, async (req, res) => {
  const parsed = mfaDisableSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const { rows } = await db.query('SELECT password_hash, mfa_enabled_at FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0] || !rows[0].mfa_enabled_at) {
      return res.status(409).json({ error: 'mfa_not_enabled', message: 'MFA is not enabled', status: 409 });
    }
    if (!await authSvc.comparePassword(parsed.data.password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Password is incorrect', status: 401 });
    }
    const check = await mfaSvc.verify(req.user.id, parsed.data.code);
    if (!check.ok) return res.status(401).json({ error: 'invalid_mfa_code', message: 'The code is wrong or was already used', status: 401 });
    await mfaSvc.disable(req.user.id);
    req.auditContext = { entityId: req.user.id, action: 'auth.mfa_disable' };
    res.json({ data: { enabled: false } });
  } catch (err) {
    req.log?.error?.({ err }, 'MFA disable failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to disable MFA', status: 500 });
  }
});

router.post('/mfa/backup-codes', authenticate, async (req, res) => {
  const parsed = mfaCodeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    const check = await mfaSvc.verify(req.user.id, parsed.data.code);
    if (!check.ok) return res.status(401).json({ error: 'invalid_mfa_code', message: 'The code is wrong or was already used', status: 401 });
    const codes = await mfaSvc.regenerateBackupCodes(req.user.id);
    req.auditContext = { entityId: req.user.id, action: 'auth.mfa_backup_codes' };
    res.json({ data: { backup_codes: codes } });
  } catch (err) {
    req.log?.error?.({ err }, 'MFA backup codes failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to regenerate backup codes', status: 500 });
  }
});

// ── Sessions (plan epic 2.9) ─────────────────────────────

router.get('/sessions', authenticate, async (req, res) => {
  try {
    res.json({ data: await sessionsSvc.list(req.user.id, req.user.sid || null) });
  } catch (err) {
    req.log?.error?.({ err }, 'List sessions failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list sessions', status: 500 });
  }
});

// Sign out everywhere else: every session but the one making the call.
router.delete('/sessions', authenticate, async (req, res) => {
  try {
    const closed = await sessionsSvc.revokeAll(req.user.id, req.user.sid || null);
    req.auditContext = { entityId: req.user.id, action: 'auth.sessions_revoke_all', changes: { sessions_closed: closed } };
    res.json({ data: { revoked: closed } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke sessions failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke sessions', status: 500 });
  }
});

router.delete('/sessions/:id', authenticate, async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid session id', status: 400 });
  }
  try {
    const n = await sessionsSvc.revokeFamily(req.user.id, req.params.id);
    if (!n) return res.status(404).json({ error: 'not_found', message: 'Session not found', status: 404 });
    const current = req.params.id === req.user.sid;
    if (current) sessionsSvc.detach(res);
    req.auditContext = { entityId: req.user.id, action: 'auth.session_revoke', changes: { session_id: req.params.id, current } };
    res.json({ data: { revoked: true, current } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke session failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke session', status: 500 });
  }
});

module.exports = router;
module.exports.roleFor = roleFor;
module.exports.getUserTenants = getUserTenants;
