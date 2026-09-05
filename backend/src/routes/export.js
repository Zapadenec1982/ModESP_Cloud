'use strict';

const { Router }    = require('express');
const { stringify } = require('csv-stringify');
const db            = require('../services/db');
const planMw        = require('../middleware/plan');
const { requireFeature } = planMw;
const haccp         = require('../services/haccp-report');
const { checkDeviceAccess, filterDeviceAccess } = require('../middleware/device-access');
const { isUuidFormat } = require('../lib/ids');

// Register bundled Roboto fonts (includes Cyrillic glyphs)

const deviceRouter = Router();
const alarmRouter  = Router();
const siteRouter   = Router();

// ── Rate limiter (10 exports / min / user) ────────────────
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: 'rate_limited', message: 'Too many export requests. Try again in a minute.' },
});
deviceRouter.use(exportLimiter);
alarmRouter.use(exportLimiter);
siteRouter.use(exportLimiter);

// ── Helpers ───────────────────────────────────────────────

async function resolveDevice(id, tenantId, isSuperadmin) {
  const isUuid = isUuidFormat(id);
  let where = isUuid ? 'id = $1' : 'mqtt_device_id = $1';
  const params = [id];
  if (!isSuperadmin && tenantId) {
    where += ' AND tenant_id = $2';
    params.push(tenantId);
  }
  const { rows } = await db.query(
    `SELECT id, mqtt_device_id, tenant_id, name, location, serial_number, model
     FROM devices WHERE ${where}`,
    params
  );
  return rows[0] || null;
}

function parseTimeRange(query, maxDays = 31) {
  let from, to;
  if (query.from && query.to) {
    from = new Date(query.from);
    to   = new Date(query.to);
    if (isNaN(from) || isNaN(to)) return null;
  } else {
    const hours = Math.min(parseInt(query.hours, 10) || 24, maxDays * 24);
    to   = new Date();
    from = new Date(to.getTime() - hours * 3600 * 1000);
  }
  const maxMs = maxDays * 86400 * 1000;
  if (to - from > maxMs) from = new Date(to.getTime() - maxMs);
  return { from, to };
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().replace('T', ' ').slice(0, 19);
}

function shortDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// ── GET /api/devices/:id/telemetry/export.csv ─────────────
deviceRouter.get('/:id/telemetry/export.csv', checkDeviceAccess(), async (req, res, next) => {
  req.auditContext = { action: 'export.telemetry_csv', entityId: req.params.id };
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const device = await resolveDevice(req.params.id, req.tenantId, isSuperadmin);
    if (!device) {
      return res.status(404).json({ error: 'not_found', message: `Device ${req.params.id} not found` });
    }

    const range = parseTimeRange(req.query);
    if (!range) {
      return res.status(400).json({ error: 'validation_failed', message: 'Invalid from/to dates' });
    }

    const channels = req.query.channels
      ? req.query.channels.split(',').map(c => c.trim()).filter(Boolean)
      : null;

    let sql = `
      SELECT time, channel, value
      FROM telemetry
      WHERE tenant_id = $1 AND device_id = $2
        AND time >= $3 AND time < $4
    `;
    const params = [device.tenant_id, device.mqtt_device_id, range.from, range.to];
    let idx = 5;

    if (channels && channels.length > 0) {
      sql += ` AND channel = ANY($${idx++})`;
      params.push(channels);
    }

    sql += ' ORDER BY time ASC LIMIT 500000';

    const { rows } = await db.query(sql, params);

    const filename = `telemetry_${device.mqtt_device_id}_${shortDate(range.from)}_${shortDate(range.to)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // BOM for Excel Cyrillic compatibility
    res.write('\uFEFF');

    const csvStream = stringify({ header: true, columns: ['Timestamp', 'Channel', 'Value'] });
    csvStream.pipe(res);

    for (const row of rows) {
      csvStream.write([fmtDate(row.time), row.channel, row.value]);
    }
    csvStream.end();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/devices/export/inventory.csv ─────────────────
// (was /devices/export.csv, which routes/devices.js's GET /:id shadowed)
deviceRouter.get('/export/inventory.csv', filterDeviceAccess(), async (req, res, next) => {
  req.auditContext = { action: 'export.inventory_csv' };
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';

    let sql, params;
    if (isSuperadmin) {
      sql = `
        SELECT d.mqtt_device_id, d.name, d.location, d.serial_number, d.model,
               d.firmware_version, d.online, d.last_seen,
               t.slug AS tenant_slug
        FROM devices d
        LEFT JOIN tenants t ON t.id = d.tenant_id
        ORDER BY d.name
      `;
      params = [];
    } else {
      sql = `
        SELECT d.mqtt_device_id, d.name, d.location, d.serial_number, d.model,
               d.firmware_version, d.online, d.last_seen
        FROM devices d
        WHERE d.tenant_id = $1
      `;
      params = [req.tenantId];
      let idx = 2;

      if (req.deviceMqttIds) {
        sql += ` AND d.mqtt_device_id = ANY($${idx++})`;
        params.push(req.deviceMqttIds);
      }
      sql += ' ORDER BY d.name';
    }

    const { rows } = await db.query(sql, params);

    const tenantSlug = req.user?.tenantSlug || 'all';
    const filename = `devices_${tenantSlug}_${shortDate(new Date())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const columns = isSuperadmin
      ? ['Device ID', 'Name', 'Location', 'Serial', 'Model', 'Firmware', 'Online', 'Last Seen', 'Tenant']
      : ['Device ID', 'Name', 'Location', 'Serial', 'Model', 'Firmware', 'Online', 'Last Seen'];

    const csvStream = stringify({ header: true, columns });
    csvStream.pipe(res);

    for (const row of rows) {
      const base = [
        row.mqtt_device_id, row.name || '', row.location || '',
        row.serial_number || '', row.model || '', row.firmware_version || '',
        row.online ? 'Yes' : 'No', fmtDate(row.last_seen),
      ];
      if (isSuperadmin) base.push(row.tenant_slug || '');
      csvStream.write(base);
    }
    csvStream.end();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/alarms/export.csv ────────────────────────────
alarmRouter.get('/export.csv', filterDeviceAccess(), async (req, res, next) => {
  req.auditContext = { action: 'export.alarms_csv' };
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const range = parseTimeRange(req.query, 90);

    let sql, params, idx;
    if (isSuperadmin) {
      sql = `
        SELECT a.device_id, a.alarm_code, a.severity, a.active,
               a.value, a.limit_value, a.triggered_at, a.cleared_at,
               d.name AS device_name, t.slug AS tenant_slug
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
        LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE a.triggered_at >= $1 AND a.triggered_at < $2
      `;
      params = [range.from, range.to];
      idx = 3;
    } else {
      sql = `
        SELECT a.device_id, a.alarm_code, a.severity, a.active,
               a.value, a.limit_value, a.triggered_at, a.cleared_at,
               d.name AS device_name
        FROM alarms a
        LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.triggered_at >= $2 AND a.triggered_at < $3
      `;
      params = [req.tenantId, range.from, range.to];
      idx = 4;
    }

    if (req.deviceMqttIds) {
      sql += ` AND a.device_id = ANY($${idx++})`;
      params.push(req.deviceMqttIds);
    }

    if (req.query.active === 'true') sql += ' AND a.active = true';
    if (req.query.severity) {
      const valid = ['critical', 'warning', 'info'];
      const severities = req.query.severity.split(',').filter(s => valid.includes(s));
      if (severities.length > 0) {
        sql += ` AND a.severity = ANY($${idx++})`;
        params.push(severities);
      }
    }

    sql += ' ORDER BY a.triggered_at DESC LIMIT 50000';

    const { rows } = await db.query(sql, params);

    const tenantSlug = req.user?.tenantSlug || 'all';
    const filename = `alarms_${tenantSlug}_${shortDate(range.from)}_${shortDate(range.to)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF');

    const columns = isSuperadmin
      ? ['Device', 'Device Name', 'Alarm Code', 'Severity', 'Active', 'Value', 'Limit', 'Started', 'Cleared', 'Tenant']
      : ['Device', 'Device Name', 'Alarm Code', 'Severity', 'Active', 'Value', 'Limit', 'Started', 'Cleared'];

    const csvStream = stringify({ header: true, columns });
    csvStream.pipe(res);

    for (const row of rows) {
      const base = [
        row.device_id, row.device_name || '', row.alarm_code, row.severity || 'warning',
        row.active ? 'Yes' : 'No',
        row.value != null ? row.value : '', row.limit_value != null ? row.limit_value : '',
        fmtDate(row.triggered_at), fmtDate(row.cleared_at),
      ];
      if (isSuperadmin) base.push(row.tenant_slug || '');
      csvStream.write(base);
    }
    csvStream.end();
  } catch (err) {
    next(err);
  }
});

// ── HACCP PDF (plan epic 1.9) ─────────────────────────────
// Localised, headed with the organisation's legal name and the site address,
// local time, signature block, verification code + SHA-256 in the footer.
// Recent periods come from raw telemetry; anything older than the plan's raw
// retention from telemetry_hourly, up to a year per report.

async function loadTenant(tenantId) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.slug, t.legal_name, t.tax_id, COALESCE(s.timezone, 'Europe/Kyiv') AS timezone,
            COALESCE(s.raw_retention_days, p.retention_days, 90) AS retention_days,
            COALESCE(s.brand_name, par.brand_name) AS brand_name,
            COALESCE(s.brand_url, par.brand_url)   AS brand_url
       FROM tenants t
       LEFT JOIN tenant_settings s ON s.tenant_id = t.id
       LEFT JOIN tenant_settings par ON par.tenant_id = t.parent_tenant_id
       LEFT JOIN plan_limits p ON p.plan = t.plan
      WHERE t.id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

async function loadSite(siteId, tenantId) {
  if (!siteId) return null;
  const { rows } = await db.query(
    `SELECT id, name, address_line, city, region, country, timezone FROM sites WHERE id = $1 AND tenant_id = $2`,
    [siteId, tenantId]
  );
  return rows[0] || null;
}

function parseChannels(query) {
  return query.channels ? query.channels.split(',').map(c => c.trim()).filter(Boolean) : ['air', 'evap', 'setpoint'];
}

function sendPdf(res, result, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', result.buffer.length);
  res.setHeader('X-Report-Code', haccp.fmtCode(result.code));
  res.setHeader('X-Report-Sha256', result.hash);
  res.setHeader('X-Report-Source', result.source);
  res.setHeader('Access-Control-Expose-Headers', 'X-Report-Code, X-Report-Sha256, X-Report-Source');
  res.end(result.buffer);
}

function reportError(res, err, next) {
  if (err.code === 'too_much_data') {
    return res.status(400).json({ error: 'too_much_data', message: err.message, status: 400 });
  }
  next(err);
}

deviceRouter.get('/:id/telemetry/export.pdf', requireFeature('reports'), checkDeviceAccess(), async (req, res, next) => {
  try {
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const device = await resolveDevice(req.params.id, req.tenantId, isSuperadmin);
    if (!device) {
      return res.status(404).json({ error: 'not_found', message: `Device ${req.params.id} not found`, status: 404 });
    }
    const tenant = await loadTenant(device.tenant_id);
    const range = parseTimeRange(req.query, haccp.HOURLY_MAX_DAYS);
    if (!range) {
      return res.status(400).json({ error: 'validation_failed', message: 'Invalid from/to dates', status: 400 });
    }
    const bucketKey = req.query.bucket || '1h';
    if (!haccp.BUCKETS[bucketKey]) {
      return res.status(400).json({ error: 'validation_failed', message: `Invalid bucket. Use: ${Object.keys(haccp.BUCKETS).join(', ')}`, status: 400 });
    }
    const lang = haccp.pickLang(req.query.lang);
    const { rows: siteRows } = await db.query('SELECT site_id FROM devices WHERE id = $1', [device.id]);
    const site = await loadSite(siteRows[0]?.site_id, device.tenant_id);

    const result = await haccp.generate({
      query: (sql, params) => db.query(sql, params),
      kind: 'device', tenant, site, devices: [device], channels: parseChannels(req.query),
      from: range.from, to: range.to, bucketKey, lang, rawRetentionDays: tenant.retention_days,
      generatedBy: req.user?.email || 'system',
    });
    if (result.empty) {
      return res.status(404).json({ error: 'no_data', message: 'No telemetry data for this period', status: 404 });
    }
    req.auditContext = {
      action: 'export.haccp_pdf', entityId: device.mqtt_device_id,
      changes: { code: result.code, sha256: result.hash, from: range.from, to: range.to, source: result.source, lang },
    };
    sendPdf(res, result, `haccp_${device.mqtt_device_id}_${shortDate(range.from)}_${shortDate(range.to)}.pdf`);
  } catch (err) {
    reportError(res, err, next);
  }
});

// ── GET /api/sites/:id/export.pdf — one document for every device of a site ──
siteRouter.get('/:id/export.pdf', requireFeature('reports'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuidFormat(id)) {
      return res.status(404).json({ error: 'not_found', message: 'Site not found', status: 404 });
    }
    const isSuperadmin = req.user && req.user.role === 'superadmin';
    const { rows: siteRows } = await db.query(
      `SELECT id, tenant_id, name, address_line, city, region, country, timezone FROM sites WHERE id = $1${isSuperadmin ? '' : ' AND tenant_id = $2'}`,
      isSuperadmin ? [id] : [id, req.tenantId]
    );
    if (siteRows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Site not found', status: 404 });
    }
    const site = siteRows[0];
    // Technicians / viewers need a site grant (admins see every site of their organisation)
    if (req.user && req.user.role !== 'admin' && !isSuperadmin) {
      const { rows: grant } = await db.query(
        'SELECT 1 FROM user_sites WHERE site_id = $1 AND tenant_id = $2 AND user_id = $3', [site.id, site.tenant_id, req.user.id]);
      if (grant.length === 0) {
        return res.status(403).json({ error: 'forbidden', message: 'Site access denied', status: 403 });
      }
    }
    const tenant = await loadTenant(site.tenant_id);
    const range = parseTimeRange(req.query, haccp.HOURLY_MAX_DAYS);
    if (!range) {
      return res.status(400).json({ error: 'validation_failed', message: 'Invalid from/to dates', status: 400 });
    }
    const bucketKey = req.query.bucket || '1h';
    if (!haccp.BUCKETS[bucketKey]) {
      return res.status(400).json({ error: 'validation_failed', message: `Invalid bucket. Use: ${Object.keys(haccp.BUCKETS).join(', ')}`, status: 400 });
    }
    const { rows: devices } = await db.query(
      `SELECT id, mqtt_device_id, tenant_id, name, location, serial_number, model
         FROM devices WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY name, mqtt_device_id LIMIT 50`,
      [site.id, site.tenant_id]
    );
    if (devices.length === 0) {
      return res.status(404).json({ error: 'no_data', message: 'No devices on this site', status: 404 });
    }
    const lang = haccp.pickLang(req.query.lang);
    const result = await haccp.generate({
      query: (sql, params) => db.query(sql, params),
      kind: 'site', tenant, site, devices, channels: parseChannels(req.query),
      from: range.from, to: range.to, bucketKey, lang, rawRetentionDays: tenant.retention_days,
      generatedBy: req.user?.email || 'system',
    });
    if (result.empty) {
      return res.status(404).json({ error: 'no_data', message: 'No telemetry data for this period', status: 404 });
    }
    req.auditContext = {
      action: 'export.haccp_site_pdf', entityId: site.id,
      changes: { code: result.code, sha256: result.hash, from: range.from, to: range.to, source: result.source, devices: devices.length, lang },
    };
    sendPdf(res, result, `haccp_site_${site.name.replace(/[^\w-]+/g, '_')}_${shortDate(range.from)}_${shortDate(range.to)}.pdf`);
  } catch (err) {
    reportError(res, err, next);
  }
});

module.exports = { deviceRouter, alarmRouter, siteRouter };
