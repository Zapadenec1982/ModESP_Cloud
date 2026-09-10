'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const { authorize } = require('../middleware/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────────

const powerField = z.number().min(0).max(100).nullable().optional();

const createModelSchema = z.object({
  // A platform model (tenant_id NULL, migration 052) — superadmin only, the same
  // rule a platform firmware follows.
  platform:          z.boolean().optional(),
  name:              z.string().min(1).max(64).trim(),
  compressor_kw:     powerField,
  evap_fan_kw:       powerField,
  cond_fan_kw:       powerField,
  defrost_heater_kw: powerField,
  standby_kw:        powerField,
  energy_source:     z.enum(['estimated', 'metered']).default('estimated'),
});

const updateModelSchema = z.object({
  name:              z.string().min(1).max(64).trim().optional(),
  compressor_kw:     powerField,
  evap_fan_kw:       powerField,
  cond_fan_kw:       powerField,
  defrost_heater_kw: powerField,
  standby_kw:        powerField,
  energy_source:     z.enum(['estimated', 'metered']).optional(),
});

// ── GET /api/device-models ─────────────────────────────────
// List equipment models for current tenant (all roles).
router.get('/', async (req, res, next) => {
  try {
    const isSuperAdmin = req.user && req.user.role === 'superadmin';
    let rows;

    if (isSuperAdmin) {
      ({ rows } = await db.query(
        `SELECT dm.*, t.name AS tenant_name, (dm.tenant_id IS NULL) AS platform,
                (SELECT COUNT(*)::int FROM devices d
                  WHERE d.model_id = dm.id
                    AND (dm.tenant_id IS NULL OR d.tenant_id = dm.tenant_id)) AS device_count
         FROM device_models dm
         LEFT JOIN tenants t ON t.id = dm.tenant_id
         ORDER BY dm.tenant_id IS NOT NULL, t.name, dm.name`
      ));
    } else {
      // Own models plus the platform ones (tenant_id NULL, migration 052), which
      // every organisation may point a device at but none may edit.
      //
      // The count is «my devices on this model»: d.tenant_id = $1, not
      // dm.tenant_id, so it reads the same for an own model and for a platform
      // one. Counting every tenant's rows inflated the number with devices the
      // organisation cannot see, and made the delete below refuse over them.
      ({ rows } = await db.query(
        `SELECT dm.*, (dm.tenant_id IS NULL) AS platform,
                (SELECT COUNT(*)::int FROM devices d
                  WHERE d.model_id = dm.id AND d.tenant_id = $1) AS device_count
         FROM device_models dm
         WHERE dm.tenant_id = $1 OR dm.tenant_id IS NULL
         ORDER BY dm.tenant_id IS NULL, dm.name`,
        [req.tenantId]
      ));
    }

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/device-models ────────────────────────────────
// Create a new equipment model (admin+).
router.post('/', authorize('admin'), async (req, res, next) => {
  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const { platform, name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source } = parsed.data;
  if (platform && !(req.user && req.user.role === 'superadmin')) {
    return res.status(403).json({ error: 'forbidden', message: 'Only a superadmin creates a platform model', status: 403 });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [platform ? null : req.tenantId, name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'Model name already exists', status: 409 });
    }
    next(err);
  }
});

// ── PATCH /api/device-models/:id ───────────────────────────
// Update equipment model (admin+).
router.patch('/:id', authorize('admin'), async (req, res, next) => {
  const parsed = updateModelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'validation_failed',
      message: parsed.error.issues[0].message,
      status: 400,
    });
  }

  const fields = parsed.data;
  // Who owns the row decides who may write it: an organisation edits its own
  // models, a platform model is the superadmin's. Reached by the same route, so
  // the check is here rather than on the mount.
  const isSuperAdmin = req.user && req.user.role === 'superadmin';
  try {
    const { rows: owner } = await db.query('SELECT tenant_id FROM device_models WHERE id = $1', [req.params.id]);
    if (!owner.length) return res.status(404).json({ error: 'not_found', message: 'Model not found', status: 404 });
    if (owner[0].tenant_id === null && !isSuperAdmin) {
      return res.status(403).json({ error: 'forbidden', message: 'A platform model is edited by a superadmin', status: 403 });
    }
  } catch (err) { return next(err); }

  const sets = [];
  const params = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${idx++}`);
      params.push(value);
    }
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'validation_failed', message: 'Nothing to update', status: 400 });
  }

  try {
    params.push(req.params.id, req.tenantId);
    const { rows } = await db.query(
      `UPDATE device_models SET ${sets.join(', ')}
        WHERE id = $${idx++}
          AND (tenant_id = $${idx} OR (tenant_id IS NULL AND ${isSuperAdmin ? 'true' : 'false'}))
       RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Model not found', status: 404 });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'Model name already exists', status: 409 });
    }
    next(err);
  }
});

// ── DELETE /api/device-models/:id ──────────────────────────
// Delete equipment model if no devices are linked (admin+).
router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const isSuperAdmin = req.user && req.user.role === 'superadmin';
    const { rows: owner } = await db.query('SELECT tenant_id FROM device_models WHERE id = $1', [req.params.id]);
    if (!owner.length) return res.status(404).json({ error: 'not_found', message: 'Model not found', status: 404 });
    const isPlatform = owner[0].tenant_id === null;
    if (isPlatform && !isSuperAdmin) {
      return res.status(403).json({ error: 'forbidden', message: 'A platform model is deleted by a superadmin', status: 403 });
    }

    // For an own model: devices of THIS organisation. Counting every tenant's
    // rows made the message name devices the caller cannot see, and blocked the
    // delete over a reference they had no way to remove.
    //
    // For a platform model the opposite holds — it is shared, so ANY device still
    // pointing at it must stop the delete, whoever owns that device.
    const { rows: linked } = isPlatform
      ? await db.query('SELECT COUNT(*)::int AS count FROM devices WHERE model_id = $1', [req.params.id])
      : await db.query('SELECT COUNT(*)::int AS count FROM devices WHERE model_id = $1 AND tenant_id = $2',
                       [req.params.id, req.tenantId]);
    if (linked[0].count > 0) {
      return res.status(409).json({
        error: 'in_use',
        message: `Cannot delete: ${linked[0].count} device(s) linked to this model`,
        status: 409,
      });
    }

    const { rowCount } = isPlatform
      ? await db.query('DELETE FROM device_models WHERE id = $1 AND tenant_id IS NULL', [req.params.id])
      : await db.query('DELETE FROM device_models WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Model not found', status: 404 });
    }

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
