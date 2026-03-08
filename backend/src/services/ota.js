'use strict';

const db      = require('./db');
const mqttSvc = require('./mqtt');

const OTA_TIMEOUT_MS    = parseInt(process.env.OTA_TIMEOUT_MS, 10) || 600000; // 10 min
const CHECK_INTERVAL_MS = 30000; // 30 sec
const FIRMWARE_BASE_URL = process.env.FIRMWARE_BASE_URL || 'http://localhost:3000/firmware';

let logger   = null;
let checker  = null;                        // setInterval handle
const rolloutTimers = new Map();            // rolloutId → setTimeout handle

// ── Public API ────────────────────────────────────────────

function start(log) {
  logger = log;
  checker = setInterval(checkOtaStatus, CHECK_INTERVAL_MS);
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, 'OTA status checker started');

  // Resume any running rollouts that have queued jobs (server restart recovery)
  resumeRunningRollouts().catch(err =>
    logger.error({ err }, 'Failed to resume rollouts on startup'));
}

function shutdown() {
  if (checker) { clearInterval(checker); checker = null; }
  for (const [id, timer] of rolloutTimers) {
    clearTimeout(timer);
    rolloutTimers.delete(id);
  }
  if (logger) logger.info('OTA service stopped');
}

// ── Send OTA to a single device ──────────────────────────

async function sendOtaToDevice(tenantSlug, deviceId, firmware) {
  const url = `${FIRMWARE_BASE_URL}/${firmware.filename}`;
  const payload = {
    url,
    version:  firmware.version,
    checksum: firmware.checksum,
  };
  if (firmware.board_type) payload.board_type = firmware.board_type;

  // Use observed MQTT slug (where device actually publishes) with DB slug fallback
  const routingSlug = mqttSvc.getDeviceRoutingSlug(deviceId, tenantSlug);
  mqttSvc.sendJsonCommand(routingSlug, deviceId, '_ota', payload);
  logger.info({ tenantSlug: routingSlug, deviceId, version: firmware.version }, 'OTA command sent');
}

// ── Deploy to a single device (no rollout) ───────────────

async function deploySingle(tenantId, tenantSlug, firmwareId, deviceId, userId) {
  // Get firmware
  const fwRes = await db.query(
    'SELECT * FROM firmwares WHERE tenant_id = $1 AND id = $2',
    [tenantId, firmwareId]
  );
  if (fwRes.rows.length === 0) throw Object.assign(new Error('Firmware not found'), { status: 404 });
  const firmware = fwRes.rows[0];

  // Check device exists and is active
  const devRes = await db.query(
    "SELECT mqtt_device_id, model FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2 AND status = 'active'",
    [tenantId, deviceId]
  );
  if (devRes.rows.length === 0) throw Object.assign(new Error('Device not found or not active'), { status: 404 });
  const device = devRes.rows[0];

  // Board compatibility check
  if (firmware.board_type && device.model && firmware.board_type !== device.model) {
    throw Object.assign(
      new Error(`Board mismatch: firmware targets "${firmware.board_type}", device is "${device.model}"`),
      { status: 400 }
    );
  }
  if (firmware.board_type && !device.model) {
    logger.warn({ deviceId, boardType: firmware.board_type }, 'Device has no model set — skipping board check');
  }

  // Check no active OTA for this device
  const active = await db.query(
    `SELECT id FROM ota_jobs
     WHERE tenant_id = $1 AND device_id = $2 AND status IN ('queued', 'sent')`,
    [tenantId, deviceId]
  );
  if (active.rows.length > 0) throw Object.assign(new Error('Device already has an active OTA job'), { status: 409 });

  // Capture pre-OTA firmware version for change detection
  const preVersionRes = await db.query(
    'SELECT firmware_version FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2',
    [tenantId, deviceId]
  );
  const preOtaVersion = preVersionRes.rows[0]?.firmware_version || null;

  // Create job (store pre_ota_version for robust success detection)
  const jobRes = await db.query(
    `INSERT INTO ota_jobs (tenant_id, firmware_id, device_id, status, sent_at, pre_ota_version)
     VALUES ($1, $2, $3, 'sent', NOW(), $4)
     RETURNING id, status, queued_at, sent_at`,
    [tenantId, firmwareId, deviceId, preOtaVersion]
  );

  // Send MQTT command
  await sendOtaToDevice(tenantSlug, deviceId, firmware);

  return {
    job_id:           jobRes.rows[0].id,
    device_id:        deviceId,
    firmware_version: firmware.version,
    status:           'sent',
  };
}

// ── Create a rollout (group OTA) ─────────────────────────

async function createRollout(tenantId, tenantSlug, opts) {
  const { firmwareId, deviceIds, batchSize = 5, batchIntervalS = 300, failThresholdPct = 50, userId } = opts;

  // Get firmware
  const fwRes = await db.query(
    'SELECT * FROM firmwares WHERE tenant_id = $1 AND id = $2',
    [tenantId, firmwareId]
  );
  if (fwRes.rows.length === 0) throw Object.assign(new Error('Firmware not found'), { status: 404 });

  // Resolve device list
  const firmware = fwRes.rows[0];
  let devRows;
  if (deviceIds && deviceIds.length > 0) {
    const placeholders = deviceIds.map((_, i) => `$${i + 3}`).join(',');
    const devRes = await db.query(
      `SELECT mqtt_device_id, model FROM devices
       WHERE tenant_id = $1 AND status = 'active' AND mqtt_device_id IN (${placeholders})`,
      [tenantId, 'active', ...deviceIds]
    );
    devRows = devRes.rows;
  } else {
    // All active devices
    const devRes = await db.query(
      "SELECT mqtt_device_id, model FROM devices WHERE tenant_id = $1 AND status = 'active'",
      [tenantId]
    );
    devRows = devRes.rows;
  }

  // Board compatibility filter
  let skippedBoard = 0;
  if (firmware.board_type) {
    const before = devRows.length;
    devRows = devRows.filter(d => !d.model || d.model === firmware.board_type);
    skippedBoard = before - devRows.length;
    if (skippedBoard > 0) {
      logger.info({ boardType: firmware.board_type, skipped: skippedBoard },
        'Rollout: skipped incompatible devices');
    }
  }

  const devices = devRows.map(r => r.mqtt_device_id);

  if (devices.length === 0) {
    const msg = skippedBoard > 0
      ? `No compatible devices found (${skippedBoard} incompatible with board "${firmware.board_type}")`
      : 'No active devices found';
    throw Object.assign(new Error(msg), { status: 400 });
  }

  // Filter out devices with active OTA jobs
  const activeRes = await db.query(
    `SELECT DISTINCT device_id FROM ota_jobs
     WHERE tenant_id = $1 AND status IN ('queued', 'sent')`,
    [tenantId]
  );
  const activeSet = new Set(activeRes.rows.map(r => r.device_id));
  const eligible = devices.filter(d => !activeSet.has(d));

  if (eligible.length === 0) throw Object.assign(new Error('All devices already have active OTA jobs'), { status: 409 });

  // Create rollout
  const rolloutRes = await db.query(
    `INSERT INTO ota_rollouts (tenant_id, firmware_id, batch_size, batch_interval_s, fail_threshold_pct, status, total_devices, created_by)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7)
     RETURNING id`,
    [tenantId, firmwareId, batchSize, batchIntervalS, failThresholdPct, eligible.length, userId || null]
  );
  const rolloutId = rolloutRes.rows[0].id;

  // Create jobs for each device
  for (const devId of eligible) {
    await db.query(
      `INSERT INTO ota_jobs (tenant_id, firmware_id, device_id, rollout_id, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [tenantId, firmwareId, devId, rolloutId]
    );
  }

  // Process first batch immediately
  await processRolloutBatch(rolloutId, tenantSlug);

  return {
    rollout_id:       rolloutId,
    firmware_version: firmware.version,
    total_devices:    eligible.length,
    skipped_incompatible: skippedBoard,
    batch_size:       batchSize,
    batch_interval_s: batchIntervalS,
    status:           'running',
  };
}

// ── Process a rollout batch ──────────────────────────────

async function processRolloutBatch(rolloutId, tenantSlug) {
  // Get rollout
  const rRes = await db.query(
    'SELECT * FROM ota_rollouts WHERE id = $1',
    [rolloutId]
  );
  if (rRes.rows.length === 0) return;
  const rollout = rRes.rows[0];

  if (rollout.status !== 'running') return;

  // Check fail threshold
  const statsRes = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
       COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
       COUNT(*)::int AS total
     FROM ota_jobs WHERE rollout_id = $1`,
    [rolloutId]
  );
  const stats = statsRes.rows[0];
  const completedCount = stats.failed + stats.succeeded;

  if (completedCount > 0 && stats.failed > 0) {
    const failPct = Math.round((stats.failed / completedCount) * 100);
    if (failPct >= rollout.fail_threshold_pct) {
      // Auto-pause
      await db.query(
        "UPDATE ota_rollouts SET status = 'paused' WHERE id = $1",
        [rolloutId]
      );
      logger.warn({ rolloutId, failPct, threshold: rollout.fail_threshold_pct },
        'Rollout auto-paused due to high failure rate');
      return;
    }
  }

  // Get firmware for this rollout
  const fwRes = await db.query(
    'SELECT * FROM firmwares WHERE id = $1',
    [rollout.firmware_id]
  );
  if (fwRes.rows.length === 0) return;
  const firmware = fwRes.rows[0];

  // Resolve tenant slug if not provided
  if (!tenantSlug) {
    const tRes = await db.query(
      'SELECT slug FROM tenants WHERE id = $1',
      [rollout.tenant_id]
    );
    if (tRes.rows.length > 0) tenantSlug = tRes.rows[0].slug;
  }
  if (!tenantSlug) {
    logger.error({ rolloutId }, 'Cannot resolve tenant slug for rollout');
    return;
  }

  // Get next batch of queued jobs
  const batchRes = await db.query(
    `SELECT id, device_id FROM ota_jobs
     WHERE rollout_id = $1 AND status = 'queued'
     ORDER BY queued_at
     LIMIT $2`,
    [rolloutId, rollout.batch_size]
  );

  if (batchRes.rows.length === 0) {
    // No more queued jobs — check if rollout is complete
    await checkRolloutCompletion(rolloutId);
    return;
  }

  // Send OTA to each device in batch
  for (const job of batchRes.rows) {
    try {
      await sendOtaToDevice(tenantSlug, job.device_id, firmware);
      await db.query(
        "UPDATE ota_jobs SET status = 'sent', sent_at = NOW() WHERE id = $1",
        [job.id]
      );
    } catch (err) {
      logger.error({ err, jobId: job.id, deviceId: job.device_id }, 'Failed to send OTA');
      await db.query(
        "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = $2 WHERE id = $1",
        [job.id, err.message]
      );
    }
  }

  logger.info({ rolloutId, batchSent: batchRes.rows.length }, 'Rollout batch sent');

  // Schedule next batch if there are more queued jobs
  const remaining = await db.query(
    "SELECT COUNT(*)::int AS count FROM ota_jobs WHERE rollout_id = $1 AND status = 'queued'",
    [rolloutId]
  );
  if (remaining.rows[0].count > 0) {
    scheduleNextBatch(rolloutId, tenantSlug, rollout.batch_interval_s);
  }
}

function scheduleNextBatch(rolloutId, tenantSlug, intervalS) {
  // Clear existing timer if any
  if (rolloutTimers.has(rolloutId)) {
    clearTimeout(rolloutTimers.get(rolloutId));
  }
  const timer = setTimeout(() => {
    rolloutTimers.delete(rolloutId);
    processRolloutBatch(rolloutId, tenantSlug).catch(err =>
      logger.error({ err, rolloutId }, 'Failed to process rollout batch'));
  }, intervalS * 1000);

  rolloutTimers.set(rolloutId, timer);
  logger.info({ rolloutId, nextBatchInS: intervalS }, 'Next batch scheduled');
}

// ── Periodic status checker ──────────────────────────────

async function checkOtaStatus() {
  try {
    // Find all 'sent' jobs
    const sentJobs = await db.query(
      `SELECT j.id, j.tenant_id, j.firmware_id, j.device_id, j.sent_at, j.rollout_id,
              j.pre_ota_version,
              f.version AS target_version,
              d.firmware_version AS current_version
       FROM ota_jobs j
       JOIN firmwares f ON f.id = j.firmware_id
       LEFT JOIN devices d ON d.tenant_id = j.tenant_id AND d.mqtt_device_id = j.device_id
       WHERE j.status = 'sent'`
    );

    if (sentJobs.rows.length === 0) return;

    const now = Date.now();
    const rolloutIds = new Set();

    for (const job of sentJobs.rows) {
      // Success detection: exact version match OR firmware changed from pre-OTA version
      // (handles git-hash vs semver mismatch during transition)
      const exactMatch = job.current_version && job.current_version === job.target_version;
      const versionChanged = job.current_version
        && job.pre_ota_version
        && job.current_version !== job.pre_ota_version;

      if (exactMatch || versionChanged) {
        await db.query(
          "UPDATE ota_jobs SET status = 'succeeded', completed_at = NOW() WHERE id = $1",
          [job.id]
        );
        logger.info({
          jobId: job.id, deviceId: job.device_id,
          target: job.target_version, current: job.current_version,
          preOta: job.pre_ota_version, reason: exactMatch ? 'version_match' : 'version_changed',
        }, 'OTA succeeded');
        if (job.rollout_id) rolloutIds.add(job.rollout_id);
        continue;
      }

      // Check timeout
      const sentAt = new Date(job.sent_at).getTime();
      if (now - sentAt > OTA_TIMEOUT_MS) {
        await db.query(
          "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = 'timeout' WHERE id = $1",
          [job.id]
        );
        logger.warn({ jobId: job.id, deviceId: job.device_id, timeoutMs: OTA_TIMEOUT_MS },
          'OTA timed out');
        if (job.rollout_id) rolloutIds.add(job.rollout_id);
      }
    }

    // Check completion for affected rollouts
    for (const rid of rolloutIds) {
      await checkRolloutCompletion(rid);
    }
  } catch (err) {
    if (logger) logger.error({ err }, 'OTA status check failed');
  }
}

// ── Rollout completion check ─────────────────────────────

async function checkRolloutCompletion(rolloutId) {
  const statsRes = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::int    AS queued,
       COUNT(*) FILTER (WHERE status = 'sent')::int      AS sent,
       COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
       COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
       COUNT(*)::int AS total
     FROM ota_jobs WHERE rollout_id = $1`,
    [rolloutId]
  );
  const s = statsRes.rows[0];

  // If no active jobs remain
  if (s.queued === 0 && s.sent === 0) {
    await db.query(
      "UPDATE ota_rollouts SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'running'",
      [rolloutId]
    );
    logger.info({ rolloutId, succeeded: s.succeeded, failed: s.failed }, 'Rollout completed');
  }
}

// ── Resume rollouts on server restart ────────────────────

async function resumeRunningRollouts() {
  const res = await db.query(
    `SELECT r.id, t.slug AS tenant_slug
     FROM ota_rollouts r
     JOIN tenants t ON t.id = r.tenant_id
     WHERE r.status = 'running'`
  );
  for (const row of res.rows) {
    // Check if there are queued jobs to process
    const queued = await db.query(
      "SELECT COUNT(*)::int AS count FROM ota_jobs WHERE rollout_id = $1 AND status = 'queued'",
      [row.id]
    );
    if (queued.rows[0].count > 0) {
      logger.info({ rolloutId: row.id }, 'Resuming running rollout');
      processRolloutBatch(row.id, row.tenant_slug).catch(err =>
        logger.error({ err, rolloutId: row.id }, 'Failed to resume rollout'));
    }
  }
}

// ── Pause / Resume / Cancel ──────────────────────────────

async function pauseRollout(tenantId, rolloutId) {
  const res = await db.query(
    "UPDATE ota_rollouts SET status = 'paused' WHERE id = $1 AND tenant_id = $2 AND status = 'running' RETURNING id",
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw Object.assign(new Error('Rollout not found or not running'), { status: 404 });

  // Clear scheduled batch timer
  if (rolloutTimers.has(rolloutId)) {
    clearTimeout(rolloutTimers.get(rolloutId));
    rolloutTimers.delete(rolloutId);
  }

  return { status: 'paused' };
}

async function resumeRollout(tenantId, rolloutId) {
  const res = await db.query(
    "UPDATE ota_rollouts SET status = 'running' WHERE id = $1 AND tenant_id = $2 AND status = 'paused' RETURNING id",
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw Object.assign(new Error('Rollout not found or not paused'), { status: 404 });

  // Resolve tenant slug
  const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [tenantId]);
  const tenantSlug = tRes.rows[0]?.slug;

  // Process next batch
  await processRolloutBatch(rolloutId, tenantSlug);

  return { status: 'running' };
}

async function cancelRollout(tenantId, rolloutId) {
  const res = await db.query(
    "UPDATE ota_rollouts SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status IN ('running', 'paused') RETURNING id",
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw Object.assign(new Error('Rollout not found or already completed'), { status: 404 });

  // Cancel queued jobs
  await db.query(
    "UPDATE ota_jobs SET status = 'cancelled', completed_at = NOW() WHERE rollout_id = $1 AND status = 'queued'",
    [rolloutId]
  );

  // Clear timer
  if (rolloutTimers.has(rolloutId)) {
    clearTimeout(rolloutTimers.get(rolloutId));
    rolloutTimers.delete(rolloutId);
  }

  return { status: 'cancelled' };
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  start,
  shutdown,
  deploySingle,
  createRollout,
  pauseRollout,
  resumeRollout,
  cancelRollout,
};
