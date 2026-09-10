'use strict';

/**
 * OTA (Phase 6, plan epic 2.8).
 *   POST /ota/deploy          one device; technician on a granted device, admin anywhere.
 *                             `force: true` (admin) skips the soft pre-OTA checks.
 *   GET  /ota/rollback        ?device_id= — what a rollback would install
 *   POST /ota/rollback        return the device to the version it ran before its last update
 *   POST /ota/rollout         batched group update (admin)
 *   GET  /ota/jobs, /ota/rollouts, /ota/rollouts/:id
 *   POST /ota/rollouts/:id/pause | resume | cancel (admin)
 */

const { Router } = require('express');
const db         = require('../services/db');
const otaSvc     = require('../services/ota');
const { authorize } = require('../middleware/auth');
const { requireFeature } = require('../middleware/plan');

const router = Router();
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

// Viewers never reach OTA; technicians deploy to their devices and read the activity
router.use(maybeAuthorize('admin', 'technician'));

const isAdmin = (req) => !req.user || req.user.role === 'admin' || req.user.role === 'superadmin';
const actorOf = (req) => (req.user ? { id: req.user.id, email: req.user.email } : null);

/** Technicians may touch only the devices granted to them; an API key stands for the organisation. */
async function canTouchDevice(req, deviceId) {
  if (isAdmin(req) || req.user.apiKey) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM user_devices ud
       JOIN devices d ON d.id = ud.device_id
      WHERE ud.user_id = $1 AND d.mqtt_device_id = $2 AND d.tenant_id = $3
     UNION
     SELECT 1 FROM user_sites us
       JOIN devices d ON d.site_id = us.site_id AND d.tenant_id = us.tenant_id
      WHERE us.user_id = $1 AND d.mqtt_device_id = $2 AND us.tenant_id = $3
     LIMIT 1`,
    [req.user.id, deviceId, req.tenantId]);
  return rows.length > 0;
}

async function tenantSlug(req, res) {
  const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [req.tenantId]);
  if (tRes.rows.length === 0) {
    res.status(400).json({ error: 'tenant_not_found', message: 'Tenant not found', status: 400 });
    return null;
  }
  return tRes.rows[0].slug;
}

function sendError(res, err, next) {
  if (err.status) {
    const body = { error: err.code || 'ota_error', message: err.message, status: err.status };
    if (err.reasons) { body.reasons = err.reasons; body.forceable = err.forceable; body.window = err.window; }
    if (err.previous_version) body.previous_version = err.previous_version;
    return res.status(err.status).json(body);
  }
  next(err);
}

// ── POST /api/ota/deploy — single device OTA (technician+)
router.post('/deploy', async (req, res, next) => {
  try {
    const { firmware_id, device_id } = req.body || {};
    if (!firmware_id || !device_id) {
      return res.status(400).json({ error: 'missing_params', message: 'firmware_id and device_id are required', status: 400 });
    }
    if (!await canTouchDevice(req, device_id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Device access denied', status: 403 });
    }
    const slug = await tenantSlug(req, res);
    if (!slug) return;

    // Only an admin may override the soft checks; a technician's `force` is ignored
    const force = isAdmin(req) && req.body.force === true;
    const result = await otaSvc.deploySingle(req.tenantId, slug, firmware_id, device_id, actorOf(req), { force });

    req.auditContext = { changes: { firmware_id, device_id, force, overridden: result.overridden } };
    res.status(201).json({ data: result });
  } catch (err) {
    sendError(res, err, next);
  }
});

// ── GET /api/ota/rollback?device_id= — preview ──────────
router.get('/rollback', async (req, res, next) => {
  try {
    const deviceId = String(req.query.device_id || '');
    if (!deviceId) return res.status(400).json({ error: 'missing_params', message: 'device_id is required', status: 400 });
    if (!await canTouchDevice(req, deviceId)) {
      return res.status(403).json({ error: 'forbidden', message: 'Device access denied', status: 403 });
    }
    res.json({ data: await otaSvc.rollbackTarget(req.tenantId, deviceId) });
  } catch (err) {
    sendError(res, err, next);
  }
});

// ── POST /api/ota/rollback — previous successful version ──
router.post('/rollback', async (req, res, next) => {
  try {
    const { device_id } = req.body || {};
    if (!device_id) return res.status(400).json({ error: 'missing_params', message: 'device_id is required', status: 400 });
    if (!await canTouchDevice(req, device_id)) {
      return res.status(403).json({ error: 'forbidden', message: 'Device access denied', status: 403 });
    }
    const slug = await tenantSlug(req, res);
    if (!slug) return;
    const force = isAdmin(req) && req.body.force === true;
    const result = await otaSvc.rollback(req.tenantId, slug, device_id, actorOf(req), { force });
    req.auditContext = { action: 'ota.rollback', changes: { device_id, firmware_version: result.firmware_version, force } };
    res.status(201).json({ data: result });
  } catch (err) {
    sendError(res, err, next);
  }
});

// ── POST /api/ota/rollout — group OTA ──────── (admin only)
// Mass rollout is a plan feature («Про» and up). The key was seeded in
// plan_limits.features from the start and never checked anywhere, so a free
// organisation could roll firmware across its whole fleet — the one OTA
// operation with real blast radius. Single-device deploy stays open to every
// plan; only the fleet-wide one is gated.
router.post('/rollout', maybeAuthorize('admin'), requireFeature('ota_rollout'), async (req, res, next) => {
  try {
    const { firmware_id, device_ids, batch_size, batch_interval_s, fail_threshold_pct } = req.body || {};
    if (!firmware_id) {
      return res.status(400).json({ error: 'missing_params', message: 'firmware_id is required', status: 400 });
    }
    const slug = await tenantSlug(req, res);
    if (!slug) return;

    const clamp = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    const result = await otaSvc.createRollout(req.tenantId, slug, {
      firmwareId:       firmware_id,
      deviceIds:        Array.isArray(device_ids) ? device_ids : undefined,
      batchSize:        clamp(batch_size, 1, 100, 5),
      batchIntervalS:   clamp(batch_interval_s, 30, 86400, 300),
      failThresholdPct: clamp(fail_threshold_pct, 1, 100, 50),
      actor:            actorOf(req),
    });

    req.auditContext = { entityId: result.rollout_id, changes: { firmware_id, target_count: device_ids?.length, fail_threshold_pct: result.fail_threshold_pct } };
    res.status(201).json({ data: result });
  } catch (err) {
    sendError(res, err, next);
  }
});

// ── GET /api/ota/jobs ────────────────────────────────────
router.get('/jobs', async (req, res, next) => {
  try {
    const { status, rollout_id, device_id, limit } = req.query;
    const conditions = ['j.tenant_id = $1'];
    const params = [req.tenantId];
    let idx = 2;

    if (status)     { conditions.push(`j.status = $${idx++}`);     params.push(status); }
    if (rollout_id) { conditions.push(`j.rollout_id = $${idx++}`); params.push(rollout_id); }
    if (device_id)  { conditions.push(`j.device_id = $${idx++}`);  params.push(device_id); }

    const maxRows = Math.min(parseInt(limit, 10) || 100, 500);

    const result = await db.query(
      `SELECT j.id, j.device_id, j.rollout_id, j.status, j.kind, j.forced, j.deferrals, j.defer_reason, j.actor,
              j.queued_at, j.sent_at, j.completed_at, j.error, j.pre_ota_version,
              j.firmware_id, COALESCE(f.version, j.firmware_version) AS firmware_version,
              (j.firmware_id IS NULL) AS firmware_deleted
       FROM ota_jobs j
       LEFT JOIN firmwares f ON f.id = j.firmware_id
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
      `SELECT r.id, r.status, r.paused_reason, r.batch_size, r.batch_interval_s, r.fail_threshold_pct,
              r.total_devices, r.created_at, r.completed_at, r.firmware_id,
              COALESCE(f.version, r.firmware_version) AS firmware_version,
              (r.firmware_id IS NULL) AS firmware_deleted,
              u.email AS created_by_email,
              COUNT(*) FILTER (WHERE j.status = 'queued')::int    AS queued,
              COUNT(*) FILTER (WHERE j.status = 'queued' AND j.deferrals > 0)::int AS deferred,
              COUNT(*) FILTER (WHERE j.status = 'sent')::int      AS sent,
              COUNT(*) FILTER (WHERE j.status = 'succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int    AS failed,
              COUNT(*) FILTER (WHERE j.status = 'cancelled')::int AS cancelled
       FROM ota_rollouts r
       LEFT JOIN firmwares f ON f.id = r.firmware_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN ota_jobs j ON j.rollout_id = r.id
       WHERE r.tenant_id = $1
       GROUP BY r.id, f.version, u.email
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
      `SELECT r.*, COALESCE(f.version, r.firmware_version) AS firmware_version, (r.firmware_id IS NULL) AS firmware_deleted,
              u.email AS created_by_email
       FROM ota_rollouts r
       LEFT JOIN firmwares f ON f.id = r.firmware_id
       LEFT JOIN users u ON u.id = r.created_by
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (rRes.rows.length === 0) {
      return res.status(404).json({ error: 'rollout_not_found', message: 'Rollout not found', status: 404 });
    }

    const jobsRes = await db.query(
      `SELECT j.id, j.device_id, j.status, j.kind, j.deferrals, j.defer_reason, j.queued_at, j.sent_at, j.completed_at, j.error
       FROM ota_jobs j
       WHERE j.rollout_id = $1
       ORDER BY j.queued_at`,
      [req.params.id]
    );

    res.json({ data: { ...rRes.rows[0], jobs: jobsRes.rows } });
  } catch (err) {
    next(err);
  }
});

// ── Pause / resume / cancel ────────────────── (admin only)
for (const action of ['pause', 'resume', 'cancel']) {
  const fn = { pause: otaSvc.pauseRollout, resume: otaSvc.resumeRollout, cancel: otaSvc.cancelRollout }[action];
  router.post(`/rollouts/:id/${action}`, maybeAuthorize('admin'), async (req, res, next) => {
    try {
      // Resolve the service function at call time so a test may swap it
      const impl = { pause: otaSvc.pauseRollout, resume: otaSvc.resumeRollout, cancel: otaSvc.cancelRollout }[action] || fn;
      const result = await impl(req.tenantId, req.params.id);
      req.auditContext = { entityId: req.params.id, action: `rollout.${action}` };
      res.json({ data: result });
    } catch (err) {
      sendError(res, err, next);
    }
  });
}

module.exports = router;
