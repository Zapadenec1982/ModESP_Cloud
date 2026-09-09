'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const service = require('../src/services/service-report');

const app = createTestApp();
const DAY = 86400 * 1000;
const STEP = 5 * 60000;
const parse = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

afterAll(async () => { await shutdownDb(); });

/**
 * Six hours of 5-minute samples for every channel the service report reads.
 *   steps 24–27  defrost on, air rises to −10 (must not count as an excursion)
 *   steps 40–48  air at −12, longer than 30 min past −18 + 3 → one excursion
 *   steps 60–65  no samples at all → a 30-minute recording gap
 *   compressor   4 steps on, 2 steps off → duty 66.7 %, longest run 20 min
 */
async function insertSamples(tenantId, deviceId, start) {
  const values = [];
  const params = [];
  let i = 1;
  for (let step = 0; step < 72; step++) {
    if (step >= 60 && step <= 65) continue;
    const t = new Date(start.getTime() + step * STEP);
    const defrost = step >= 24 && step <= 27 ? 1 : 0;
    const air = defrost ? -10 : (step >= 40 && step <= 48 ? -12 : -18.5 + Math.sin(step / 4));
    const comp = step % 6 < 4 ? 1 : 0;
    for (const [ch, v] of [['air', air], ['evap', air - 7], ['cond', 38 + (step % 5)], ['setpoint', -18], ['comp', comp], ['defrost', defrost]]) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(t, tenantId, deviceId, ch, v);
    }
  }
  await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
}

describe('Service report for technicians', () => {
  let tenant, site, device, admin, techSite, techOther, viewer, start, from, to, code;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'service-test', plan: 'pro' });
    await db.query(`UPDATE tenants SET legal_name = 'ТОВ «Морозко»' WHERE id = $1`, [tenant.id]);
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, address_line, city, country, timezone) VALUES ($1, 'Магазин №1', 'вул. Соборна 10', 'Луцьк', 'Україна', 'Europe/Kyiv') RETURNING id`, [tenant.id]);
    site = rows[0];
    device = await createDevice(tenant.id, { mqttId: 'SRV001', name: 'Морозильна камера' });
    await db.query(
      `UPDATE devices SET site_id = $1, serial_number = 'SN-7', model = 'ModESP-R1', firmware_version = '2.4.1', haccp_max = -18, haccp_tolerance = 3, haccp_product = 'Морозиво',
              last_state = $2 WHERE id = $3`,
      [site.id, JSON.stringify({ 'thermostat.setpoint': -18, 'thermostat.differential': 2, 'protection.high_limit': -12, 'protection.door_delay': 5, 'defrost.interval': 6, 'defrost.max_duration': 30, 'thermostat.night_setback': false, 'sensor.air': -18.2 }), device.id]);
    admin     = await createUser(tenant.id, { role: 'admin', email: 'admin@service.test' });
    techSite  = await createUser(tenant.id, { role: 'technician', email: 'tech@service.test' });
    techOther = await createUser(tenant.id, { role: 'technician', email: 'other@service.test' });
    viewer    = await createUser(tenant.id, { role: 'viewer', email: 'viewer@service.test' });
    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)', [techSite.id, site.id, tenant.id, admin.id]);

    start = new Date(Math.floor((Date.now() - 2 * DAY) / 3600e3) * 3600e3);
    from = new Date(start.getTime() - 3600e3);
    to = new Date(start.getTime() + 7 * 3600e3);
    await insertSamples(tenant.id, 'SRV001', start);

    // cloud connectivity: 25 minutes offline in the second hour, plus a stale offline from before the period that was resolved before it
    await db.query(`INSERT INTO events (tenant_id, device_id, event_type, time) VALUES ($1, 'SRV001', 'device_offline', $2), ($1, 'SRV001', 'device_online', $3), ($1, 'SRV001', 'device_offline', $4), ($1, 'SRV001', 'device_online', $5)`,
      [tenant.id, new Date(start.getTime() - 5 * 3600e3), new Date(start.getTime() - 4 * 3600e3), new Date(start.getTime() + 60 * 60000), new Date(start.getTime() + 85 * 60000)]);
    // alarms: a 12-minute door alarm and a high temperature alarm with a work order
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, 'SRV001', 'door_alarm', 'warning', false, $2, $3)`,
      [tenant.id, new Date(start.getTime() + 100 * 60000), new Date(start.getTime() + 112 * 60000)]);
    const { rows: al } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, value, limit_value, active, triggered_at, cleared_at, acknowledged_by, acknowledged_at, ack_note)
       VALUES ($1, 'SRV001', 'high_temp_alarm', 'critical', -12, -15, false, $2, $3, $4, $3, 'Перевірив ущільнювач') RETURNING id`,
      [tenant.id, new Date(start.getTime() + 200 * 60000), new Date(start.getTime() + 245 * 60000), admin.id]);
    await db.query(
      `INSERT INTO work_orders (tenant_id, site_id, device_id, device_mqtt_id, alarm_id, title, status, assigned_to, created_by, created_at, closed_at, closed_reason)
       VALUES ($1, $2, $3, 'SRV001', $4, 'Заміна ущільнювача дверей', 'done', $5, $6, $7, $8, 'Ущільнювач замінено')`,
      [tenant.id, site.id, device.id, al[0].id, techSite.id, admin.id, new Date(start.getTime() + 210 * 60000), new Date(start.getTime() + 300 * 60000)]);
    await db.query(
      `INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, alarm_code, severity, value, threshold, window_hours, opened_at, last_seen_at)
       VALUES ($1, 'SRV001', 'alarm_repeat', 'high_temp_alarm', 'warning', 4, 3, 24, $2, $2)`, [tenant.id, new Date(start.getTime() + 250 * 60000)]);
    await db.query(
      `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done, duration_min, parts)
       VALUES ($1, $2, $3::date, 'Іван Петренко', 'Аварійний виклик', 'Заміна ущільнювача', 45, '[{"name":"Ущільнювач 1200 мм"}]'::jsonb)`,
      [tenant.id, device.id, start]);
  });

  afterAll(async () => { await cleanDatabase(); });

  it('collectDevice derives the engineering facts from the same telemetry as the HACCP log', async () => {
    const { rows } = await db.query('SELECT * FROM devices WHERE id = $1', [device.id]);
    const d = await service.__test.collectDevice({
      query: (sql, p) => db.query(sql, p), device: rows[0], tenantId: tenant.id, from, to, bucketSec: 3600, source: 'raw', excursionMin: 30, samplingSec: 300,
    });
    expect(d.hourly).toBe(false);
    expect(d.stepSec).toBe(300);
    expect(Object.keys(d.summary).sort()).toEqual(['air', 'comp', 'cond', 'defrost', 'evap', 'setpoint']);
    expect(d.limits).toEqual({ min: null, max: -18, source: 'org' });
    expect(d.tolerance).toBe(3);
    expect(d.defrost).toHaveLength(1);
    expect(d.excursions).toHaveLength(1);
    expect(d.excursions[0].minutes).toBeGreaterThanOrEqual(30);
    expect(d.gaps.map(g => g.minutes)).toEqual([60, 30, 60]);       // hour before the first sample, the 30-minute hole, the hour after the last
    expect(d.comp).toEqual({ duty: 66.7, starts: 10, longestMin: 20 });
    expect(d.offline).toHaveLength(1);
    expect(d.offline[0]).toMatchObject({ minutes: 25, open: false });
    expect(d.alarms.map(a => a.alarm_code)).toEqual(['door_alarm', 'high_temp_alarm']);
    expect(d.alarms[1].wo_status).toBe('done');
    expect(d.doors).toHaveLength(1);
    expect(d.hints).toHaveLength(1);
    expect(d.work.orders).toHaveLength(1);
    expect(d.work.records).toHaveLength(1);
  });

  it('renders a PDF, registers it as a service report and audits the export', async () => {
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry/service.pdf?from=${from.toISOString()}&to=${to.toISOString()}&lang=uk`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/service_SRV001_/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['x-report-code']).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.headers['x-report-source']).toBe('raw');
    code = res.headers['x-report-code'];

    const { rows } = await db.query('SELECT * FROM report_exports WHERE code = $1', [code.replace(/-/g, '')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'device', report_type: 'service', tenant_id: tenant.id, device_id: 'SRV001', site_id: site.id, sha256: res.headers['x-report-sha256'], generated_by: 'admin@service.test' });

    await new Promise(r => setTimeout(r, 200));
    const { rows: audit } = await db.query(`SELECT action, changes FROM audit_log WHERE action = 'export.service_pdf' AND entity_id = 'SRV001'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.code).toBe(code.replace(/-/g, ''));
  });

  it('the public verification confirms the code; the archive lists it as a service report', async () => {
    const pub = await request(app).get(`/api/public/report/${code}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ code, kind: 'device', valid: true });

    const list = await request(app).get('/api/reports?type=service').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.map(r => r.code)).toEqual([code]);
    expect(list.body.data[0].report_type).toBe('service');
    const haccpOnly = await request(app).get('/api/reports?type=haccp').set(authHeader(admin, tenant.id));
    expect(haccpOnly.body.data).toEqual([]);
  });

  it('access: technician of the site yes, other technician and free plan no; other languages render', async () => {
    const q = `from=${from.toISOString()}&to=${to.toISOString()}`;
    expect((await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?${q}&lang=en`).set(authHeader(techSite, tenant.id)).buffer(true).parse(parse)).status).toBe(200);
    expect((await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?${q}`).set(authHeader(techOther, tenant.id))).status).toBe(403);
    for (const lang of ['pl', 'de']) {
      expect((await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?${q}&lang=${lang}`).set(authHeader(admin, tenant.id)).buffer(true).parse(parse)).status).toBe(200);
    }
    const bad = await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?${q}&bucket=2h`).set(authHeader(admin, tenant.id));
    expect(bad.status).toBe(400);
    const empty = await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?from=${new Date(Date.now() - 30 * DAY).toISOString()}&to=${new Date(Date.now() - 29 * DAY).toISOString()}`).set(authHeader(admin, tenant.id));
    expect(empty.status).toBe(404);
    expect(empty.body.error).toBe('no_data');

    await db.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    const gated = await request(app).get(`/api/devices/${device.id}/telemetry/service.pdf?${q}`).set(authHeader(admin, tenant.id));
    await db.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    expect(gated.status).toBe(402);
    expect(gated.body).toMatchObject({ error: 'plan_feature', feature: 'reports' });
  });

  it('a site service report covers the site and needs a site grant', async () => {
    const q = `from=${from.toISOString()}&to=${to.toISOString()}`;
    const res = await request(app).get(`/api/sites/${site.id}/service.pdf?${q}`).set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/service_site_/);
    const { rows } = await db.query('SELECT kind, report_type, device_id, site_id FROM report_exports WHERE code = $1', [res.headers['x-report-code'].replace(/-/g, '')]);
    expect(rows[0]).toMatchObject({ kind: 'site', report_type: 'service', device_id: null, site_id: site.id });
    expect((await request(app).get(`/api/sites/${site.id}/service.pdf?${q}`).set(authHeader(techSite, tenant.id)).buffer(true).parse(parse)).status).toBe(200);
    expect((await request(app).get(`/api/sites/${site.id}/service.pdf?${q}`).set(authHeader(viewer, tenant.id))).status).toBe(403);

    await new Promise(r => setTimeout(r, 200));
    const { rows: audit } = await db.query(`SELECT action FROM audit_log WHERE action = 'export.service_site_pdf' AND entity_id = $1`, [site.id]);
    expect(audit).toHaveLength(2);      // admin and the technician
  });

  it('falls back to the hourly archive beyond the raw retention', async () => {
    // basic: 400 days of raw data, and it still includes the "reports" feature
    await db.query(`UPDATE tenants SET plan = 'basic' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    const old = new Date(Date.now() - 450 * DAY);
    const values = [];
    for (let h = 0; h < 48; h++) {
      const hour = new Date(old.getTime() + h * 3600000).toISOString();
      for (const [ch, lo, hi, avg] of [['air', -19, -17, -18], ['evap', -26, -24, -25], ['comp', 0, 1, 0.6]]) values.push(`('${tenant.id}', 'SRV001', '${ch}', '${hour}', ${lo}, ${hi}, ${avg}, 12)`);
    }
    await db.query(`INSERT INTO telemetry_hourly (tenant_id, device_id, channel, hour, min, max, avg, samples) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`);
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry/service.pdf?from=${old.toISOString()}&to=${new Date(old.getTime() + 2 * DAY).toISOString()}&bucket=1h`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.headers['x-report-source']).toBe('hourly');
  });

  describe('helpers', () => {
    const S = service.strings('uk');

    it('compressorStats: duty, starts and the longest run from the 0/1 channel; hourly gives duty only', () => {
      expect(service.__test.compressorStats([], 300e3, false)).toEqual({ duty: null, starts: 0, longestMin: 0 });
      expect(service.__test.compressorStats([0, 1, 1, 0, 1].map(v => ({ v })), 300e3, false)).toEqual({ duty: 60, starts: 2, longestMin: 10 });
      expect(service.__test.compressorStats([1, 1, 1, 1].map(v => ({ v })), 60e3, false)).toEqual({ duty: 100, starts: 0, longestMin: 4 });
      expect(service.__test.compressorStats([{ avg: 0.5 }, { avg: 0.7 }], 3600e3, true)).toEqual({ duty: 60, starts: null, longestMin: null });
    });

    it('fetchOfflinePeriods: pairs offline/online events, clips to the period and keeps an open one', async () => {
      const t0 = new Date('2030-01-01T00:00:00Z');
      const { rows: [{ id: tid }] } = await db.query('SELECT id FROM tenants WHERE slug = $1', ['service-test']);
      await db.query(`INSERT INTO events (tenant_id, device_id, event_type, time) VALUES ($1, 'SRV002', 'device_offline', $2), ($1, 'SRV002', 'device_online', $3), ($1, 'SRV002', 'device_offline', $4)`,
        [tid, new Date(t0.getTime() - 30 * 60000), new Date(t0.getTime() + 30 * 60000), new Date(t0.getTime() + 120 * 60000)]);
      const periods = await service.__test.fetchOfflinePeriods({ query: (s, p) => db.query(s, p), tenantId: tid, deviceId: 'SRV002', from: t0, to: new Date(t0.getTime() + 180 * 60000) });
      expect(periods).toEqual([
        { from: t0.getTime(), to: t0.getTime() + 30 * 60000, open: false, minutes: 30 },
        { from: t0.getTime() + 120 * 60000, to: t0.getTime() + 180 * 60000, open: true, minutes: 60 },
      ]);
    });

    it('chartSvg: draws the channels and the HACCP limit line, needs at least two air points', () => {
      const t0 = Date.parse('2026-09-04T00:00:00Z');
      const buckets = [0, 1, 2, 3].map(i => ({ time: new Date(t0 + i * 3600e3).toISOString(), air: { avg: -18 + i }, evap: { avg: -25 }, setpoint: { avg: -18 } }));
      const svg = service.__test.chartSvg({ buckets, from: new Date(t0), to: new Date(t0 + 4 * 3600e3), tz: 'Europe/Kyiv', limits: { min: null, max: -18 }, tolerance: 3 });
      expect(svg).toMatch(/^<svg /);
      expect((svg.match(/<path /g) || []).length).toBe(3);
      expect(svg).toContain('stroke="#dc2626"');
      expect(svg).toContain('03:00');     // first tick is local time (UTC+3)
      expect(service.__test.chartSvg({ buckets: buckets.slice(0, 1), from: new Date(t0), to: new Date(t0 + 3600e3), tz: 'UTC', limits: { min: null, max: null }, tolerance: 0 })).toBeNull();
    });

    it('settingsRows: known keys in dictionary order with units; unknown keys and missing state ignored', () => {
      expect(service.__test.settingsRows(S, null)).toEqual([]);
      expect(service.__test.settingsRows(S, { 'sensor.air': -18, 'thermostat.setpoint': -18, 'protection.door_delay': 5, 'defrost.interval': 6, 'thermostat.night_setback': true, 'defrost.termination': 'temp' }))
        .toEqual([['Уставка', '-18 °C'], ['Затримка тривоги дверей', '5 min'], ['Нічний зсув', 'on'], ['Інтервал відтайки', '6 h'], ['Завершення відтайки', 'temp']]);
      expect(service.__test.unitOf('protection.max_starts_hour')).toBe('/h');
      expect(service.__test.unitOf('datalogger.sample_interval')).toBe('s');
      expect(service.strings('xx').title).toBe(S.title);
      expect(service.strings('en').title).toBe('Equipment Service Report');
    });
  });
});
