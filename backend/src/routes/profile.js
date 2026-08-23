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

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');

const router = Router();

const PROFILE_COLUMNS = 'id, email, role, base_latitude, base_longitude, base_address';

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

module.exports = router;
