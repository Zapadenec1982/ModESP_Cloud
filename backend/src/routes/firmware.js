'use strict';

/**
 * Firmware library (Phase 6, plan epic 2.8).
 *   POST   /firmware/upload   own firmware (admin) or, with global=true, a
 *                             platform firmware for every organisation or the
 *                             selected ones (superadmin)
 *   GET    /firmware          what this organisation may deploy: its own plus
 *                             the platform firmwares published to it
 *   GET    /firmware/:id
 *   PATCH  /firmware/:id      notes; visibility and tenant_ids of a platform firmware (superadmin)
 *   DELETE /firmware/:id      refused while an OTA job or rollout is still
 *                             using it; finished history keeps the version
 */

const { Router }   = require('express');
const multer       = require('multer');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const { z }        = require('zod');
const db           = require('../services/db');
const { authorize } = require('../middleware/auth');
const { visibleSql } = require('../services/ota');
const { isUuidFormat } = require('../lib/ids');

const router = Router();
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const maybeAuthorize = (...roles) =>
  AUTH_ENABLED ? authorize(...roles) : (_req, _res, next) => next();

// Viewers never reach the library; technicians read it to deploy
router.use(maybeAuthorize('admin', 'technician'));

// ── Firmware storage ──────────────────────────────────────
const FIRMWARE_DIR = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../../firmware');

if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.bin') {
      return cb(new Error('Only .bin firmware files are accepted'));
    }
    cb(null, true);
  },
});

const isSuperadmin = (req) => !!req.user && req.user.role === 'superadmin';
const notFound = (res) => res.status(404).json({ error: 'firmware_not_found', message: 'Firmware not found', status: 404 });

const COLUMNS = `f.id, f.tenant_id, f.tenant_id IS NULL AS global, f.visibility, f.version, f.filename, f.original_name,
                 f.size_bytes, f.checksum, f.notes, f.board_type, f.created_at, f.uploaded_by, u.email AS uploaded_by_email,
                 (SELECT COUNT(*)::int FROM ota_jobs j WHERE j.firmware_id = f.id) AS job_count,
                 (SELECT COUNT(*)::int FROM ota_jobs j WHERE j.firmware_id = f.id AND j.status IN ('queued', 'sent')) AS active_job_count,
                 (SELECT COUNT(*)::int FROM firmware_visibility v WHERE v.firmware_id = f.id) AS visible_to_count`;

/** Own firmwares plus the platform ones published to this organisation; a superadmin also sees every platform firmware. */
function scopeSql(req) {
  return isSuperadmin(req) ? `(f.tenant_id = $1 OR f.tenant_id IS NULL)` : visibleSql('f', '$1');
}

function parseTenantIds(raw) {
  if (raw == null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = raw.split(/[\s,;]+/); }
  }
  if (!Array.isArray(list)) return null;
  const ids = [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
  return ids.every(isUuidFormat) ? ids : null;
}

async function replaceVisibility(client, firmwareId, tenantIds, grantedBy) {
  await client.query('DELETE FROM firmware_visibility WHERE firmware_id = $1', [firmwareId]);
  for (const tid of tenantIds) {
    await client.query(
      `INSERT INTO firmware_visibility (firmware_id, tenant_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [firmwareId, tid, grantedBy]);
  }
}

async function fetchOne(req, id) {
  if (!isUuidFormat(id)) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM firmwares f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.id = $2 AND ${scopeSql(req)}`,
    [req.tenantId, id]);
  return rows[0] || null;
}

async function withVisibleTo(req, fw) {
  if (!fw || !fw.global || !isSuperadmin(req)) return fw;
  const { rows } = await db.query(
    `SELECT v.tenant_id, t.name, t.slug FROM firmware_visibility v JOIN tenants t ON t.id = v.tenant_id WHERE v.firmware_id = $1 ORDER BY t.name`,
    [fw.id]);
  return { ...fw, visible_to: rows };
}

// ── POST /api/firmware/upload ───────────────── (admin; global: superadmin)
router.post('/upload', maybeAuthorize('admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Firmware .bin file is required', status: 400 });
    }

    const { version, notes, board_type } = req.body || {};
    const global = ['true', '1', 'yes'].includes(String(req.body?.global || '').toLowerCase());
    const visibility = req.body?.visibility === 'selected' ? 'selected' : 'all';
    const tenantIds = parseTenantIds(req.body?.tenant_ids);

    if (!version || !version.trim()) {
      return res.status(400).json({ error: 'missing_version', message: 'Firmware version is required', status: 400 });
    }
    if (global && !isSuperadmin(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only a superadmin uploads platform firmware', status: 403 });
    }
    if (tenantIds === null) {
      return res.status(400).json({ error: 'validation_failed', message: 'tenant_ids must be a list of organisation ids', status: 400 });
    }

    const ownerId = global ? null : req.tenantId;
    const dup = await db.query(
      global ? 'SELECT id FROM firmwares WHERE tenant_id IS NULL AND version = $1'
             : 'SELECT id FROM firmwares WHERE tenant_id = $2 AND version = $1',
      global ? [version.trim()] : [version.trim(), ownerId]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'duplicate_version', message: `Firmware version '${version.trim()}' already exists`, status: 409 });
    }

    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const checksum = `sha256:${hash}`;

    const safeVersion = version.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${global ? 'global' : req.tenantId}_${safeVersion}_${Date.now()}.bin`;
    fs.writeFileSync(path.join(FIRMWARE_DIR, filename), req.file.buffer);

    const boardType = board_type?.trim() || null;
    const id = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO firmwares (tenant_id, version, filename, original_name, size_bytes, checksum, notes, uploaded_by, board_type, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [ownerId, version.trim(), filename, req.file.originalname, req.file.size, checksum, notes || null,
          req.user?.id || req.userId || null, boardType, global ? visibility : 'all']
      );
      if (global && visibility === 'selected') await replaceVisibility(client, rows[0].id, tenantIds, req.user?.id || null);
      return rows[0].id;
    });

    req.auditContext = { entityId: id, changes: { version: version.trim(), filename: req.file.originalname, size: req.file.size, global, visibility: global ? visibility : undefined, tenant_ids: global && visibility === 'selected' ? tenantIds : undefined } };
    res.status(201).json({ data: await withVisibleTo(req, await fetchOne(req, id)) });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'file_too_large', message: 'Firmware file must be ≤ 4MB', status: 400 });
    }
    if (err.message && err.message.includes('Only .bin')) {
      return res.status(400).json({ error: 'invalid_file_type', message: err.message, status: 400 });
    }
    next(err);
  }
});

// ── GET /api/firmware ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM firmwares f LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE ${scopeSql(req)}
        ORDER BY f.tenant_id IS NULL, f.created_at DESC`,
      [req.tenantId]);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/firmware/:id ─────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const fw = await fetchOne(req, req.params.id);
    if (!fw) return notFound(res);
    res.json({ data: await withVisibleTo(req, fw) });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/firmware/:id ─────────────────── (admin: notes; superadmin: publication)
const patchSchema = z.object({
  notes:      z.string().max(2000).nullable().optional(),
  visibility: z.enum(['all', 'selected']).optional(),
  tenant_ids: z.array(z.string().uuid()).max(500).optional(),
});

router.patch('/:id', maybeAuthorize('admin'), async (req, res, next) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });
  }
  const b = parsed.data;
  try {
    const fw = await fetchOne(req, req.params.id);
    if (!fw) return notFound(res);
    if (fw.global && !isSuperadmin(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Platform firmware is managed by the platform', status: 403 });
    }
    if (!fw.global && (b.visibility !== undefined || b.tenant_ids !== undefined)) {
      return res.status(400).json({ error: 'validation_failed', message: 'Only platform firmware has a visibility', status: 400 });
    }
    await db.transaction(async (client) => {
      if (b.notes !== undefined) await client.query('UPDATE firmwares SET notes = $2 WHERE id = $1', [fw.id, b.notes]);
      if (b.visibility !== undefined) await client.query('UPDATE firmwares SET visibility = $2 WHERE id = $1', [fw.id, b.visibility]);
      if (b.tenant_ids !== undefined) await replaceVisibility(client, fw.id, b.tenant_ids, req.user?.id || null);
    });
    req.auditContext = { entityId: fw.id, action: 'firmware.update', changes: b };
    res.json({ data: await withVisibleTo(req, await fetchOne(req, fw.id)) });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/firmware/:id ────────────────── (admin; global: superadmin)
router.delete('/:id', maybeAuthorize('admin'), async (req, res, next) => {
  try {
    const fw = await fetchOne(req, req.params.id);
    if (!fw) return notFound(res);
    if (fw.global && !isSuperadmin(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Platform firmware is managed by the platform', status: 403 });
    }

    // Still in use: a job waiting or in flight, or a rollout that may resume
    const { rows: [use] } = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM ota_jobs WHERE firmware_id = $1 AND status IN ('queued', 'sent')) AS jobs,
              (SELECT COUNT(*)::int FROM ota_rollouts WHERE firmware_id = $1 AND status IN ('running', 'paused')) AS rollouts`,
      [fw.id]);
    if (use.jobs > 0 || use.rollouts > 0) {
      return res.status(409).json({
        error: 'firmware_in_use',
        message: 'Cannot delete firmware with active OTA jobs or rollouts',
        status: 409,
        active_jobs: use.jobs, active_rollouts: use.rollouts,
      });
    }

    const filePath = path.join(FIRMWARE_DIR, fw.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (fileErr) {
      // Non-fatal: DB record will still be deleted
    }

    // History (ota_jobs / ota_rollouts) keeps firmware_version; firmware_id becomes NULL
    await db.query('DELETE FROM firmwares WHERE id = $1', [fw.id]);

    req.auditContext = { entityId: fw.id, changes: { before: { version: fw.version, global: fw.global }, history_jobs: fw.job_count } };
    res.json({ data: { deleted: true, history_jobs: fw.job_count } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
