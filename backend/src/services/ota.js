'use strict';

/**
 * OTA: single deploys, batched rollouts, rollback and the pre-OTA checks
 * (plan epic 2.8 on top of Phase 6).
 *
 * A firmware is visible to an organisation when it owns it, or when it is a
 * platform firmware (tenant_id NULL) published to everyone or to that
 * organisation (firmware_visibility). Before a command goes out the device
 * must be online; unless the caller forces it, it must also be out of
 * defrost, without an active critical alarm and inside the organisation's
 * OTA window. A rollout defers such devices to later batches instead of
 * failing them, up to OTA_MAX_DEFERRALS.
 */

const db          = require('./db');
const mqttSvc     = require('./mqtt');
const firmwareUrl = require('./firmware-url');

const OTA_TIMEOUT_MS    = parseInt(process.env.OTA_TIMEOUT_MS, 10) || 600000; // 10 min
const CHECK_INTERVAL_MS = 30000; // 30 sec
const FIRMWARE_ORIGIN   = process.env.FIRMWARE_BASE_URL || 'http://localhost:3000';
const MAX_DEFERRALS     = Math.max(0, parseInt(process.env.OTA_MAX_DEFERRALS, 10) || 12);
// A rollout outside the OTA window polls at this cadence at most, whatever the batch interval
const WINDOW_POLL_S     = 300;

const SOFT_REASONS = ['defrost', 'critical_alarm', 'outside_window'];
const HARD_REASONS = ['offline'];

let logger   = null;
let checker  = null;                        // setInterval handle
const rolloutTimers = new Map();            // rolloutId → setTimeout handle
const log = () => logger || { info() {}, warn() {}, error() {}, debug() {} };

/** SQL predicate: firmware `alias` is visible to the organisation bound to `$param`. */
function visibleSql(alias, param) {
  return `(${alias}.tenant_id = ${param} OR (${alias}.tenant_id IS NULL AND (${alias}.visibility = 'all'
            OR EXISTS (SELECT 1 FROM firmware_visibility v WHERE v.firmware_id = ${alias}.id AND v.tenant_id = ${param}))))`;
}

const httpError = (status, code, message, extra) => Object.assign(new Error(message), { status, code, ...extra });

// ── Public API ────────────────────────────────────────────

function start(log_) {
  logger = log_;
  checker = setInterval(checkOtaStatus, CHECK_INTERVAL_MS);
  logger.info({ intervalMs: CHECK_INTERVAL_MS, maxDeferrals: MAX_DEFERRALS }, 'OTA status checker started');

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

// ── Lookups ───────────────────────────────────────────────

async function loadFirmware(tenantId, firmwareId) {
  const { rows } = await db.query(
    `SELECT f.* FROM firmwares f WHERE f.id = $2 AND ${visibleSql('f', '$1')}`, [tenantId, firmwareId]);
  if (rows.length === 0) throw httpError(404, 'firmware_not_found', 'Firmware not found');
  return rows[0];
}

async function loadDevice(tenantId, deviceId) {
  const { rows } = await db.query(
    `SELECT id, mqtt_device_id, model, online, last_state, firmware_version
       FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2 AND status = 'active'`,
    [tenantId, deviceId]);
  if (rows.length === 0) throw httpError(404, 'device_not_found', 'Device not found or not active');
  return rows[0];
}

function assertBoard(firmware, device) {
  if (firmware.board_type && device.model && firmware.board_type !== device.model) {
    throw httpError(400, 'board_mismatch', `Board mismatch: firmware targets "${firmware.board_type}", device is "${device.model}"`);
  }
  if (firmware.board_type && !device.model) {
    log().warn({ deviceId: device.mqtt_device_id, boardType: firmware.board_type }, 'Device has no model set — skipping board check');
  }
}

function actorOf(actor) {
  if (!actor) return { id: null, email: null };
  if (typeof actor === 'string') return { id: actor, email: null };
  return { id: actor.id || null, email: actor.email || null };
}

// ── OTA window ────────────────────────────────────────────

async function loadWindow(tenantId) {
  const { rows } = await db.query(
    `SELECT COALESCE(s.timezone, 'Europe/Kyiv') AS timezone, s.ota_window_from AS "from", s.ota_window_to AS "to"
       FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  const w = rows[0] || { timezone: 'Europe/Kyiv', from: null, to: null };
  return { timezone: w.timezone, from: w.from, to: w.to };
}

function localMinutes(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return h * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** true when the organisation allows OTA right now (no window = always). */
function inWindow(win, now = new Date()) {
  if (win.from == null || win.to == null || win.from === win.to) return true;
  const cur = localMinutes(win.timezone, now);
  return win.from < win.to ? (cur >= win.from && cur < win.to) : (cur >= win.from || cur < win.to);
}

// ── Pre-OTA checks ────────────────────────────────────────

/**
 * Why a device should not take an update right now.
 * @returns {Promise<{ reasons: string[], hard: string[], window: object }>}
 *   reasons — every failed check; hard — the ones `force` cannot override.
 */
async function precheck(tenantId, device, { force = false, window = null } = {}) {
  const reasons = [];
  const meta = mqttSvc.getDeviceMeta ? mqttSvc.getDeviceMeta(device.mqtt_device_id) : null;
  const online = meta && typeof meta.online === 'boolean' ? meta.online : !!device.online;
  if (!online) reasons.push('offline');

  const live = mqttSvc.getDeviceState ? mqttSvc.getDeviceState(device.mqtt_device_id) : null;
  const state = live || device.last_state || {};
  if (state['defrost.active'] === true || state['defrost.active'] === 'true') reasons.push('defrost');

  const { rows } = await db.query(
    `SELECT 1 FROM alarms WHERE tenant_id = $1 AND device_id = $2 AND active = true AND severity = 'critical' LIMIT 1`,
    [tenantId, device.mqtt_device_id]);
  if (rows.length > 0) reasons.push('critical_alarm');

  const win = window || await loadWindow(tenantId);
  if (!inWindow(win)) reasons.push('outside_window');

  const hard = reasons.filter(r => HARD_REASONS.includes(r));
  return { reasons: force ? hard : reasons, all: reasons, hard, window: win };
}

// ── Send OTA to a single device ──────────────────────────

async function sendOtaToDevice(tenantSlug, deviceId, firmware) {
  const url = FIRMWARE_ORIGIN + firmwareUrl.generateSignedUrl(firmware.filename, deviceId);
  const payload = {
    url,
    version:  firmware.version,
    checksum: firmware.checksum,
  };
  if (firmware.board_type) payload.board_type = firmware.board_type;

  // Use observed MQTT slug (where device actually publishes) with DB slug fallback
  const routingSlug = mqttSvc.getDeviceRoutingSlug(deviceId, tenantSlug);
  mqttSvc.sendJsonCommand(routingSlug, deviceId, '_ota', payload);
  log().info({ tenantSlug: routingSlug, deviceId, version: firmware.version }, 'OTA command sent');
}

// ── Deploy to a single device (no rollout) ───────────────

/**
 * @param actor  { id, email } of the person or key behind the request
 * @param opts   force — skip the soft checks (never `offline`); kind — deploy | rollback
 */
async function deploySingle(tenantId, tenantSlug, firmwareId, deviceId, actor, { force = false, kind = 'deploy' } = {}) {
  const firmware = await loadFirmware(tenantId, firmwareId);
  const device = await loadDevice(tenantId, deviceId);
  assertBoard(firmware, device);

  // Check no active OTA for this device
  const active = await db.query(
    `SELECT id FROM ota_jobs WHERE tenant_id = $1 AND device_id = $2 AND status IN ('queued', 'sent')`,
    [tenantId, deviceId]);
  if (active.rows.length > 0) throw httpError(409, 'ota_in_progress', 'Device already has an active OTA job');

  const check = await precheck(tenantId, device, { force });
  if (check.reasons.length > 0) {
    throw httpError(409, 'precheck_failed', `Device is not ready for an update: ${check.reasons.join(', ')}`,
      { reasons: check.reasons, forceable: check.reasons.every(r => SOFT_REASONS.includes(r)), window: check.window });
  }

  const who = actorOf(actor);
  const jobRes = await db.query(
    `INSERT INTO ota_jobs (tenant_id, firmware_id, firmware_version, device_id, status, sent_at, pre_ota_version, created_by, actor, kind, forced)
     VALUES ($1, $2, $3, $4, 'sent', NOW(), $5, $6, $7, $8, $9)
     RETURNING id, status, queued_at, sent_at`,
    [tenantId, firmware.id, firmware.version, deviceId, device.firmware_version || null, who.id, who.email, kind, force && check.all.length > 0]);

  await sendOtaToDevice(tenantSlug, deviceId, firmware);

  return {
    job_id:           jobRes.rows[0].id,
    device_id:        deviceId,
    firmware_version: firmware.version,
    status:           'sent',
    kind,
    forced:           force && check.all.length > 0,
    overridden:       force ? check.all : [],
  };
}

// ── Rollback ──────────────────────────────────────────────

/**
 * What a rollback would do: the version the device ran before its last
 * successful update and the visible firmware that carries it.
 */
async function rollbackTarget(tenantId, deviceId) {
  const device = await loadDevice(tenantId, deviceId);
  const { rows: jobs } = await db.query(
    `SELECT id, pre_ota_version, firmware_version, completed_at, kind FROM ota_jobs
      WHERE tenant_id = $1 AND device_id = $2 AND status = 'succeeded' AND pre_ota_version IS NOT NULL
      ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    [tenantId, deviceId]);
  const last = jobs[0] || null;
  const previous = last ? last.pre_ota_version : null;
  let firmware = null;
  if (previous) {
    const { rows } = await db.query(
      `SELECT f.id, f.version, f.board_type, f.tenant_id IS NULL AS global FROM firmwares f
        WHERE f.version = $2 AND ${visibleSql('f', '$1')}
          AND (f.board_type IS NULL OR $3::text IS NULL OR f.board_type = $3)
        ORDER BY (f.tenant_id IS NOT NULL) DESC, f.created_at DESC LIMIT 1`,
      [tenantId, previous, device.model || null]);
    firmware = rows[0] || null;
  }
  return {
    device_id: deviceId,
    current_version: device.firmware_version || null,
    previous_version: previous,
    last_update: last ? { job_id: last.id, version: last.firmware_version, completed_at: last.completed_at, kind: last.kind } : null,
    firmware,
    available: !!firmware && previous !== (device.firmware_version || null),
  };
}

async function rollback(tenantId, tenantSlug, deviceId, actor, { force = false } = {}) {
  const target = await rollbackTarget(tenantId, deviceId);
  if (!target.previous_version) throw httpError(404, 'rollback_unavailable', 'No successful update to roll back from');
  if (target.previous_version === target.current_version) {
    throw httpError(409, 'already_on_version', `Device already runs ${target.previous_version}`);
  }
  if (!target.firmware) {
    throw httpError(404, 'rollback_unavailable', `Firmware ${target.previous_version} is not in the library any more`, { previous_version: target.previous_version });
  }
  return deploySingle(tenantId, tenantSlug, target.firmware.id, deviceId, actor, { force, kind: 'rollback' });
}

// ── Create a rollout (group OTA) ─────────────────────────

async function createRollout(tenantId, tenantSlug, opts) {
  const { firmwareId, deviceIds, batchSize = 5, batchIntervalS = 300, failThresholdPct = 50, userId, actor } = opts;
  const firmware = await loadFirmware(tenantId, firmwareId);

  // Resolve device list
  let devRows;
  if (deviceIds && deviceIds.length > 0) {
    const placeholders = deviceIds.map((_, i) => `$${i + 2}`).join(',');
    const devRes = await db.query(
      `SELECT mqtt_device_id, model FROM devices
       WHERE tenant_id = $1 AND status = 'active' AND mqtt_device_id IN (${placeholders})`,
      [tenantId, ...deviceIds]
    );
    devRows = devRes.rows;
  } else {
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
      log().info({ boardType: firmware.board_type, skipped: skippedBoard }, 'Rollout: skipped incompatible devices');
    }
  }

  const devices = devRows.map(r => r.mqtt_device_id);

  if (devices.length === 0) {
    const msg = skippedBoard > 0
      ? `No compatible devices found (${skippedBoard} incompatible with board "${firmware.board_type}")`
      : 'No active devices found';
    throw httpError(400, 'no_devices', msg);
  }

  // Filter out devices with active OTA jobs
  const activeRes = await db.query(
    `SELECT DISTINCT device_id FROM ota_jobs WHERE tenant_id = $1 AND status IN ('queued', 'sent')`,
    [tenantId]
  );
  const activeSet = new Set(activeRes.rows.map(r => r.device_id));
  const eligible = devices.filter(d => !activeSet.has(d));

  if (eligible.length === 0) throw httpError(409, 'ota_in_progress', 'All devices already have active OTA jobs');

  const who = actorOf(actor || userId);
  const rolloutRes = await db.query(
    `INSERT INTO ota_rollouts (tenant_id, firmware_id, firmware_version, batch_size, batch_interval_s, fail_threshold_pct, status, total_devices, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8)
     RETURNING id`,
    [tenantId, firmware.id, firmware.version, batchSize, batchIntervalS, failThresholdPct, eligible.length, who.id]
  );
  const rolloutId = rolloutRes.rows[0].id;

  for (const devId of eligible) {
    await db.query(
      `INSERT INTO ota_jobs (tenant_id, firmware_id, firmware_version, device_id, rollout_id, status, created_by, actor)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)`,
      [tenantId, firmware.id, firmware.version, devId, rolloutId, who.id, who.email]
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
    fail_threshold_pct: failThresholdPct,
    status:           'running',
  };
}

// ── Process a rollout batch ──────────────────────────────

async function processRolloutBatch(rolloutId, tenantSlug) {
  const rRes = await db.query('SELECT * FROM ota_rollouts WHERE id = $1', [rolloutId]);
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

  // Failures the admin already accepted by resuming do not pause the rollout again
  if (completedCount > 0 && stats.failed > (rollout.acked_failures || 0)) {
    const failPct = Math.round((stats.failed / completedCount) * 100);
    if (failPct >= rollout.fail_threshold_pct) {
      const paused = await db.query(
        "UPDATE ota_rollouts SET status = 'paused', paused_reason = 'failures' WHERE id = $1 AND status = 'running' RETURNING id",
        [rolloutId]);
      log().warn({ rolloutId, failPct, threshold: rollout.fail_threshold_pct }, 'Rollout auto-paused due to high failure rate');
      if (paused.rows.length > 0) {
        await announce(rollout, 'paused', { ...stats, fail_pct: failPct, paused_reason: 'failures' });
      }
      return;
    }
  }

  // The firmware may have been deleted under a running rollout
  const fwRes = rollout.firmware_id
    ? await db.query('SELECT * FROM firmwares WHERE id = $1', [rollout.firmware_id])
    : { rows: [] };
  if (fwRes.rows.length === 0) {
    await db.query(
      "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = 'firmware_deleted' WHERE rollout_id = $1 AND status = 'queued'",
      [rolloutId]);
    log().warn({ rolloutId }, 'Rollout firmware is gone — queued jobs failed');
    await checkRolloutCompletion(rolloutId);
    return;
  }
  const firmware = fwRes.rows[0];

  // Resolve tenant slug if not provided
  if (!tenantSlug) {
    const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [rollout.tenant_id]);
    if (tRes.rows.length > 0) tenantSlug = tRes.rows[0].slug;
  }
  if (!tenantSlug) {
    log().error({ rolloutId }, 'Cannot resolve tenant slug for rollout');
    return;
  }

  // Outside the organisation's OTA window: hold the whole rollout, poll again later
  const window = await loadWindow(rollout.tenant_id);
  if (!inWindow(window)) {
    const queued = await db.query("SELECT COUNT(*)::int AS count FROM ota_jobs WHERE rollout_id = $1 AND status = 'queued'", [rolloutId]);
    if (queued.rows[0].count > 0) {
      log().info({ rolloutId, window }, 'Rollout waiting for the OTA window');
      scheduleNextBatch(rolloutId, tenantSlug, Math.min(rollout.batch_interval_s, WINDOW_POLL_S));
    } else {
      await checkRolloutCompletion(rolloutId);
    }
    return;
  }

  // Next batch of queued jobs, the least deferred first
  const batchRes = await db.query(
    `SELECT j.id, j.device_id, j.deferrals, d.id AS device_uuid, d.model, d.online, d.last_state, d.firmware_version
       FROM ota_jobs j
       LEFT JOIN devices d ON d.tenant_id = j.tenant_id AND d.mqtt_device_id = j.device_id
      WHERE j.rollout_id = $1 AND j.status = 'queued'
      ORDER BY j.queued_at
      LIMIT $2`,
    [rolloutId, rollout.batch_size]
  );

  if (batchRes.rows.length === 0) {
    await checkRolloutCompletion(rolloutId);
    return;
  }

  let sent = 0, deferred = 0;
  for (const job of batchRes.rows) {
    const device = { mqtt_device_id: job.device_id, model: job.model, online: job.online, last_state: job.last_state, firmware_version: job.firmware_version };
    const check = await precheck(rollout.tenant_id, device, { window });
    if (check.reasons.length > 0) {
      const reason = check.reasons.join(',');
      if (job.deferrals >= MAX_DEFERRALS) {
        await db.query(
          "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = $2 WHERE id = $1",
          [job.id, `precheck: ${reason}`]);
        log().warn({ rolloutId, jobId: job.id, deviceId: job.device_id, reason }, 'OTA job failed the pre-OTA checks too many times');
      } else {
        await db.query(
          "UPDATE ota_jobs SET deferrals = deferrals + 1, defer_reason = $2, queued_at = NOW() WHERE id = $1",
          [job.id, reason.slice(0, 32)]);
        deferred++;
      }
      continue;
    }
    try {
      await sendOtaToDevice(tenantSlug, job.device_id, firmware);
      await db.query(
        "UPDATE ota_jobs SET status = 'sent', sent_at = NOW(), pre_ota_version = $2, defer_reason = NULL WHERE id = $1",
        [job.id, job.firmware_version || null]);
      sent++;
    } catch (err) {
      log().error({ err, jobId: job.id, deviceId: job.device_id }, 'Failed to send OTA');
      await db.query(
        "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = $2 WHERE id = $1",
        [job.id, err.message]);
    }
  }

  log().info({ rolloutId, batchSent: sent, deferred }, 'Rollout batch processed');

  // Schedule next batch if there are more queued jobs
  const remaining = await db.query(
    "SELECT COUNT(*)::int AS count FROM ota_jobs WHERE rollout_id = $1 AND status = 'queued'",
    [rolloutId]
  );
  if (remaining.rows[0].count > 0) {
    scheduleNextBatch(rolloutId, tenantSlug, rollout.batch_interval_s);
  } else if (sent === 0) {
    await checkRolloutCompletion(rolloutId);
  }
}

function scheduleNextBatch(rolloutId, tenantSlug, intervalS) {
  if (rolloutTimers.has(rolloutId)) {
    clearTimeout(rolloutTimers.get(rolloutId));
  }
  const timer = setTimeout(() => {
    rolloutTimers.delete(rolloutId);
    processRolloutBatch(rolloutId, tenantSlug).catch(err =>
      log().error({ err, rolloutId }, 'Failed to process rollout batch'));
  }, intervalS * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  rolloutTimers.set(rolloutId, timer);
  log().info({ rolloutId, nextBatchInS: intervalS }, 'Next batch scheduled');
}

// ── Periodic status checker ──────────────────────────────

async function checkOtaStatus() {
  try {
    const sentJobs = await db.query(
      `SELECT j.id, j.tenant_id, j.firmware_id, j.device_id, j.sent_at, j.rollout_id,
              j.pre_ota_version,
              j.firmware_version AS target_version,
              d.firmware_version AS current_version
       FROM ota_jobs j
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
        log().info({
          jobId: job.id, deviceId: job.device_id,
          target: job.target_version, current: job.current_version,
          preOta: job.pre_ota_version, reason: exactMatch ? 'version_match' : 'version_changed',
        }, 'OTA succeeded');
        if (job.rollout_id) rolloutIds.add(job.rollout_id);
        continue;
      }

      const sentAt = new Date(job.sent_at).getTime();
      if (now - sentAt > OTA_TIMEOUT_MS) {
        await db.query(
          "UPDATE ota_jobs SET status = 'failed', completed_at = NOW(), error = 'timeout' WHERE id = $1",
          [job.id]
        );
        log().warn({ jobId: job.id, deviceId: job.device_id, timeoutMs: OTA_TIMEOUT_MS }, 'OTA timed out');
        if (job.rollout_id) rolloutIds.add(job.rollout_id);
      }
    }

    for (const rid of rolloutIds) {
      await checkRolloutCompletion(rid);
    }
  } catch (err) {
    log().error({ err }, 'OTA status check failed');
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

  if (s.queued === 0 && s.sent === 0) {
    const { rows } = await db.query(
      "UPDATE ota_rollouts SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'running' RETURNING *",
      [rolloutId]
    );
    if (rows.length > 0) {
      log().info({ rolloutId, succeeded: s.succeeded, failed: s.failed }, 'Rollout completed');
      const completed = s.succeeded + s.failed;
      await announce(rows[0], 'completed', { ...s, fail_pct: completed ? Math.round((s.failed / completed) * 100) : 0 });
    }
  }
}

/**
 * A rollout completed or paused itself: tell the organisation's admins
 * (push channels) and the webhooks (`ota.rollout_*`). Never throws.
 */
async function announce(rollout, event, stats) {
  const evt = {
    tenantId: rollout.tenant_id,
    rolloutId: rollout.id,
    event,
    firmwareVersion: rollout.firmware_version || null,
    total: rollout.total_devices,
    succeeded: stats.succeeded || 0,
    failed: stats.failed || 0,
    failPct: stats.fail_pct || 0,
    threshold: rollout.fail_threshold_pct,
    pausedReason: stats.paused_reason || null,
  };
  try {
    mqttSvc.emit('rollout', evt);
  } catch (err) {
    log().error({ err, rolloutId: rollout.id }, 'Rollout event emit failed');
  }
  try {
    // Lazy: push.js requires nothing of ota.js, but keep the dependency one-way at load time
    const pushSvc = require('./push');
    if (typeof pushSvc.notifyRollout === 'function') await pushSvc.notifyRollout(evt);
  } catch (err) {
    log().error({ err, rolloutId: rollout.id }, 'Rollout notification failed');
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
    const queued = await db.query(
      "SELECT COUNT(*)::int AS count FROM ota_jobs WHERE rollout_id = $1 AND status = 'queued'",
      [row.id]
    );
    if (queued.rows[0].count > 0) {
      log().info({ rolloutId: row.id }, 'Resuming running rollout');
      processRolloutBatch(row.id, row.tenant_slug).catch(err =>
        log().error({ err, rolloutId: row.id }, 'Failed to resume rollout'));
    }
  }
}

// ── Pause / Resume / Cancel ──────────────────────────────

async function pauseRollout(tenantId, rolloutId) {
  const res = await db.query(
    "UPDATE ota_rollouts SET status = 'paused', paused_reason = 'manual' WHERE id = $1 AND tenant_id = $2 AND status = 'running' RETURNING id",
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw httpError(404, 'rollout_not_found', 'Rollout not found or not running');

  if (rolloutTimers.has(rolloutId)) {
    clearTimeout(rolloutTimers.get(rolloutId));
    rolloutTimers.delete(rolloutId);
  }

  return { status: 'paused' };
}

async function resumeRollout(tenantId, rolloutId) {
  // Resuming accepts the failures so far; the threshold watches new ones
  const res = await db.query(
    `UPDATE ota_rollouts r SET status = 'running', paused_reason = NULL,
            acked_failures = (SELECT COUNT(*)::int FROM ota_jobs j WHERE j.rollout_id = r.id AND j.status = 'failed')
      WHERE r.id = $1 AND r.tenant_id = $2 AND r.status = 'paused' RETURNING r.id`,
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw httpError(404, 'rollout_not_found', 'Rollout not found or not paused');

  const tRes = await db.query('SELECT slug FROM tenants WHERE id = $1', [tenantId]);
  const tenantSlug = tRes.rows[0]?.slug;

  await processRolloutBatch(rolloutId, tenantSlug);

  return { status: 'running' };
}

async function cancelRollout(tenantId, rolloutId) {
  const res = await db.query(
    "UPDATE ota_rollouts SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status IN ('running', 'paused') RETURNING id",
    [rolloutId, tenantId]
  );
  if (res.rows.length === 0) throw httpError(404, 'rollout_not_found', 'Rollout not found or already completed');

  await db.query(
    "UPDATE ota_jobs SET status = 'cancelled', completed_at = NOW() WHERE rollout_id = $1 AND status = 'queued'",
    [rolloutId]
  );

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
  rollback,
  rollbackTarget,
  createRollout,
  pauseRollout,
  resumeRollout,
  cancelRollout,
  precheck,
  visibleSql,
  SOFT_REASONS,
  HARD_REASONS,
  MAX_DEFERRALS,
  __test: { checkOtaStatus, processRolloutBatch, checkRolloutCompletion, inWindow, localMinutes, loadWindow },
};
