'use strict';

const { Router }   = require('express');
const multer       = require('multer');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const db           = require('../services/db');

const router = Router();

// ── Firmware storage ──────────────────────────────────────
const FIRMWARE_DIR = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../../firmware');

// Ensure directory exists
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

// Multer: memory storage (files ≤ 4MB, so buffer is fine)
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

// ── POST /api/firmware/upload ─────────────────────────────
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'missing_file',
        message: 'Firmware .bin file is required',
        status: 400,
      });
    }

    const { version, notes } = req.body || {};

    if (!version || !version.trim()) {
      return res.status(400).json({
        error: 'missing_version',
        message: 'Firmware version is required',
        status: 400,
      });
    }

    // Check duplicate version for this tenant
    const dup = await db.query(
      'SELECT id FROM firmwares WHERE tenant_id = $1 AND version = $2',
      [req.tenantId, version.trim()]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({
        error: 'duplicate_version',
        message: `Firmware version '${version.trim()}' already exists`,
        status: 409,
      });
    }

    // Compute SHA256 checksum
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const checksum = `sha256:${hash}`;

    // Save file to disk
    const safeVersion = version.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${req.tenantId}_${safeVersion}_${Date.now()}.bin`;
    const filePath = path.join(FIRMWARE_DIR, filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // Insert DB record
    const result = await db.query(
      `INSERT INTO firmwares (tenant_id, version, filename, original_name, size_bytes, checksum, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, version, filename, original_name, size_bytes, checksum, notes, created_at`,
      [
        req.tenantId,
        version.trim(),
        filename,
        req.file.originalname,
        req.file.size,
        checksum,
        notes || null,
        req.userId || null,
      ]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    // Multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Firmware file must be ≤ 4MB',
        status: 400,
      });
    }
    if (err.message && err.message.includes('Only .bin')) {
      return res.status(400).json({
        error: 'invalid_file_type',
        message: err.message,
        status: 400,
      });
    }
    next(err);
  }
});

// ── GET /api/firmware ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, version, filename, original_name, size_bytes, checksum, notes, created_at
       FROM firmwares
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.tenantId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/firmware/:id ─────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, version, filename, original_name, size_bytes, checksum, notes, created_at
       FROM firmwares
       WHERE tenant_id = $1 AND id = $2`,
      [req.tenantId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'firmware_not_found',
        message: 'Firmware not found',
        status: 404,
      });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/firmware/:id ──────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    // Check no active OTA jobs reference this firmware
    const activeJobs = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM ota_jobs
       WHERE tenant_id = $1 AND firmware_id = $2 AND status IN ('queued', 'sent')`,
      [req.tenantId, req.params.id]
    );
    if (activeJobs.rows[0].count > 0) {
      return res.status(409).json({
        error: 'firmware_in_use',
        message: 'Cannot delete firmware with active OTA jobs',
        status: 409,
      });
    }

    // Get firmware record
    const fw = await db.query(
      'SELECT id, filename FROM firmwares WHERE tenant_id = $1 AND id = $2',
      [req.tenantId, req.params.id]
    );
    if (fw.rows.length === 0) {
      return res.status(404).json({
        error: 'firmware_not_found',
        message: 'Firmware not found',
        status: 404,
      });
    }

    // Delete file from disk
    const filePath = path.join(FIRMWARE_DIR, fw.rows[0].filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (fileErr) {
      // Non-fatal: DB record will still be deleted
    }

    // Delete DB record
    await db.query(
      'DELETE FROM firmwares WHERE tenant_id = $1 AND id = $2',
      [req.tenantId, req.params.id]
    );

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
