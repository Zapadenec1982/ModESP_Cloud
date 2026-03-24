'use strict';

const { Router } = require('express');
const { z }      = require('zod');
const db         = require('../services/db');
const { authorize } = require('../middleware/auth');

const router = Router();

// ── Validation schemas ──────────────────────────────────────

const powerField = z.number().min(0).max(100).nullable().optional();

const createModelSchema = z.object({
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
        `SELECT dm.*, t.name AS tenant_name,
                (SELECT COUNT(*)::int FROM devices d WHERE d.model_id = dm.id) AS device_count
         FROM device_models dm
         JOIN tenants t ON t.id = dm.tenant_id
         ORDER BY t.name, dm.name`
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT dm.*,
                (SELECT COUNT(*)::int FROM devices d WHERE d.model_id = dm.id) AS device_count
         FROM device_models dm
         WHERE dm.tenant_id = $1
         ORDER BY dm.name`,
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

  const { name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source } = parsed.data;

  try {
    const { rows } = await db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, name, compressor_kw, evap_fan_kw, cond_fan_kw, defrost_heater_kw, standby_kw, energy_source]
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
       WHERE id = $${idx++} AND tenant_id = $${idx}
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
    // Check for linked devices
    const { rows: linked } = await db.query(
      'SELECT COUNT(*)::int AS count FROM devices WHERE model_id = $1',
      [req.params.id]
    );
    if (linked[0].count > 0) {
      return res.status(409).json({
        error: 'in_use',
        message: `Cannot delete: ${linked[0].count} device(s) linked to this model`,
        status: 409,
      });
    }

    const { rowCount } = await db.query(
      'DELETE FROM device_models WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Model not found', status: 404 });
    }

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
