'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const otaSvc     = require('../services/ota');
const { authorize } = require('../middleware/auth');
const { checkDeviceAccess } = require('../middleware/device-access');

const router = Router();

// ── POST /api/ota/deploy — single device OTA (technician+)
router.post('/deploy', async (req, res, next) => {
  try {
    const { firmware_id, device_id } = req.body || {};

    if (!firmware_id || !device_id) {
      return res.status(400).json({
        error: 'missing_params',
        message: 'firmware_id and device_id are required',
        status: 400,
      });
    }

    // Per-device RBAC: technician/viewer can only deploy to assigned devices
    if (req.user && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      if (req.user.role === 'viewer') {
        return res.status(403).json({ error: 'forbidden', message: 'Viewers cannot deploy firmware', status: 403 });
      }
      // Technician: check device access
      const accessCheck = await db.query(
        `SELECT 1 FROM user_devices ud
         JOIN devices d ON d.id = ud.device_id
         WHERE ud.user_id = $1 AND d.mqtt_device_id = $2 AND d.tenant_id = $3`,
        [req.user.id, device_id, req.tenantId]
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'forbidden', message: 'Device access denied', status: 403 });
      }
    }

    // Resolve tenant slug
    const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [req.tenantId]);
    if (tRes.rows.length === 0) {
      return res.status(400).json({ error: 'tenant_not_found', message: 'Tenant not found', status: 400 });
    }

    const result = await otaSvc.deploySingle(
      req.tenantId, tRes.rows[0].slug, firmware_id, device_id, req.userId
    );

    // Audit: OTA deploy details
    req.auditContext = { changes: { firmware_id, device_id } };

    res.status(201).json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
    }
    next(err);
  }
});

// ── POST /api/ota/rollout — group OTA ──────── (admin only)
router.post('/rollout', authorize('admin'), async (req, res, next) => {
  try {
    const { firmware_id, device_ids, batch_size, batch_interval_s, fail_threshold_pct } = req.body || {};

    if (!firmware_id) {
      return res.status(400).json({
        error: 'missing_params',
        message: 'firmware_id is required',
        status: 400,
      });
    }

    // Resolve tenant slug
    const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [req.tenantId]);
    if (tRes.rows.length === 0) {
      return res.status(400).json({ error: 'tenant_not_found', message: 'Tenant not found', status: 400 });
    }

    const result = await otaSvc.createRollout(req.tenantId, tRes.rows[0].slug, {
      firmwareId:       firmware_id,
      deviceIds:        device_ids,
      batchSize:        batch_size,
      batchIntervalS:   batch_interval_s,
      failThresholdPct: fail_threshold_pct,
      userId:           req.userId,
    });

    // Audit: rollout details
    req.auditContext = { entityId: result.rollout_id || result.id, changes: { firmware_id, target_count: device_ids?.length } };

    res.status(201).json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
    }
    next(err);
  }
});

// ── GET /api/ota/jobs ────────────────────────────────────
router.get('/jobs', async (req, res, next) => {
  try {
    const { status, rollout_id, device_id, limit } = req.query;
    const conditions = ['j.tenant_id = $1'];
    const params = [req.tenantId];
    let idx = 2;

    if (status) {
      conditions.push(`j.status = $${idx++}`);
      params.push(status);
    }
    if (rollout_id) {
      conditions.push(`j.rollout_id = $${idx++}`);
      params.push(rollout_id);
    }
    if (device_id) {
      conditions.push(`j.device_id = $${idx++}`);
      params.push(device_id);
    }

    const maxRows = Math.min(parseInt(limit, 10) || 100, 500);

    const result = await db.query(
      `SELECT j.id, j.device_id, j.rollout_id, j.status, j.queued_at, j.sent_at, j.completed_at, j.error,
              f.version AS firmware_version
       FROM ota_jobs j
       JOIN firmwares f ON f.id = j.firmware_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY j.queued_at DESC
       LIMIT ${maxRows}`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ota/rollouts ────────────────────────────────
router.get('/rollouts', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.status, r.batch_size, r.batch_interval_s, r.fail_threshold_pct,
              r.total_devices, r.created_at, r.completed_at,
              f.version AS firmware_version,
              COUNT(*) FILTER (WHERE j.status = 'queued')::int    AS queued,
              COUNT(*) FILTER (WHERE j.status = 'sent')::int      AS sent,
              COUNT(*) FILTER (WHERE j.status = 'succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int    AS failed,
              COUNT(*) FILTER (WHERE j.status = 'cancelled')::int AS cancelled
       FROM ota_rollouts r
       JOIN firmwares f ON f.id = r.firmware_id
       LEFT JOIN ota_jobs j ON j.rollout_id = r.id
       WHERE r.tenant_id = $1
       GROUP BY r.id, f.version
       ORDER BY r.created_at DESC`,
      [req.tenantId]
    );

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ota/rollouts/:id ────────────────────────────
router.get('/rollouts/:id', async (req, res, next) => {
  try {
    const rRes = await db.query(
      `SELECT r.*, f.version AS firmware_version
       FROM ota_rollouts r
       JOIN firmwares f ON f.id = r.firmware_id
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (rRes.rows.length === 0) {
      return res.status(404).json({ error: 'rollout_not_found', message: 'Rollout not found', status: 404 });
    }

    const jobsRes = await db.query(
      `SELECT j.id, j.device_id, j.status, j.queued_at, j.sent_at, j.completed_at, j.error
       FROM ota_jobs j
       WHERE j.rollout_id = $1
       ORDER BY j.queued_at`,
      [req.params.id]
    );

    res.json({
      data: {
        ...rRes.rows[0],
        jobs: jobsRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ota/rollouts/:id/pause ──────── (admin only)
router.post('/rollouts/:id/pause', authorize('admin'), async (req, res, next) => {
  try {
    const result = await otaSvc.pauseRollout(req.tenantId, req.params.id);
    res.json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
    }
    next(err);
  }
});

// ── POST /api/ota/rollouts/:id/resume ─────── (admin only)
router.post('/rollouts/:id/resume', authorize('admin'), async (req, res, next) => {
  try {
    const result = await otaSvc.resumeRollout(req.tenantId, req.params.id);
    res.json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
    }
    next(err);
  }
});

// ── POST /api/ota/rollouts/:id/cancel ─────── (admin only)
router.post('/rollouts/:id/cancel', authorize('admin'), async (req, res, next) => {
  try {
    const result = await otaSvc.cancelRollout(req.tenantId, req.params.id);
    res.json({ data: result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
    }
    next(err);
  }
});

module.exports = router;
