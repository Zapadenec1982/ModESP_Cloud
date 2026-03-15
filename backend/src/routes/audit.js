'use strict';

const { Router } = require('express');
const { z } = require('zod');
const db = require('../services/db');

const router = Router();

const querySchema = z.object({
  tenant_id: z.string().uuid().optional(),
  entity_type: z.string().max(32).optional(),
  action: z.string().max(64).optional(),
  user_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const { tenant_id, entity_type, action, user_id, from, to, page, limit } = parsed.data;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (tenant_id) { conditions.push(`tenant_id = $${idx++}`); params.push(tenant_id); }
  if (entity_type) { conditions.push(`entity_type = $${idx++}`); params.push(entity_type); }
  if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
  if (user_id) { conditions.push(`user_id = $${idx++}`); params.push(user_id); }
  if (from) { conditions.push(`created_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`created_at <= $${idx++}`); params.push(to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countSql = `SELECT COUNT(*)::int AS total FROM audit_log ${where}`;
  const dataSql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;

  params.push(limit, offset);

  const [countResult, dataResult] = await Promise.all([
    db.query(countSql, params.slice(0, params.length - 2)),
    db.query(dataSql, params),
  ]);

  res.json({
    data: dataResult.rows,
    meta: { total: countResult.rows[0].total, page, limit },
  });
});

module.exports = router;
