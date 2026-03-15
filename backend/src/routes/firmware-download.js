'use strict';

const path = require('path');
const { verifySignature } = require('../services/firmware-url');

const firmwareDir = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../../firmware');

/**
 * GET /api/firmware/dl?file=...&expires=...&sig=...
 *
 * Serves firmware binaries via HMAC-signed, time-limited URLs.
 * No JWT required — ESP32 devices fetch directly.
 */
function firmwareDownload(req, res) {
  const { file, expires, sig } = req.query;

  // Validate required params
  if (!file || !expires || !sig) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'Required query params: file, expires, sig',
      status: 400,
    });
  }

  // Path traversal protection
  if (file.includes('..') || file.includes('/') || file.includes('\\')) {
    return res.status(400).json({
      error: 'invalid_filename',
      message: 'Invalid filename',
      status: 400,
    });
  }

  // Verify HMAC signature + expiry
  if (!verifySignature(file, expires, sig)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Invalid or expired download link',
      status: 403,
    });
  }

  // Stream the file
  const filePath = path.resolve(firmwareDir, file);
  res.sendFile(filePath, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({
          error: 'not_found',
          message: 'Firmware file not found',
          status: 404,
        });
      }
      return res.status(500).json({
        error: 'internal',
        message: 'Failed to serve firmware file',
        status: 500,
      });
    }
  });
}

module.exports = firmwareDownload;
