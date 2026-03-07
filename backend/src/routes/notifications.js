'use strict';

const { Router } = require('express');
const db = require('../services/db');
const pushSvc = require('../services/push');

const router = Router();

// ── GET /api/notifications/subscribers ─────────────────────
router.get('/subscribers', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const activeOnly = req.query.active !== 'false';

    const whereActive = activeOnly ? 'AND ns.active = true' : '';
    const { rows } = await db.query(
      `SELECT ns.id, ns.channel, ns.address, ns.label, ns.device_filter, ns.active, ns.created_at
       FROM notification_subscribers ns
       WHERE ns.tenant_id = $1 ${whereActive}
       ORDER BY ns.created_at DESC`,
      [tenantId]
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/notifications/subscribers ────────────────────
router.post('/subscribers', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { channel, address, label, device_filter } = req.body;

    // Validate
    if (!channel || !address) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'channel and address are required',
        status: 400,
      });
    }

    if (!['telegram', 'fcm'].includes(channel)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'channel must be "telegram" or "fcm"',
        status: 400,
      });
    }

    // Check for duplicate
    const existing = await db.query(
      `SELECT id, active FROM notification_subscribers
       WHERE tenant_id = $1 AND channel = $2 AND address = $3`,
      [tenantId, channel, address]
    );

    if (existing.rows.length > 0) {
      const sub = existing.rows[0];
      if (!sub.active) {
        // Re-activate existing subscriber
        await db.query(
          `UPDATE notification_subscribers
           SET active = true, label = COALESCE($1, label), device_filter = $2
           WHERE id = $3`,
          [label || null, device_filter || null, sub.id]
        );
        const { rows } = await db.query(
          'SELECT * FROM notification_subscribers WHERE id = $1',
          [sub.id]
        );
        return res.json({ data: rows[0] });
      }

      return res.status(409).json({
        error: 'duplicate',
        message: 'Subscriber with this channel and address already exists',
        status: 409,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO notification_subscribers (tenant_id, channel, address, label, device_filter)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, channel, address, label || null, device_filter || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/notifications/subscribers/:id ──────────────
router.delete('/subscribers/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const result = await db.query(
      `UPDATE notification_subscribers SET active = false
       WHERE id = $1 AND tenant_id = $2 AND active = true
       RETURNING id`,
      [id, tenantId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Subscriber not found',
        status: 404,
      });
    }

    res.json({ data: { id: result.rows[0].id, active: false } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/notifications/test ───────────────────────────
router.post('/test', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { subscriber_id } = req.body;

    if (!subscriber_id) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'subscriber_id is required',
        status: 400,
      });
    }

    const result = await pushSvc.testSend(tenantId, subscriber_id);
    res.json({ data: result });
  } catch (err) {
    if (err.message === 'Subscriber not found') {
      return res.status(404).json({ error: 'not_found', message: err.message, status: 404 });
    }
    next(err);
  }
});

// ── GET /api/notifications/log ─────────────────────────────
router.get('/log', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { rows } = await db.query(
      `SELECT nl.id, nl.channel, nl.device_id, nl.alarm_code, nl.status,
              nl.error_message, nl.created_at,
              ns.label AS subscriber_label, ns.address AS subscriber_address
       FROM notification_log nl
       LEFT JOIN notification_subscribers ns ON ns.id = nl.subscriber_id
       WHERE nl.tenant_id = $1
       ORDER BY nl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset]
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
