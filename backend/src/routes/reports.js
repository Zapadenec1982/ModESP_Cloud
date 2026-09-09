'use strict';

/**
 * Reports (plan epic 2.7): the schedules of an organisation and the archive
 * of everything generated for it.
 *
 *   GET    /reports/schedules          admin   the organisation's schedules
 *   POST   /reports/schedules          admin   create (plan feature `reports`; `energy` for that type)
 *   PATCH  /reports/schedules/:id      admin
 *   DELETE /reports/schedules/:id      admin
 *   POST   /reports/schedules/:id/run  admin   generate and send the last period now
 *   GET    /reports                    any     the archive — technicians and viewers see their sites' reports
 *   GET    /reports/:code/download     any     the archived PDF of a scheduled report
 */

const { Router } = require('express');
const { z } = require('zod');
const db = require('../services/db');
const { authorize } = require('../middleware/auth');
const { requireFeature, hasFeature, getPlanLimits } = require('../middleware/plan');
const { filterDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');
const { SUPPORTED_LOCALES } = require('../lib/locale');
const haccp = require('../services/haccp-report');
const scheduler = require('../services/report-scheduler');
const { slugify } = require('../lib/slug');

const router = Router();
const admin = authorize('admin');
const MAX_SCHEDULES = 50;

const emailList = z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(10);
const createSchema = z.object({
  site_id:    z.string().uuid().nullable().optional(),
  type:       z.enum(scheduler.TYPES),
  cadence:    z.enum(scheduler.CADENCES),
  recipients: emailList,
  lang:       z.enum(SUPPORTED_LOCALES).optional(),
  bucket:     z.enum(Object.keys(haccp.BUCKETS)).optional(),
  enabled:    z.boolean().optional(),
});
const patchSchema = createSchema.partial();

const validationError = (res, parsed) =>
  res.status(400).json({ error: 'validation_failed', message: parsed.error.issues[0].message, status: 400 });

async function featureDenied(req, res, feature) {
  const limits = await getPlanLimits(req.tenantId);
  return res.status(402).json({
    error: 'plan_feature', message: `Feature "${feature}" is not included in plan "${limits ? limits.plan : 'unknown'}". Ask for an upgrade.`,
    status: 402, feature, plan: limits ? limits.plan : null,
  });
}

const SCHEDULE_COLUMNS = `
  s.id, s.tenant_id, s.site_id, st.name AS site_name, s.type, s.cadence, s.recipients, s.lang, s.bucket, s.enabled,
  s.next_run_at, s.last_run_at, s.last_period_to, s.last_status, s.last_error, s.created_at, s.updated_at, u.email AS created_by`;

async function fetchSchedule(id, tenantId) {
  const { rows } = await db.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM report_schedules s
       LEFT JOIN sites st ON st.id = s.site_id LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1 AND s.tenant_id = $2`, [id, tenantId]);
  return rows[0] || null;
}

async function siteOfTenant(siteId, tenantId) {
  const { rows } = await db.query('SELECT id, name, timezone FROM sites WHERE id = $1 AND tenant_id = $2', [siteId, tenantId]);
  return rows[0] || null;
}

async function nextRunFor({ tenantId, siteId, cadence }) {
  const tenant = await scheduler.loadTenant(tenantId);
  const sites = siteId ? await scheduler.loadSites(tenantId, siteId) : [];
  return scheduler.nextRunAfter(cadence, scheduler.scheduleTimezone({ site_id: siteId }, tenant, sites));
}

// ── Schedules ─────────────────────────────────────────────

router.get('/schedules', admin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${SCHEDULE_COLUMNS} FROM report_schedules s
         LEFT JOIN sites st ON st.id = s.site_id LEFT JOIN users u ON u.id = s.created_by
        WHERE s.tenant_id = $1 ORDER BY st.name NULLS FIRST, s.type, s.cadence, s.created_at`, [req.tenantId]);
    res.json({ data: rows });
  } catch (err) {
    req.log?.error?.({ err }, 'List report schedules failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list schedules', status: 500 });
  }
});

router.post('/schedules', admin, requireFeature('reports'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const b = parsed.data;
  try {
    if (b.type === 'energy' && req.user.role !== 'superadmin' && !(await hasFeature(req.tenantId, 'energy'))) {
      return featureDenied(req, res, 'energy');
    }
    if (b.site_id && !(await siteOfTenant(b.site_id, req.tenantId))) {
      return res.status(404).json({ error: 'not_found', message: 'Site not found', status: 404 });
    }
    const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM report_schedules WHERE tenant_id = $1', [req.tenantId]);
    if (n >= MAX_SCHEDULES) {
      return res.status(409).json({ error: 'limit_reached', message: `At most ${MAX_SCHEDULES} schedules per organisation`, status: 409 });
    }
    const nextRunAt = await nextRunFor({ tenantId: req.tenantId, siteId: b.site_id || null, cadence: b.cadence });
    const { rows } = await db.query(
      `INSERT INTO report_schedules (tenant_id, site_id, type, cadence, recipients, lang, bucket, enabled, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [req.tenantId, b.site_id || null, b.type, b.cadence, b.recipients, b.lang || 'uk', b.bucket || '1h', b.enabled !== false, nextRunAt, req.user.id]);
    req.auditContext = { entityId: rows[0].id, action: 'report.schedule_create', changes: { type: b.type, cadence: b.cadence, site_id: b.site_id || null, recipients: b.recipients.length } };
    res.status(201).json({ data: await fetchSchedule(rows[0].id, req.tenantId) });
  } catch (err) {
    req.log?.error?.({ err }, 'Create report schedule failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to create schedule', status: 500 });
  }
});

router.patch('/schedules/:id', admin, async (req, res) => {
  if (!isUuidFormat(req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const b = parsed.data;
  try {
    const current = await fetchSchedule(req.params.id, req.tenantId);
    if (!current) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
    const type = b.type || current.type;
    if (type === 'energy' && current.type !== 'energy' && req.user.role !== 'superadmin' && !(await hasFeature(req.tenantId, 'energy'))) {
      return featureDenied(req, res, 'energy');
    }
    const siteId = b.site_id !== undefined ? b.site_id : current.site_id;
    if (siteId && siteId !== current.site_id && !(await siteOfTenant(siteId, req.tenantId))) {
      return res.status(404).json({ error: 'not_found', message: 'Site not found', status: 404 });
    }
    const cadence = b.cadence || current.cadence;
    const recompute = cadence !== current.cadence || siteId !== current.site_id;
    const nextRunAt = recompute ? await nextRunFor({ tenantId: req.tenantId, siteId, cadence }) : current.next_run_at;
    await db.query(
      `UPDATE report_schedules
          SET site_id = $2, type = $3, cadence = $4, recipients = $5, lang = $6, bucket = $7, enabled = $8, next_run_at = $9, updated_at = now()
        WHERE id = $1 AND tenant_id = $10`,
      [current.id, siteId, type, cadence, b.recipients || current.recipients, b.lang || current.lang, b.bucket || current.bucket,
        b.enabled !== undefined ? b.enabled : current.enabled, nextRunAt, req.tenantId]);
    req.auditContext = { entityId: current.id, action: 'report.schedule_update', changes: b };
    res.json({ data: await fetchSchedule(current.id, req.tenantId) });
  } catch (err) {
    req.log?.error?.({ err }, 'Update report schedule failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to update schedule', status: 500 });
  }
});

router.delete('/schedules/:id', admin, async (req, res) => {
  if (!isUuidFormat(req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
  try {
    const { rowCount } = await db.query('DELETE FROM report_schedules WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
    req.auditContext = { entityId: req.params.id, action: 'report.schedule_delete' };
    res.json({ data: { deleted: true } });
  } catch (err) {
    req.log?.error?.({ err }, 'Delete report schedule failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to delete schedule', status: 500 });
  }
});

// Generate and send the last whole period now. Counts as delivered: the
// timer will not send the same period again.
router.post('/schedules/:id/run', admin, requireFeature('reports'), async (req, res) => {
  if (!isUuidFormat(req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
  try {
    const { rows } = await db.query('SELECT * FROM report_schedules WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'Schedule not found', status: 404 });
    const result = await scheduler.runSchedule(rows[0], { force: true });
    req.auditContext = {
      entityId: rows[0].id, action: 'report.schedule_run',
      changes: { status: result.status, reports: result.reports.filter(r => r.code).map(r => r.code), emailed: result.emailed },
    };
    res.json({ data: result });
  } catch (err) {
    req.log?.error?.({ err }, 'Run report schedule failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to run schedule', status: 500 });
  }
});

// ── Archive ───────────────────────────────────────────────

/** WHERE fragment restricting a technician/viewer to reports of their sites and devices. */
function accessScope(req, params) {
  if (!req.deviceFilter) return '';
  params.push(req.deviceFilter, req.user.id);
  const dev = `$${params.length - 1}::uuid[]`;
  const uid = `$${params.length}`;
  return ` AND (r.site_id IN (SELECT site_id FROM user_sites WHERE user_id = ${uid} AND tenant_id = r.tenant_id)
            OR r.site_id IN (SELECT site_id FROM devices WHERE id = ANY(${dev}) AND site_id IS NOT NULL)
            OR r.device_id IN (SELECT mqtt_device_id FROM devices WHERE id = ANY(${dev})))`;
}

router.get('/', filterDeviceAccess(), async (req, res) => {
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const params = [req.tenantId];
    let where = 'WHERE r.tenant_id = $1';
    if (req.query.type && [...scheduler.TYPES, 'service'].includes(req.query.type)) { params.push(req.query.type); where += ` AND r.report_type = $${params.length}`; }
    if (req.query.site_id && isUuidFormat(req.query.site_id)) { params.push(req.query.site_id); where += ` AND r.site_id = $${params.length}`; }
    if (req.query.scheduled === 'true') where += ' AND r.schedule_id IS NOT NULL';
    where += accessScope(req, params);
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT r.code, r.kind, r.report_type, r.device_id, d.name AS device_name, r.site_id, st.name AS site_name,
              r.period_from, r.period_to, r.bucket, r.source, r.lang, r.generated_by, r.generated_at, r.schedule_id,
              r.file_name, r.bytes, (r.pdf IS NOT NULL) AS archived, COUNT(*) OVER() AS total
         FROM report_exports r
         LEFT JOIN sites st ON st.id = r.site_id
         LEFT JOIN devices d ON d.mqtt_device_id = r.device_id AND d.tenant_id = r.tenant_id
        ${where}
        ORDER BY r.generated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = rows.length ? Number(rows[0].total) : 0;
    res.json({ data: rows.map(({ total: _t, ...r }) => ({ ...r, code: haccp.fmtCode(r.code) })), meta: { total, limit, offset } });
  } catch (err) {
    req.log?.error?.({ err }, 'List reports failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to list reports', status: 500 });
  }
});

router.get('/:code/download', filterDeviceAccess(), async (req, res) => {
  const code = String(req.params.code || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(code)) return res.status(404).json({ error: 'not_found', message: 'Report not found', status: 404 });
  try {
    const params = [req.tenantId, code];
    const { rows } = await db.query(
      `SELECT r.code, r.pdf, r.file_name, r.sha256, r.source FROM report_exports r
        WHERE r.tenant_id = $1 AND r.code = $2${accessScope(req, params)}`, params);
    const row = rows[0];
    if (!row || !row.pdf) return res.status(404).json({ error: 'not_found', message: 'Report not found or no longer archived', status: 404 });
    res.setHeader('Content-Type', 'application/pdf');
    // RFC 5987: an ASCII fallback plus the UTF-8 name (site names are usually Cyrillic)
    const fileName = row.file_name || `report_${code}.pdf`;
    const ascii = `${slugify(fileName.replace(/\.pdf$/i, '')).replace(/[^a-z0-9._-]/g, '_') || `report_${code}`}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Length', row.pdf.length);
    res.setHeader('X-Report-Code', haccp.fmtCode(row.code));
    res.setHeader('X-Report-Sha256', row.sha256);
    res.setHeader('X-Report-Source', row.source);
    res.setHeader('Access-Control-Expose-Headers', 'X-Report-Code, X-Report-Sha256, X-Report-Source');
    // An archived HACCP PDF leaving the system is the same compliance event as
    // the on-demand export, which audits at export.haccp_pdf.
    req.auditContext = { action: 'report.download', entityType: 'report', entityId: row.code, changes: { code: row.code, sha256: row.sha256, source: row.source } };
    res.end(row.pdf);
  } catch (err) {
    req.log?.error?.({ err }, 'Download report failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to download report', status: 500 });
  }
});

module.exports = router;
