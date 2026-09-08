'use strict';

/**
 * CSV import jobs (plan epic 2.12). Mounted with authorize('admin').
 *   GET  /imports                        the organisation's imports, newest first
 *   GET  /imports/:id                    one job with progress, summary, results and errors
 *   GET  /imports/:id/credentials.csv    the MQTT credentials of the assigned controllers — once
 *   POST /imports/:id/cancel             stop after the current row
 * The upload itself stays at POST /devices/pending/batch and answers 202 with the job.
 */

const { Router } = require('express');
const db = require('../services/db');
const importSvc = require('../services/device-import');
const { isUuidFormat } = require('../lib/ids');

const router = Router();
const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Import not found', status: 404 });

const present = (job, { results = false } = {}) => {
  const out = { ...job, summary: importSvc.summaryOf(job) };
  if (!results) delete out.results;
  delete out.rows;
  return out;
};

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${importSvc.jobColumns('i')}, u.email AS requested_by_email FROM imports i LEFT JOIN users u ON u.id = i.requested_by
        WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 20`, [req.tenantId]);
    res.json({ data: rows.map(r => present(r)), meta: { max_rows: importSvc.maxRows() } });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  if (!isUuidFormat(req.params.id)) return notFound(res);
  try {
    const { rows } = await db.query(
      `SELECT ${importSvc.jobColumns('i')}, i.results, u.email AS requested_by_email FROM imports i LEFT JOIN users u ON u.id = i.requested_by
        WHERE i.id = $1 AND i.tenant_id = $2`, [req.params.id, req.tenantId]);
    if (rows.length === 0) return notFound(res);
    res.json({ data: present(rows[0], { results: true }) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/credentials.csv', async (req, res, next) => {
  if (!isUuidFormat(req.params.id)) return notFound(res);
  try {
    const out = await importSvc.takeCredentials(req.tenantId, req.params.id);
    if (out.status === 'not_found') return notFound(res);
    if (out.status === 'gone') return res.status(410).json({ error: 'credentials_gone', message: 'The credentials were downloaded already', status: 410 });
    if (out.status === 'none') return res.status(409).json({ error: 'no_credentials', message: 'This import assigned no controller', status: 409 });
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const host = process.env.MQTT_PUBLIC_HOST || req.hostname;
    const lines = ['mqtt_device_id,name,username,password,mqtt_host,mqtt_port,sent_via_mqtt'];
    for (const c of out.credentials) lines.push([c.mqtt_device_id, c.name, c.username, c.password, host, 8883, c.sent_via_mqtt ? 'yes' : 'no'].map(cell).join(','));
    req.auditContext = { entityId: req.params.id, action: 'import.credentials', changes: { count: out.credentials.length } };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="credentials_${req.params.id.slice(0, 8)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  if (!isUuidFormat(req.params.id)) return notFound(res);
  try {
    const out = await importSvc.requestCancel(req.tenantId, req.params.id);
    if (!out) return res.status(409).json({ error: 'not_active', message: 'Import is not running', status: 409 });
    req.auditContext = { entityId: req.params.id, action: 'import.cancel' };
    res.json({ data: { id: req.params.id, status: out } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
