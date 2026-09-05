'use strict';

const { Router }  = require('express');
const { z }       = require('zod');
const crypto      = require('crypto');
const db          = require('../services/db');
const authSvc     = require('../services/auth');
const emailSvc    = require('../services/email');
const { isUuidFormat } = require('../lib/ids');
const { passwordSchema } = require('../lib/password-policy');
const planMw = require('../middleware/plan');

const router = Router();

// ── Validation schemas ──────────────────────────────────

const createUserSchema = z.object({
  email:     z.string().email(),
  password:  passwordSchema,
  role:      z.enum(['admin', 'technician', 'viewer']).default('viewer'),
  tenant_id: z.string().uuid().optional(),   // superadmin only — create in another tenant
});

// A half-set home base is worse than none: "nearest technician" would place the
// user on the prime meridian. The pair must be written or cleared together.
// (routes/profile.js repeats this rule for the self-service half of §7.4.)
const baseLocationPaired = (d) => {
  const hasLat = d.base_latitude  !== undefined;
  const hasLon = d.base_longitude !== undefined;
  if (hasLat !== hasLon) return false;
  if (hasLat && hasLon) return (d.base_latitude === null) === (d.base_longitude === null);
  return true;
};
const BASE_LOCATION_PAIR_MSG =
  'base_latitude and base_longitude must be provided (or cleared) together';

const updateUserSchema = z.object({
  email:     z.string().email().optional(),
  role:      z.enum(['admin', 'technician', 'viewer']).optional(),
  active:    z.boolean().optional(),
  tenant_id: z.string().uuid().optional(),   // superadmin only — reassign to another tenant
  // Technician home base (§7.4) — an admin may set it for any user in the tenant;
  // the user's own self-service editing lives in routes/profile.js.
  base_latitude:  z.number().min(-90).max(90).nullable().optional(),
  base_longitude: z.number().min(-180).max(180).nullable().optional(),
  base_address:   z.string().max(256).nullable().optional(),
}).refine(baseLocationPaired, { message: BASE_LOCATION_PAIR_MSG });

const deviceAccessSchema = z.object({
  device_id: z.string().uuid(),
});

const siteAccessSchema = z.object({
  site_id: z.string().uuid(),
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
                u.tenant_id, u.telegram_id,
                u.base_latitude, u.base_longitude, u.base_address,
                t.name AS tenant_name, t.slug AS tenant_slug
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         ORDER BY t.name, u.created_at DESC`
      ));
      // Attach tenant memberships array to each user
      const { rows: memberships } = await db.query(
        `SELECT ut.user_id, ut.role, t.id AS tenant_id, t.name, t.slug
           FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
           ORDER BY t.name`
      );
      const memMap = {};
      for (const m of memberships) {
        if (!memMap[m.user_id]) memMap[m.user_id] = [];
        memMap[m.user_id].push({ id: m.tenant_id, name: m.name, slug: m.slug, role: m.role });
      }
      for (const u of rows) {
        u.tenants = memMap[u.id] || [{ id: u.tenant_id, name: u.tenant_name, slug: u.tenant_slug }];
      }
    } else {
      // Members of this organisation with the role they hold HERE
      // (user_tenants.role, plan epic 2.5): a partner's technician appears in a
      // client organisation as a technician even though they are an admin at home.
      ({ rows } = await db.query(
        `SELECT u.id, u.email, COALESCE(ut.role, u.role) AS role, u.role AS home_role,
                (u.tenant_id = $1) AS is_home, u.active, u.created_at, u.last_login, u.telegram_id,
                u.base_latitude, u.base_longitude, u.base_address
           FROM user_tenants ut
           JOIN users u ON u.id = ut.user_id
          WHERE ut.tenant_id = $1 AND u.role <> 'superadmin'
          ORDER BY u.created_at DESC`,
        [req.tenantId]
      ));
    }
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List users failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list users', status: 500 });
  }
});

// The former /users/me, /users/me/telegram-link and /users/me/push-subscription
// routes live in routes/profile.js (mounted at /api/profile for every role).

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
    const cap = await planMw.checkCapacity(targetTenantId, 'users');
    if (!cap.ok) return planMw.planLimitResponse(res, cap);

    const hash = await authSvc.hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, active, created_at`,
      [targetTenantId, email, hash, role]
    );
    // Also add to user_tenants junction table, with the role held there
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rows[0].id, targetTenantId, role]
    );

    // Audit: who was created
    req.auditContext = { entityId: rows[0].id, changes: { after: { email, role } } };

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

// ── Invitations (plan epic 1.5) ──────────────────────────
//
// POST /users/invite creates a one-time link; the invitee sets a password on
// #/invite/<token> (routes/auth.js) and is logged straight in. When the email
// already belongs to an account, acceptance links that account to this
// organisation instead of creating a second one. The link is always returned to
// the admin as well, so onboarding works before Resend is configured.

const INVITE_TTL_HOURS = 72;

const inviteSchema = z.object({
  email:     z.string().email().max(256),
  role:      z.enum(['admin', 'technician', 'viewer']).default('viewer'),
  tenant_id: z.string().uuid().optional(),   // superadmin only
  lang:      z.enum(['uk', 'en', 'pl', 'de']).optional(),
});

function appBaseUrl() {
  return (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/+$/, '');
}

router.post('/invite', async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const { role, tenant_id, lang } = parsed.data;
  const isSuperAdmin = req.user.role === 'superadmin';
  const targetTenantId = (isSuperAdmin && tenant_id) ? tenant_id : req.tenantId;

  try {
    const { rows: tRows } = await db.query('SELECT id, name, slug, active FROM tenants WHERE id = $1', [targetTenantId]);
    if (tRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    }
    const tenant = tRows[0];

    const { rows: uRows } = await db.query('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    const existing = uRows[0] || null;
    if (existing) {
      const { rows: member } = await db.query(
        'SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [existing.id, targetTenantId]);
      if (member.length) {
        return res.status(409).json({ error: 'conflict', message: 'User is already a member of this organization', status: 409 });
      }
    } else {
      // A new account will count against max_users of the organisation
      const cap = await planMw.checkCapacity(targetTenantId, 'users');
      if (!cap.ok) return planMw.planLimitResponse(res, cap);
    }

    // One open invitation per email and organisation: a re-invite supersedes the old link.
    await db.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [targetTenantId, email]
    );

    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);
    const { rows } = await db.query(
      `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, role, created_at, expires_at`,
      [targetTenantId, email, role, tokenHash, req.user.id, expiresAt]
    );
    const inviteUrl = `${appBaseUrl()}/#/invite/${token}`;

    let emailSent = false;
    try {
      emailSent = await emailSvc.sendInvitation({
        to: email, link: inviteUrl, tenantName: tenant.name, role,
        invitedBy: req.user.email, lang, expiresHours: INVITE_TTL_HOURS,
      });
    } catch (err) {
      req.log?.error?.({ err, email }, 'Invitation email failed — link returned to the admin instead');
    }

    req.auditContext = {
      entityId: rows[0].id, action: 'user.invite',
      changes: { email, role, tenant_id: targetTenantId, existing_user: !!existing, email_sent: emailSent },
    };
    res.status(201).json({
      data: { ...rows[0], tenant_id: targetTenantId, existing_user: !!existing, invite_url: inviteUrl, email_sent: emailSent },
    });
  } catch (err) {
    req.log?.error?.({ err }, 'Invite failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to create invitation', status: 500 });
  }
});

// GET /users/invitations — open invitations (admin: own tenant; superadmin: all or ?tenant_id=)
router.get('/invitations', async (req, res) => {
  const isSuperAdmin = req.user.role === 'superadmin';
  const filterTenant = isSuperAdmin ? (req.query.tenant_id || null) : req.tenantId;
  if (filterTenant && !isUuidFormat(filterTenant)) {
    return res.status(400).json({ error: 'validation_failed', message: 'tenant_id must be a UUID', status: 400 });
  }
  try {
    const params = [];
    let where = 'i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()';
    if (filterTenant) { params.push(filterTenant); where += ` AND i.tenant_id = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT i.id, i.tenant_id, t.name AS tenant_name, i.email, i.role, i.created_at, i.expires_at,
              u.email AS invited_by_email
         FROM invitations i
         JOIN tenants t ON t.id = i.tenant_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE ${where}
        ORDER BY i.created_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List invitations failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list invitations', status: 500 });
  }
});

// DELETE /users/invitations/:id — revoke an open invitation
router.delete('/invitations/:id', async (req, res) => {
  if (!isUuidFormat(req.params.id)) {
    return res.status(404).json({ error: 'not_found', message: 'Invitation not found', status: 404 });
  }
  const isSuperAdmin = req.user.role === 'superadmin';
  try {
    const params = [req.params.id];
    let scope = '';
    if (!isSuperAdmin) { params.push(req.tenantId); scope = ' AND tenant_id = $2'; }
    const { rows } = await db.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL${scope}
        RETURNING id, email`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Invitation not found', status: 404 });
    }
    req.auditContext = { entityId: rows[0].id, action: 'user.invite_revoke', changes: { email: rows[0].email } };
    res.json({ data: { message: 'Invitation revoked' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke invitation failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke invitation', status: 500 });
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
    // An admin may edit anyone who is a MEMBER of their organisation (plan epic
    // 2.5): a partner's technician placed in a client organisation is edited by
    // that client's admin only as far as the membership role goes (see below).
    const targetQ = isSuperAdmin
      ? 'SELECT u.id, u.email, u.role, u.tenant_id FROM users u WHERE u.id = $1'
      : `SELECT u.id, u.email, u.role, u.tenant_id
           FROM users u JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $2
          WHERE u.id = $1`;
    const targetParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows: targetRows } = await db.query(targetQ, targetParams);

    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    const targetUser = targetRows[0];
    const beforeState = { email: targetUser.email, role: targetUser.role };

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

    // The organisation this edit is about: the admin's own, or (superadmin)
    // the user's home organisation unless tenant_id moves them.
    const scopeTenantId = isSuperAdmin ? (data.tenant_id || targetUser.tenant_id) : req.tenantId;
    const isHome = targetUser.tenant_id === scopeTenantId;
    // A membership-only user (home elsewhere, e.g. partner staff) can have only
    // their role in THIS organisation changed by its admin — not email, password
    // or active, which belong to the home organisation.
    if (!isSuperAdmin && !isHome) {
      const foreign = Object.keys(data).filter(k => k !== 'role');
      if (foreign.length) {
        return res.status(403).json({
          error: 'forbidden', message: 'This user belongs to another organisation; only their role here can be changed', status: 403,
        });
      }
    }

    if (data.role !== undefined) {
      await db.query(
        'UPDATE user_tenants SET role = $1 WHERE user_id = $2 AND tenant_id = $3',
        [data.role, req.params.id, scopeTenantId]
      );
      if (!isHome) {
        req.auditContext = { entityId: req.params.id, changes: { before: beforeState, after: { email: targetUser.email, role: data.role }, tenant_id: scopeTenantId } };
        return res.json({ data: { id: targetUser.id, email: targetUser.email, role: data.role, active: true, is_home: false } });
      }
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (data.email !== undefined)     { sets.push(`email = $${idx++}`);     params.push(data.email); }
    if (data.role  !== undefined)     { sets.push(`role = $${idx++}`);      params.push(data.role);  }
    if (data.active !== undefined)    { sets.push(`active = $${idx++}`);    params.push(data.active); }
    if (data.tenant_id !== undefined) { sets.push(`tenant_id = $${idx++}`); params.push(data.tenant_id); }
    // Technician home base (§7.4) — set by an admin from the Users page
    if (data.base_latitude !== undefined)  { sets.push(`base_latitude = $${idx++}`);  params.push(data.base_latitude); }
    if (data.base_longitude !== undefined) { sets.push(`base_longitude = $${idx++}`); params.push(data.base_longitude); }
    if (data.base_address !== undefined)   { sets.push(`base_address = $${idx++}`);   params.push(data.base_address); }

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
       RETURNING id, email, role, active, base_latitude, base_longitude, base_address`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Audit: before/after
    const afterState = { email: rows[0].email, role: rows[0].role };
    req.auditContext = { entityId: req.params.id, changes: { before: beforeState, after: afterState } };

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

// ── DELETE /users/:id — hard delete (admin / superadmin) ──

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
      ? 'SELECT email, role FROM users WHERE id = $1'
      : 'SELECT email, role FROM users WHERE id = $1 AND tenant_id = $2';
    const checkParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows: checkRows } = await db.query(checkQ, checkParams);

    if (checkRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Admin cannot delete superadmin
    if (checkRows[0].role === 'superadmin' && !isSuperAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Cannot delete superadmin user',
        status: 403,
      });
    }

    // Nullify non-cascading FKs (firmwares.uploaded_by, ota_rollouts.created_by)
    await db.query('UPDATE firmwares SET uploaded_by = NULL WHERE uploaded_by = $1', [req.params.id]);
    await db.query('UPDATE ota_rollouts SET created_by = NULL WHERE created_by = $1', [req.params.id]);

    // Hard delete (cascades: user_devices, user_tenants, refresh_tokens, push_subscriptions; audit_log → SET NULL)
    const delQ = isSuperAdmin
      ? `DELETE FROM users WHERE id = $1 RETURNING id, email, role`
      : `DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id, email, role`;
    const delParams = isSuperAdmin ? [req.params.id] : [req.params.id, req.tenantId];
    const { rows } = await db.query(delQ, delParams);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Audit: preserve deleted user's identity
    req.auditContext = { entityId: req.params.id, changes: { before: { email: checkRows[0].email, role: checkRows[0].role } } };

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
      `SELECT t.id, t.name, t.slug, ut.role, ut.created_at
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

const addTenantSchema = z.object({
  tenant_id: z.string().uuid(),
  role:      z.enum(['admin', 'technician', 'viewer']).optional(),   // role held there (plan epic 2.5); default: the account role
});

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

  const { tenant_id, role } = parsed.data;
  try {
    // Verify user and tenant exist
    const { rows: uCheck } = await db.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (uCheck.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }
    const { rows: tCheck } = await db.query('SELECT id FROM tenants WHERE id = $1', [tenant_id]);
    if (tCheck.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Tenant not found', status: 404 });
    }

    const memberRole = role || (uCheck[0].role === 'superadmin' ? 'admin' : uCheck[0].role);
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.id, tenant_id, memberRole]
    );

    // Return updated membership list
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.slug, ut.role
         FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1 ORDER BY t.name`,
      [req.params.id]
    );
    // Audit: which tenant was added
    req.auditContext = { entityId: req.params.id, changes: { tenant_id, role: memberRole } };

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

    // Site grants live in the tenant the membership just lost. Leaving them
    // behind would silently reactivate the old access the moment the user is
    // re-added to that tenant.
    await db.query(
      'DELETE FROM user_sites WHERE user_id = $1 AND tenant_id = $2',
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

    // Audit: how many devices were set
    req.auditContext = { entityId: userId, changes: { count: device_ids.length } };

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
    // Audit: which device was granted
    req.auditContext = { entityId: req.params.id, changes: { device_id: parsed.data.device_id } };

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
// ── Site-level access grants (user_sites) ────────────────
// ══════════════════════════════════════════════════════════
//
// A grant on a site gives the user every device standing at that site, resolved
// as `user_devices ∪ user_sites` in middleware/device-access.js. The whole router
// is mounted behind authorize('admin') in index.js, so these are admin-only.
//
// Tenant scoping rule for all three handlers: the site is validated against the
// TARGET USER's tenant, never req.tenantId. For a superadmin acting from another
// tenant those differ, and using req.tenantId would either grant nothing or —
// worse — accept a site id observed in a different tenant. `user_sites.tenant_id`
// is written from the same value, and the composite FK (tenant_id, site_id)
// makes a cross-tenant row physically impossible.

// Resolve the grant target the way PUT /users/:id/devices does (superadmin: any
// user; everybody else: own tenant only). Returns null when not visible.
async function loadTargetUser(req, userId) {
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  const sql = isSuperAdmin
    ? 'SELECT id, tenant_id FROM users WHERE id = $1'
    : 'SELECT id, tenant_id FROM users WHERE id = $1 AND tenant_id = $2';
  const params = isSuperAdmin ? [userId] : [userId, req.tenantId];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

function userNotFound(res) {
  return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
}

// ── GET /users/:id/sites — list granted sites ────────────

router.get('/:id/sites', async (req, res) => {
  // A non-UUID :id compared against the uuid column raises 22P02 → 500.
  if (!isUuidFormat(req.params.id)) return userNotFound(res);

  try {
    const target = await loadTargetUser(req, req.params.id);
    if (!target) return userNotFound(res);

    const { rows } = await db.query(
      `SELECT s.id, s.name, s.country_code, s.country, s.region, s.city,
              us.granted_at, us.granted_by,
              (SELECT COUNT(*) FROM devices d
                WHERE d.site_id = s.id AND d.tenant_id = s.tenant_id
                  AND d.status = 'active' AND d.deleted_at IS NULL)::int AS device_count
         FROM user_sites us
         JOIN sites s ON s.id = us.site_id AND s.tenant_id = us.tenant_id
        WHERE us.user_id = $1 AND us.tenant_id = $2
        ORDER BY s.name`,
      [req.params.id, target.tenant_id]
    );

    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List user sites failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list user sites', status: 500 });
  }
});

// ── POST /users/:id/sites — grant one site ───────────────

router.post('/:id/sites', async (req, res) => {
  if (!isUuidFormat(req.params.id)) return userNotFound(res);

  const parsed = siteAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'site_id (UUID) is required',
      status: 400,
    });
  }

  const { site_id } = parsed.data;

  try {
    const target = await loadTargetUser(req, req.params.id);
    if (!target) return userNotFound(res);

    // The site must belong to the TARGET USER's tenant.
    const siteCheck = await db.query(
      'SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2',
      [site_id, target.tenant_id]
    );
    if (siteCheck.rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_site',
        message: 'Site does not belong to this tenant',
        status: 400,
      });
    }

    await db.query(
      `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT DO NOTHING`,
      [req.params.id, site_id, target.tenant_id, req.user?.id || null]
    );

    // Audit: which site was granted to whom
    req.auditContext = { entityId: req.params.id, changes: { site_id, action: 'grant' } };

    res.status(201).json({ data: { message: 'Site access granted', site_id } });
  } catch (err) {
    // The site was deleted between the check and the insert.
    if (err.code === '23503') {
      return res.status(400).json({
        error: 'invalid_site',
        message: 'Site does not belong to this tenant',
        status: 400,
      });
    }
    req.log?.error?.({ err }, 'Grant site access failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to grant site access', status: 500 });
  }
});

// ── DELETE /users/:id/sites/:siteId — revoke one site ────

router.delete('/:id/sites/:siteId', async (req, res) => {
  if (!isUuidFormat(req.params.id) || !isUuidFormat(req.params.siteId)) {
    return userNotFound(res);
  }

  try {
    const target = await loadTargetUser(req, req.params.id);
    if (!target) return userNotFound(res);

    // tenant_id in the predicate as well as the PK columns: a grant belonging to
    // another tenant must not be removable from here.
    const { rowCount } = await db.query(
      'DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2 AND tenant_id = $3',
      [req.params.id, req.params.siteId, target.tenant_id]
    );

    req.auditContext = {
      entityId: req.params.id,
      changes: { site_id: req.params.siteId, action: 'revoke', removed: rowCount > 0 },
    };

    res.json({ data: { message: 'Site access revoked', site_id: req.params.siteId } });
  } catch (err) {
    req.log?.error?.({ err }, 'Revoke site access failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to revoke site access', status: 500 });
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
