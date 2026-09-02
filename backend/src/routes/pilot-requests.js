'use strict';

/**
 * Pilot requests from the landing page — read side (plan epic 1.11).
 * The form itself posts to POST /api/public/pilot-request (routes/public.js);
 * this router lets the superadmin see the leads, e-mailed or not.
 */

const { Router } = require('express');
const db = require('../services/db');

const router = Router();

// GET /api/pilot-requests?limit=50&offset=0
router.get('/', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await db.query(
      `SELECT id, name, company, email, phone, segment, sites, message, source, lang, emailed_at, created_at,
              count(*) OVER()::int AS total
         FROM pilot_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]);
    res.json({ data: rows.map(({ total, ...r }) => r), meta: { total: rows[0] ? rows[0].total : 0, limit, offset } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
