'use strict';

/**
 * GET /api/health          public — liveness for the external probe
 * GET /api/health/details  superadmin — the numbers behind the checks
 *
 * The public body stays categorical on purpose: an uptime monitor keys on
 * "status":"ok" (API, DB, broker) and on "platform":"ok" (backup age, partition
 * headroom, disk), while the details endpoint carries ages, sizes, broker client
 * counts and per-channel delivery health for the founder's own eyes.
 */

const express     = require('express');
const db          = require('../services/db');
const mqttSvc     = require('../services/mqtt');
const pushSvc     = require('../services/push');
const telegramSvc = require('../services/telegram');
const platform    = require('../services/platform-health');
const { authenticate, requireSuperadmin } = require('../middleware/auth');
const pkg = require('../../package.json');

const router = express.Router();
const STARTED_AT = new Date().toISOString();

router.get('/', async (_req, res) => {
  const dbOk   = await db.healthy();
  const mqttOk = mqttSvc.isConnected();
  const status = dbOk && mqttOk ? 'ok' : 'degraded';

  let checks = null;
  try { checks = await platform.collect(); } catch { /* reported as unknown */ }
  const summary = platform.summarize(checks);

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    db:       dbOk   ? 'ok' : 'error',
    mqtt:     mqttOk ? 'ok' : 'error',
    uptime:   Math.floor(process.uptime()),
    platform: summary.platform,
    checks:   summary.checks,
  });
});

router.get('/details', authenticate, requireSuperadmin, async (_req, res) => {
  const [dbOk, checks] = await Promise.all([db.healthy(), platform.collect({ fresh: true })]);
  const mem = process.memoryUsage();
  res.json({
    data: {
      version:    pkg.version,
      node:       process.version,
      started_at: STARTED_AT,
      uptime_s:   Math.floor(process.uptime()),
      memory:     { rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed },
      db:         { ok: dbOk },
      mqtt:       { connected: mqttSvc.isConnected(), broker: mqttSvc.getBrokerStats() },
      backup:     checks.backup,
      partitions: checks.partitions,
      disk:       checks.disk,
      channels:   { ...pushSvc.channelHealth(), telegram_bot: telegramSvc.health() },
    },
  });
});

module.exports = router;
