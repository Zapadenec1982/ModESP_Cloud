'use strict';

// Own profile — the self-service half of the technician home base (Part 2 §7.4).
//
// Why a separate router instead of another /api/users/me route: index.js mounts
// `app.use('/api/users', authorize('admin'), …)`, so PUT /api/users/me already
// returns 403 for exactly the two roles that need to edit their own base —
// technician and viewer. This router is mounted at /api/profile inside the
// AUTH_ENABLED block, ABOVE the admin-only /api/users line, with no authorize()
// of its own: any authenticated user, their own row only.
//
// Scope: every statement carries `id = req.user.id`, which is already the
// tightest possible predicate, PLUS the usual tenant predicate. The tenant
// predicate is dropped only for role === 'superadmin' — the same bypass shape
// used across this codebase — because a superadmin acting inside another tenant
// after switch-tenant would otherwise get a 404 on their own profile.
//
// An admin setting somebody ELSE's base goes through PUT /api/users/:id.
// Account fields (email, password) are PUT /api/profile; role/active/tenant stay admin-only.

const { Router } = require('express');
const { z }      = require('zod');
const crypto     = require('crypto');
const db         = require('../services/db');
const authSvc    = require('../services/auth');
const { passwordSchema } = require('../lib/password-policy');

const router = Router();

// Everything the WebUI needs to restore a session and render the settings menu.
// Since plan epic 1.5 this router also carries the former /users/me routes
// (account update, password, Telegram link, Web Push subscription): mounting
// them under the admin-only /users prefix logged every technician out on reload.
const PROFILE_COLUMNS = 'id, email, role, active, created_at, last_login, telegram_id, ' +
                        'base_latitude, base_longitude, base_address';

// A half-set home base is worse than none: "nearest technician" would place the
// user on the prime meridian. The pair must be written or cleared together.
// (routes/users.js repeats this rule for the admin half of §7.4.)
const baseLocationPaired = (d) => {
  const hasLat = d.base_latitude  !== undefined;
  const hasLon = d.base_longitude !== undefined;
  if (hasLat !== hasLon) return false;
  if (hasLat && hasLon) return (d.base_latitude === null) === (d.base_longitude === null);
  return true;
};

// Deliberately NOT email / password / role / active / tenant_id: those stay on
// PUT /api/users/me and PUT /api/users/:id. This endpoint can only move a pin.
const updateProfileSchema = z.object({
  base_latitude:  z.number().min(-90).max(90).nullable().optional(),
  base_longitude: z.number().min(-180).max(180).nullable().optional(),
  base_address:   z.string().max(256).nullable().optional(),
})
  .refine(d => Object.keys(d).length > 0, {
    message: 'At least one of base_latitude, base_longitude, base_address is required',
  })
  .refine(baseLocationPaired, {
    message: 'base_latitude and base_longitude must be provided (or cleared) together',
  });

function tenantScope(req, startIndex) {
  // Returns ['', []] for superadmin, [' AND tenant_id = $n', [tenantId]] otherwise.
  if (req.user && req.user.role === 'superadmin') return ['', []];
  return [` AND tenant_id = $${startIndex}`, [req.tenantId]];
}

// ── GET /api/profile ──────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const [scopeSql, scopeParams] = tenantScope(req, 2);
    const { rows } = await db.query(
      `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1${scopeSql}`,
      [req.user.id, ...scopeParams]
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

// ── PATCH /api/profile — own home base ────────────────────

router.patch('/', async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const data = parsed.data;

  try {
    // The SET list is built from the PARSED keys only — never from req.body.
    // zod strips unknown keys, which is the only reason this pattern is safe.
    const sets   = [];
    const params = [];
    let idx = 1;

    if (data.base_latitude !== undefined)  { sets.push(`base_latitude = $${idx++}`);  params.push(data.base_latitude); }
    if (data.base_longitude !== undefined) { sets.push(`base_longitude = $${idx++}`); params.push(data.base_longitude); }
    if (data.base_address !== undefined)   { sets.push(`base_address = $${idx++}`);   params.push(data.base_address); }

    params.push(req.user.id);
    const idPlaceholder = idx++;
    const [scopeSql, scopeParams] = tenantScope(req, idx);
    params.push(...scopeParams);

    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')}
        WHERE id = $${idPlaceholder}${scopeSql}
        RETURNING ${PROFILE_COLUMNS}`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }

    // Audit: a home base is what "nearest technician" dispatches on.
    req.auditContext = {
      entityId: req.user.id,
      changes: {
        base_latitude:  data.base_latitude,
        base_longitude: data.base_longitude,
        base_address:   data.base_address,
      },
    };

    res.json({ data: rows[0] });
  } catch (err) {
    req.log?.error?.({ err }, 'Update profile failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update profile', status: 500 });
  }
});

// ── PUT /api/profile — own email and/or password ──────────

const updateAccountSchema = z.object({
  email:        z.string().email().max(256).optional(),
  password:     passwordSchema.optional(),
  old_password: z.string().max(256).optional(),
});

async function changeOwnAccount(req, res, { email, password, old_password }) {
  const [scopeSql, scopeParams] = tenantScope(req, 2);

  if (password) {
    if (!old_password) {
      return res.status(400).json({
        error: 'validation_failed', message: 'old_password is required to change password', status: 400,
      });
    }
    const { rows } = await db.query(
      `SELECT password_hash FROM users WHERE id = $1${scopeSql}`,
      [req.user.id, ...scopeParams]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }
    const valid = await authSvc.comparePassword(old_password, rows[0].password_hash);
    if (!valid) {
      return res.status(400).json({
        error: 'invalid_password', message: 'Current password is incorrect', status: 400,
      });
    }
  }

  const sets = [];
  const params = [];
  let idx = 1;
  if (email)    { sets.push(`email = $${idx++}`);         params.push(email); }
  if (password) { sets.push(`password_hash = $${idx++}`); params.push(await authSvc.hashPassword(password)); }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'validation_failed', message: 'Nothing to update', status: 400 });
  }

  params.push(req.user.id);
  const idPlaceholder = idx++;
  const [scope2Sql, scope2Params] = tenantScope(req, idx);
  params.push(...scope2Params);

  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idPlaceholder}${scope2Sql}
     RETURNING id, email, role, active`,
    params
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
  }
  req.auditContext = { entityId: req.user.id, action: password ? 'profile.password_change' : 'profile.update' };
  res.json({ data: rows[0] });
}

router.put('/', async (req, res) => {
  const parsed = updateAccountSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    await changeOwnAccount(req, res, parsed.data);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'Email already in use', status: 409 });
    }
    req.log?.error?.({ err }, 'Update account failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update account', status: 500 });
  }
});

// ── PUT /api/profile/password — explicit password change ──

const changePasswordSchema = z.object({
  old_password: z.string().min(1).max(256),
  new_password: passwordSchema,
});

router.put('/password', async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  try {
    await changeOwnAccount(req, res, { password: parsed.data.new_password, old_password: parsed.data.old_password });
  } catch (err) {
    req.log?.error?.({ err }, 'Change password failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to change password', status: 500 });
  }
});

// ── Telegram linking (own account) ─────────────────────────

router.post('/telegram-link', async (req, res) => {
  try {
    const code    = crypto.randomBytes(8).toString('hex');   // 16 hex chars
    const expires = new Date(Date.now() + 15 * 60 * 1000);   // 15 min TTL
    const [scopeSql, scopeParams] = tenantScope(req, 4);
    const { rowCount } = await db.query(
      `UPDATE users SET telegram_link_code = $1, telegram_link_expires = $2 WHERE id = $3${scopeSql}`,
      [code, expires, req.user.id, ...scopeParams]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found', status: 404 });
    }
    res.json({ data: { link_code: code, expires_at: expires.toISOString() } });
  } catch (err) {
    req.log?.error?.({ err }, 'Generate telegram link failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to generate link', status: 500 });
  }
});

router.delete('/telegram-link', async (req, res) => {
  try {
    const [scopeSql, scopeParams] = tenantScope(req, 2);
    await db.query(
      `UPDATE users SET telegram_id = NULL, telegram_link_code = NULL, telegram_link_expires = NULL
        WHERE id = $1${scopeSql}`,
      [req.user.id, ...scopeParams]
    );
    res.json({ data: { message: 'Telegram unlinked' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Unlink telegram failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to unlink', status: 500 });
  }
});

// ── Web Push subscription (own browser) ────────────────────

const pushSubSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
});

router.post('/push-subscription', async (req, res) => {
  const parsed = pushSubSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const { endpoint, keys } = parsed.data;
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
      [req.user.id, req.tenantId, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
    );
    res.json({ data: { id: rows[0].id, message: 'Subscription saved' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Save push subscription failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to save subscription', status: 500 });
  }
});

router.delete('/push-subscription', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'validation_failed', message: 'endpoint is required', status: 400 });
  }
  try {
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.user.id, endpoint]);
    res.json({ data: { message: 'Subscription removed' } });
  } catch (err) {
    req.log?.error?.({ err }, 'Delete push subscription failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to remove subscription', status: 500 });
  }
});

module.exports = router;
