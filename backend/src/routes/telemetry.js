'use strict';

const { Router } = require('express');
const db         = require('../services/db');
const { checkDeviceAccess } = require('../middleware/device-access');

const router = Router();

const MAX_RANGE_DAYS = 31;
const VALID_BUCKETS  = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };

// ── Helpers ──────────────────────────────────────────────

/**
 * Resolve device mqtt_device_id from UUID or short ID.
 * Returns null if not found.
 */
async function resolveDeviceId(id, tenantId) {
  const isUuid = id.length > 8;
  const where  = isUuid
    ? 'id = $1 AND tenant_id = $2'
    : 'mqtt_device_id = $1 AND tenant_id = $2';

  const { rows } = await db.query(
    `SELECT mqtt_device_id FROM devices WHERE ${where}`,
    [id, tenantId]
  );
  return rows.length > 0 ? rows[0].mqtt_device_id : null;
}

/**
 * Parse from/to or hours into { from: Date, to: Date }.
 */
function parseTimeRange(query) {
  let from, to;

  if (query.from && query.to) {
    from = new Date(query.from);
    to   = new Date(query.to);
    if (isNaN(from) || isNaN(to)) return null;
  } else {
    const hours = Math.min(parseInt(query.hours, 10) || 24, MAX_RANGE_DAYS * 24);
    to   = new Date();
    from = new Date(to.getTime() - hours * 3600 * 1000);
  }

  // Cap at max range
  const rangeMs = to - from;
  if (rangeMs > MAX_RANGE_DAYS * 86400 * 1000) {
    from = new Date(to.getTime() - MAX_RANGE_DAYS * 86400 * 1000);
  }

  return { from, to };
}

function parseChannels(query) {
  return query.channels
    ? query.channels.split(',').map(c => c.trim()).filter(Boolean)
    : null;
}

// ── GET /api/devices/:id/telemetry ──────────────────────
// Query params: hours (default 24) OR from+to (ISO), channels (comma-separated)

router.get('/:id/telemetry', checkDeviceAccess(), async (req, res, next) => {
  try {
    const mqttId = await resolveDeviceId(req.params.id, req.tenantId);
    if (!mqttId) {
      return res.status(404).json({
        error: 'not_found', message: `Device ${req.params.id} not found`, status: 404,
      });
    }

    const range = parseTimeRange(req.query);
    if (!range) {
      return res.status(400).json({
        error: 'validation_failed', message: 'Invalid from/to dates', status: 400,
      });
    }

    const channels = parseChannels(req.query);

    let sql = `
      SELECT time, channel, value
      FROM telemetry
      WHERE tenant_id = $1
        AND device_id = $2
        AND time >= $3
        AND time < $4
    `;
    const params = [req.tenantId, mqttId, range.from, range.to];

    if (channels && channels.length > 0) {
      sql += ` AND channel = ANY($5)`;
      params.push(channels);
    }

    const RAW_LIMIT = 10000;
    sql += ` ORDER BY time ASC LIMIT ${RAW_LIMIT + 1}`;

    const { rows } = await db.query(sql, params);
    const truncated = rows.length > RAW_LIMIT;
    if (truncated) rows.length = RAW_LIMIT;  // trim extra probe row
    if (truncated) res.set('X-Truncated', 'true');
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/:id/telemetry/stats ────────────────
// Aggregated min/max/avg per time bucket.
// Query params: from, to (or hours), channels, bucket (5m|15m|1h|6h|1d, default 1h)

router.get('/:id/telemetry/stats', checkDeviceAccess(), async (req, res, next) => {
  try {
    const mqttId = await resolveDeviceId(req.params.id, req.tenantId);
    if (!mqttId) {
      return res.status(404).json({
        error: 'not_found', message: `Device ${req.params.id} not found`, status: 404,
      });
    }

    const range = parseTimeRange(req.query);
    if (!range) {
      return res.status(400).json({
        error: 'validation_failed', message: 'Invalid from/to dates', status: 400,
      });
    }

    const channels = parseChannels(req.query);
    const bucketKey = req.query.bucket || '1h';
    const bucketSec = VALID_BUCKETS[bucketKey];

    if (!bucketSec) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Invalid bucket. Use: ${Object.keys(VALID_BUCKETS).join(', ')}`,
        status: 400,
      });
    }

    // Bucketed aggregation using epoch arithmetic
    const bucketExpr = `to_timestamp(floor(extract(epoch FROM time) / ${bucketSec}) * ${bucketSec})`;

    let sql = `
      SELECT
        ${bucketExpr} AS bucket,
        channel,
        MIN(value)   AS min,
        MAX(value)   AS max,
        AVG(value)   AS avg,
        COUNT(*)::int AS samples
      FROM telemetry
      WHERE tenant_id = $1
        AND device_id = $2
        AND time >= $3
        AND time < $4
    `;
    const params = [req.tenantId, mqttId, range.from, range.to];

    if (channels && channels.length > 0) {
      sql += ` AND channel = ANY($5)`;
      params.push(channels);
    }

    sql += ` GROUP BY bucket, channel ORDER BY bucket ASC, channel`;

    const { rows } = await db.query(sql, params);

    // Reshape into { buckets: [...], summary: {...} }
    const bucketMap = new Map();
    const summaryAcc = {};

    for (const row of rows) {
      const t = row.bucket.toISOString();
      if (!bucketMap.has(t)) bucketMap.set(t, { time: t });
      bucketMap.get(t)[row.channel] = {
        min: parseFloat(row.min),
        max: parseFloat(row.max),
        avg: parseFloat(parseFloat(row.avg).toFixed(2)),
        samples: row.samples,
      };

      // Accumulate for summary
      if (!summaryAcc[row.channel]) {
        summaryAcc[row.channel] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      }
      const acc = summaryAcc[row.channel];
      acc.min = Math.min(acc.min, parseFloat(row.min));
      acc.max = Math.max(acc.max, parseFloat(row.max));
      acc.sum += parseFloat(row.avg) * row.samples;
      acc.count += row.samples;
    }

    const summary = {};
    for (const [ch, acc] of Object.entries(summaryAcc)) {
      summary[ch] = {
        min: parseFloat(acc.min.toFixed(2)),
        max: parseFloat(acc.max.toFixed(2)),
        avg: parseFloat((acc.sum / acc.count).toFixed(2)),
      };
    }

    res.json({
      data: {
        buckets: [...bucketMap.values()],
        summary,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
