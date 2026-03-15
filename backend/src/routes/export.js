'use strict';

const { Router }    = require('express');
const { stringify } = require('csv-stringify');
const pdfmake       = require('pdfmake/build/pdfmake');
const vfs_fonts     = require('pdfmake/build/vfs_fonts');
const db            = require('../services/db');
const { checkDeviceAccess, filterDeviceAccess } = require('../middleware/device-access');

// Register bundled Roboto fonts (includes Cyrillic glyphs)
pdfmake.addVirtualFileSystem(vfs_fonts);

const deviceRouter = Router();
const alarmRouter  = Router();

// ── Rate limiter (10 exports / min / user) ────────────────
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { error: 'rate_limited', message: 'Too many export requests. Try again in a minute.' },
});
deviceRouter.use(exportLimiter);
alarmRouter.use(exportLimiter);

// ── Helpers ───────────────────────────────────────────────

async function resolveDevice(id, tenantId, isSuperadmin) {
  const isUuid = id.length > 8;
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

// ── GET /api/devices/export.csv ───────────────────────────
deviceRouter.get('/export.csv', filterDeviceAccess(), async (req, res, next) => {
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

// ── GET /api/devices/:id/telemetry/export.pdf (HACCP) ────
deviceRouter.get('/:id/telemetry/export.pdf', checkDeviceAccess(), async (req, res, next) => {
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

    const tempChannels = req.query.channels
      ? req.query.channels.split(',').map(c => c.trim()).filter(Boolean)
      : ['air', 'evap', 'setpoint'];
    const bucketKey = req.query.bucket || '1h';
    const validBuckets = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
    const bucketSec = validBuckets[bucketKey];
    if (!bucketSec) {
      return res.status(400).json({
        error: 'validation_failed',
        message: `Invalid bucket. Use: ${Object.keys(validBuckets).join(', ')}`,
      });
    }

    // ── Fetch aggregated telemetry ──
    const bucketExpr = `to_timestamp(floor(extract(epoch FROM time) / ${bucketSec}) * ${bucketSec})`;
    const telSql = `
      SELECT
        ${bucketExpr} AS bucket,
        channel,
        MIN(value)   AS min,
        MAX(value)   AS max,
        AVG(value)   AS avg,
        COUNT(*)::int AS samples
      FROM telemetry
      WHERE tenant_id = $1 AND device_id = $2
        AND time >= $3 AND time < $4
        AND channel = ANY($5)
      GROUP BY bucket, channel
      ORDER BY bucket ASC, channel
    `;
    const telRows = (await db.query(telSql, [
      device.tenant_id, device.mqtt_device_id, range.from, range.to, tempChannels,
    ])).rows;

    if (telRows.length === 0) {
      return res.status(404).json({ error: 'no_data', message: 'No telemetry data for this period' });
    }

    // Guard: max 10k rows for PDF
    if (telRows.length > 10000) {
      return res.status(400).json({
        error: 'too_much_data',
        message: 'Too many data points for PDF. Use a larger bucket or shorter time range.',
      });
    }

    // ── Build summary ──
    const summaryAcc = {};
    const bucketMap = new Map();

    for (const row of telRows) {
      const t = row.bucket.toISOString();
      if (!bucketMap.has(t)) bucketMap.set(t, { time: t });
      bucketMap.get(t)[row.channel] = {
        min: parseFloat(row.min),
        max: parseFloat(row.max),
        avg: parseFloat(parseFloat(row.avg).toFixed(2)),
        samples: row.samples,
      };

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
        min: acc.min.toFixed(2),
        max: acc.max.toFixed(2),
        avg: (acc.sum / acc.count).toFixed(2),
        samples: acc.count,
      };
    }

    // ── Fetch alarms during period ──
    const alarmSql = `
      SELECT alarm_code, severity, value, limit_value, triggered_at, cleared_at
      FROM alarms
      WHERE tenant_id = $1 AND device_id = $2
        AND triggered_at >= $3 AND triggered_at < $4
      ORDER BY triggered_at ASC
      LIMIT 200
    `;
    const alarmRows = (await db.query(alarmSql, [
      device.tenant_id, device.mqtt_device_id, range.from, range.to,
    ])).rows;

    // ── Build PDF ──
    const deviceName = device.name || device.mqtt_device_id;
    const generatedBy = req.user?.email || 'system';
    const fromStr = shortDate(range.from);
    const toStr   = shortDate(range.to);

    // Summary table
    const summaryTable = {
      table: {
        headerRows: 1,
        widths: ['*', 'auto', 'auto', 'auto', 'auto'],
        body: [
          [
            { text: 'Channel', bold: true },
            { text: 'Min °C', bold: true },
            { text: 'Max °C', bold: true },
            { text: 'Avg °C', bold: true },
            { text: 'Samples', bold: true },
          ],
          ...Object.entries(summary).map(([ch, s]) => [
            ch, s.min, s.max, s.avg, s.samples.toString(),
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 5, 0, 15],
    };

    // Alarms table (if any)
    const alarmsSection = alarmRows.length > 0
      ? [
          { text: 'Alarms During Period', style: 'sectionHeader' },
          {
            table: {
              headerRows: 1,
              widths: ['auto', '*', 'auto', 'auto', 'auto'],
              body: [
                [
                  { text: 'Time', bold: true },
                  { text: 'Code', bold: true },
                  { text: 'Severity', bold: true },
                  { text: 'Value', bold: true },
                  { text: 'Cleared', bold: true },
                ],
                ...alarmRows.map(a => [
                  fmtDate(a.triggered_at),
                  a.alarm_code,
                  a.severity || 'warning',
                  a.value != null ? a.value.toString() : '-',
                  a.cleared_at ? fmtDate(a.cleared_at) : 'Active',
                ]),
              ],
            },
            layout: 'lightHorizontalLines',
            margin: [0, 5, 0, 15],
          },
        ]
      : [{ text: 'No alarms during this period.', italics: true, margin: [0, 5, 0, 15] }];

    // Temperature log table
    const buckets = [...bucketMap.values()];
    const chCols = Object.keys(summary);
    const logTable = {
      table: {
        headerRows: 1,
        widths: ['auto', ...chCols.map(() => '*')],
        body: [
          [
            { text: 'Time', bold: true },
            ...chCols.map(ch => ({ text: `${ch} °C`, bold: true })),
          ],
          ...buckets.map(b => [
            fmtDate(b.time),
            ...chCols.map(ch => b[ch] ? b[ch].avg.toFixed(2) : '-'),
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
      fontSize: 8,
    };

    const docDefinition = {
      defaultStyle: { font: 'Roboto', fontSize: 9 },
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 60],
      header: {
        text: 'ModESP — HACCP Temperature Compliance Log',
        alignment: 'center',
        margin: [0, 15, 0, 0],
        fontSize: 10,
        bold: true,
        color: '#555555',
      },
      footer: (currentPage, pageCount) => ({
        text: `Page ${currentPage} / ${pageCount}  —  ModESP HACCP Report`,
        alignment: 'center',
        margin: [0, 15, 0, 0],
        fontSize: 8,
        color: '#999999',
      }),
      content: [
        { text: 'HACCP Temperature Compliance Log', style: 'title' },
        {
          columns: [
            {
              width: '*',
              text: [
                { text: 'Device: ', bold: true }, `${deviceName} (${device.mqtt_device_id})\n`,
                { text: 'Location: ', bold: true }, `${device.location || '—'}\n`,
                { text: 'Serial: ', bold: true }, `${device.serial_number || '—'}`,
                device.model ? `    Model: ${device.model}` : '',
              ],
            },
            {
              width: 'auto',
              text: [
                { text: 'Period: ', bold: true }, `${fromStr} — ${toStr}\n`,
                { text: 'Bucket: ', bold: true }, `${bucketKey}\n`,
                { text: 'Generated: ', bold: true }, `${shortDate(new Date())} by ${generatedBy}`,
              ],
              alignment: 'right',
            },
          ],
          margin: [0, 0, 0, 15],
        },

        { text: 'Summary', style: 'sectionHeader' },
        summaryTable,

        ...alarmsSection,

        { text: `Temperature Log (${bucketKey} intervals)`, style: 'sectionHeader' },
        logTable,
      ],
      styles: {
        title: { fontSize: 16, bold: true, margin: [0, 0, 0, 10] },
        sectionHeader: { fontSize: 12, bold: true, margin: [0, 10, 0, 5], color: '#333333' },
      },
    };

    const pdf = pdfmake.createPdf(docDefinition);
    const buffer = await pdf.getBuffer();

    const filename = `haccp_${device.mqtt_device_id}_${fromStr}_${toStr}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

module.exports = { deviceRouter, alarmRouter };
