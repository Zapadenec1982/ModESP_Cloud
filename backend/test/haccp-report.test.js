'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const haccp = require('../src/services/haccp-report');
const cleanupTelemetry = require('../scripts/cleanup-telemetry');

const app = createTestApp();
const DAY = 86400 * 1000;

afterAll(async () => { await shutdownDb(); });

async function insertRaw(tenantId, deviceId, start, hours, stepMin = 5) {
  const values = [];
  const params = [];
  let i = 1;
  for (let m = 0; m < hours * 60; m += stepMin) {
    const t = new Date(start.getTime() + m * 60000);
    for (const [ch, base] of [['air', -18], ['evap', -25], ['setpoint', -18]]) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(t, tenantId, deviceId, ch, base + Math.sin(m / 60) );
    }
  }
  await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
}

describe('HACCP report (plan epic 1.9)', () => {
  let tenant, site, device, device2, admin, techSite, viewer, code, sha;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'haccp-test', plan: 'pro' });
    await db.query(`UPDATE tenants SET legal_name = 'ТОВ «Морозко»', tax_id = '12345678' WHERE id = $1`, [tenant.id]);
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, address_line, city, country, timezone) VALUES ($1, 'Магазин №1', 'вул. Соборна 10', 'Луцьк', 'Україна', 'Europe/Kyiv') RETURNING id`, [tenant.id]);
    site = rows[0];
    device  = await createDevice(tenant.id, { mqttId: 'HAC001', name: 'Вітрина 1' });
    device2 = await createDevice(tenant.id, { mqttId: 'HAC002', name: 'Вітрина 2' });
    await db.query('UPDATE devices SET site_id = $1, serial_number = $2 WHERE id = ANY($3)', [site.id, 'SN-0001', [device.id, device2.id]]);
    admin    = await createUser(tenant.id, { role: 'admin', email: 'admin@haccp.test' });
    techSite = await createUser(tenant.id, { role: 'technician', email: 'tech@haccp.test' });
    viewer   = await createUser(tenant.id, { role: 'viewer', email: 'viewer@haccp.test' });
    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)', [techSite.id, site.id, tenant.id, admin.id]);

    const start = new Date(Date.now() - 2 * DAY);
    await insertRaw(tenant.id, 'HAC001', start, 6);
    await insertRaw(tenant.id, 'HAC002', start, 3);
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at, acknowledged_by, acknowledged_at)
       VALUES ($1, 'HAC001', 'high_temp_alarm', 'critical', false, $2, $3, $4, $3)`,
      [tenant.id, new Date(start.getTime() + 3600000), new Date(start.getTime() + 7200000), admin.id]);
    await db.query(
      `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done)
       VALUES ($1, $2, '2026-08-15', 'Іван Петренко', 'Планове ТО', 'Перевірка датчиків, чистка конденсатора')`, [tenant.id, device.id]);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('produces a localised PDF with a verification code and registers it', async () => {
    const from = new Date(Date.now() - 3 * DAY).toISOString();
    const to = new Date().toISOString();
    const res = await request(app)
      .get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&lang=uk`)
      .set(authHeader(admin, tenant.id))
      .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['x-report-code']).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.headers['x-report-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers['x-report-source']).toBe('raw');
    code = res.headers['x-report-code'];
    sha  = res.headers['x-report-sha256'];

    const { rows } = await db.query('SELECT * FROM report_exports WHERE code = $1', [code.replace(/-/g, '')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'device', tenant_id: tenant.id, device_id: 'HAC001', site_id: site.id, sha256: sha, lang: 'uk', generated_by: 'admin@haccp.test' });

    await new Promise(r => setTimeout(r, 200));
    const { rows: audit } = await db.query(`SELECT action, changes FROM audit_log WHERE action = 'export.haccp_pdf' AND entity_id = 'HAC001'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.code).toBe(code.replace(/-/g, ''));
  });

  it('the public verification endpoint confirms the code without leaking ids', async () => {
    const res = await request(app).get(`/api/public/report/${code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ code, kind: 'device', organisation: 'ТОВ «Морозко»', site: 'Магазин №1', device: 'Вітрина 1', sha256: sha, valid: true });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(tenant.id);
    expect(text).not.toContain('HAC001');
    expect(text).not.toContain('haccp.test');
    expect((await request(app).get('/api/public/report/ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
    expect((await request(app).get('/api/public/report/short')).status).toBe(404);
  });

  it('renders the other languages and rejects a bad bucket', async () => {
    const from = new Date(Date.now() - 3 * DAY).toISOString();
    const to = new Date().toISOString();
    for (const lang of ['en', 'pl', 'de']) {
      const res = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&lang=${lang}`)
        .set(authHeader(admin, tenant.id)).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
    }
    const bad = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&bucket=2h`).set(authHeader(admin, tenant.id));
    expect(bad.status).toBe(400);
    expect(haccp.strings('pl').title).toMatch(/HACCP/);
    expect(haccp.strings('xx').title).toBe(haccp.strings('uk').title);
  });

  it('a site report covers every device of the site; access needs a site grant', async () => {
    const from = new Date(Date.now() - 3 * DAY).toISOString();
    const to = new Date().toISOString();
    const parse = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
    const res = await request(app).get(`/api/sites/${site.id}/export.pdf?from=${from}&to=${to}`).set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    const { rows } = await db.query('SELECT kind, device_id, site_id FROM report_exports WHERE code = $1', [res.headers['x-report-code'].replace(/-/g, '')]);
    expect(rows[0]).toMatchObject({ kind: 'site', device_id: null, site_id: site.id });

    expect((await request(app).get(`/api/sites/${site.id}/export.pdf?from=${from}&to=${to}`).set(authHeader(techSite, tenant.id)).buffer(true).parse(parse)).status).toBe(200);
    expect((await request(app).get(`/api/sites/${site.id}/export.pdf?from=${from}&to=${to}`).set(authHeader(viewer, tenant.id))).status).toBe(403);
    expect((await request(app).get(`/api/sites/${site.id}/export.pdf?from=${from}&to=${to}`).set(authHeader(admin, tenant.id)).buffer(true).parse(parse)).status).toBe(200);
  });

  it('falls back to the hourly archive for a period older than the raw retention', async () => {
    // basic: 400 days of raw data, and it still includes the "reports" feature (free does not)
    await db.query(`UPDATE tenants SET plan = 'basic' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    const start = new Date(Date.now() - 450 * DAY);
    const values = [];
    for (let h = 0; h < 48; h++) {
      const hour = new Date(start.getTime() + h * 3600000).toISOString();
      values.push(`('${tenant.id}', 'HAC001', 'air', '${hour}', -19, -17, -18, 12)`);
    }
    await db.query(`INSERT INTO telemetry_hourly (tenant_id, device_id, channel, hour, min, max, avg, samples) VALUES ${values.join(',')}`);

    const from = start.toISOString();
    const to = new Date(start.getTime() + 2 * DAY).toISOString();
    const res = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&bucket=15m`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['x-report-source']).toBe('hourly');
    const { rows } = await db.query('SELECT bucket, source FROM report_exports WHERE code = $1', [res.headers['x-report-code'].replace(/-/g, '')]);
    expect(rows[0]).toEqual({ bucket: '1h', source: 'hourly' });   // 15m is meaningless on hourly data

    const empty = await request(app).get(`/api/devices/${device2.id}/telemetry/export.pdf?from=${from}&to=${to}`).set(authHeader(admin, tenant.id));
    expect(empty.status).toBe(404);
    expect(empty.body.error).toBe('no_data');
    await db.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
  });

  it('planSource() picks the source and widens the bucket for long windows', () => {
    const now = new Date('2026-09-02T12:00:00Z');
    const d = (n) => new Date(now.getTime() - n * DAY);
    expect(haccp.planSource({ from: d(5), to: now, rawRetentionDays: 90, bucketKey: '5m', now })).toMatchObject({ source: 'raw', bucketKey: '5m' });
    expect(haccp.planSource({ from: d(100), to: d(95), rawRetentionDays: 90, bucketKey: '5m', now })).toMatchObject({ source: 'hourly', bucketKey: '1h' });
    expect(haccp.planSource({ from: d(60), to: now, rawRetentionDays: 90, bucketKey: '1h', now }).bucketKey).toBe('6h');
    expect(haccp.planSource({ from: d(200), to: now, rawRetentionDays: 800, bucketKey: '1h', now }).bucketKey).toBe('1d');
  });

  it('the inventory CSV is reachable at its new path', async () => {
    const res = await request(app).get('/api/devices/export/inventory.csv').set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('HAC001');
  });
});

describe('telemetry retention: downsample and per-plan purge', () => {
  let tenant;

  beforeAll(async () => {
    tenant = await createTenant({ slug: 'retention-plan', plan: 'free' });   // 30 days raw
    await db.query('DELETE FROM telemetry_hourly');
    const yesterday = new Date(Date.now() - DAY); yesterday.setUTCHours(0, 0, 0, 0);
    await insertRaw(tenant.id, 'RET001', yesterday, 2);                        // 24 raw rows/channel
    await insertRaw(tenant.id, 'RET001', new Date(Date.now() - 40 * DAY), 1);  // past free retention
  });

  const query = (sql, params) => db.query(sql, params);

  it('downsampleHourly() folds raw rows into telemetry_hourly, idempotently', async () => {
    const first = await cleanupTelemetry.downsampleHourly({ query, lookbackDays: 3 });
    expect(first.upserted).toBeGreaterThanOrEqual(6);        // 2 hours × 3 channels
    const { rows } = await db.query(`SELECT channel, samples, min, max FROM telemetry_hourly WHERE device_id = 'RET001' ORDER BY hour, channel`);
    expect(rows.length).toBe(6);
    expect(rows[0].samples).toBe(12);
    const again = await cleanupTelemetry.downsampleHourly({ query, lookbackDays: 3 });
    expect(again.upserted).toBe(first.upserted);
    expect((await db.query(`SELECT count(*)::int AS n FROM telemetry_hourly WHERE device_id = 'RET001'`)).rows[0].n).toBe(6);
  });

  it('purgeRaw() deletes only rows older than the organisation plan retention', async () => {
    const dry = await cleanupTelemetry.purgeRaw({ query, apply: false });
    const mine = dry.find(r => r.tenant_id === tenant.id);
    expect(mine.retention_days).toBe(30);
    expect(mine.candidates).toBe(36);                       // 1 hour × 12 samples × 3 channels
    const applied = await cleanupTelemetry.purgeRaw({ query, apply: true });
    expect(applied.find(r => r.tenant_id === tenant.id).deleted).toBe(36);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM telemetry WHERE device_id = 'RET001'`);
    expect(rows[0].n).toBe(72);                              // yesterday's 2 hours stay
    expect((await db.query(`SELECT count(*)::int AS n FROM telemetry_hourly WHERE device_id = 'RET001'`)).rows[0].n).toBe(6);
  });

  it('a superadmin raw-retention override wins over the plan until the plan is changed', async () => {
    const admin = await createUser(tenant.id, { role: 'admin', email: 'admin@retention.test' });
    const other = await createTenant({ slug: 'retention-super', plan: 'pro' });
    const superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@retention.test' });

    // Only a superadmin may set it; the organisation admin is refused, not silently ignored
    const denied = await request(app).patch(`/api/tenants/${tenant.id}/settings`)
      .set(authHeader(admin, tenant.id)).send({ raw_retention_days: 400 });
    expect(denied.status).toBe(403);
    const set = await request(app).patch(`/api/tenants/${tenant.id}/settings`)
      .set(authHeader(superadmin, other.id)).send({ raw_retention_days: 400 });
    expect(set.status).toBe(200);
    expect(set.body.data.raw_retention_days).toBe(400);
    expect(set.body.data.retention_days).toBe(400);            // effective value, plan says 30

    await insertRaw(tenant.id, 'RET001', new Date(Date.now() - 40 * DAY), 1);   // past the free plan, inside the override
    const dry = await cleanupTelemetry.purgeRaw({ query, apply: false });
    const mine = dry.find(r => r.tenant_id === tenant.id);
    expect(mine.retention_days).toBe(400);
    expect(mine.candidates).toBe(0);

    // The organisation read shows the effective retention too
    const read = await request(app).get(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id));
    expect(read.body.data.retention_days).toBe(400);

    // An explicit plan change clears the grandfathered value
    const changed = await request(app).patch(`/api/tenants/${tenant.id}`)
      .set(authHeader(superadmin, other.id)).send({ plan: 'basic' });
    expect(changed.status).toBe(200);
    const { rows } = await db.query('SELECT raw_retention_days FROM tenant_settings WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].raw_retention_days).toBeNull();
    await db.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    await cleanupTelemetry.purgeRaw({ query, apply: true });
  });

  it('purgeHourly() keeps three years', async () => {
    await db.query(`INSERT INTO telemetry_hourly VALUES ($1, 'RET001', 'air', now() - interval '1200 days', -1, 1, 0, 1)`, [tenant.id]);
    const r = await cleanupTelemetry.purgeHourly({ query, apply: true });
    expect(r.deleted).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM telemetry_hourly WHERE device_id = 'RET001'`)).rows[0].n).toBe(6);
  });
});

// ── The temperature-control journal (form of 2026-09) ──────

describe('HACCP journal: limits, deviations, gaps, corrective actions', () => {
  const S = haccp.strings('uk');
  const T = haccp.__test;
  const from = new Date('2026-09-07T00:00:00Z');
  const to   = new Date('2026-09-07T08:00:00Z');
  const hour = (i) => new Date(from.getTime() + i * 3600e3);

  it('limitsFor(): the business limits win over the controller, and neither is a silent blank', () => {
    expect(T.limitsFor({ haccp_min: '-18.00', haccp_max: '-15.00', last_state: { 'protection.high_limit': -10, 'protection.low_limit': -30 } }))
      .toEqual({ min: -18, max: -15, source: 'org' });
    expect(T.limitsFor({ haccp_min: null, haccp_max: 6, last_state: null })).toEqual({ min: null, max: 6, source: 'org' });
    expect(T.limitsFor({ haccp_min: null, haccp_max: null, last_state: { 'protection.high_limit': -10, 'protection.low_limit': -30 } }))
      .toEqual({ min: -30, max: -10, source: 'controller' });
    expect(T.limitsFor({ last_state: {} })).toEqual({ min: null, max: null, source: null });
    expect(T.fmtLimits(S, { min: -18, max: -15 })).toBe('-18…-15 °C');
    expect(T.fmtLimits(S, { min: null, max: 6 })).toBe('≤ 6 °C');
    expect(T.fmtLimits(S, { min: 2, max: null })).toBe('≥ 2 °C');
    expect(T.fmtLimits(S, { min: null, max: null })).toBe(S.limits_none);
    expect(T.deviationOf(-12, { min: -18, max: -15 })).toBe('above');
    expect(T.deviationOf(-20, { min: -18, max: -15 })).toBe('below');
    expect(T.deviationOf(-16, { min: -18, max: -15 })).toBeNull();
    expect(T.deviationOf(-40, { min: null, max: -15 })).toBeNull();
  });

  it('buildJournal(): every interval of the period, gaps named, deviations flagged, actions from the alarms', () => {
    const buckets = [];
    for (let i = 0; i < 8; i++) {
      if (i === 2 || i === 3) continue;                       // two hours without data
      const hot = i === 5 || i === 6;                         // two hours above the limit
      buckets.push({ time: hour(i).toISOString(),
        air: { min: hot ? -14 : -17.9, max: hot ? -12 : (i === 7 ? -13 : -17), avg: hot ? -13 : -17.5, samples: 12 },
        evap: { min: -25, max: -22, avg: -24, samples: 12 } });
    }
    const alarms = [
      { id: 1, alarm_code: 'high_temp_alarm', severity: 'critical', value: -12.4, limit_value: -15, triggered_at: new Date(hour(5).getTime() + 600e3),
        cleared_at: hour(7), acknowledged_at: new Date(hour(5).getTime() + 1500e3), ack_note: 'двері', ack_by: 'admin@x', wo_id: 7, wo_status: 'done' },
      { id: 2, alarm_code: 'device_offline', severity: 'warning', triggered_at: hour(2), cleared_at: hour(4) },
    ];
    const j = T.buildJournal({ buckets, channels: ['air', 'evap'], from, to, bucketSec: 3600, limits: { min: -18, max: -15, source: 'org' }, alarms, tz: 'Europe/Kyiv', S, lang: 'uk' });
    expect(j.primary).toBe('air');
    expect(j.others).toEqual(['evap']);
    expect(j.hasLimits).toBe(true);
    expect(j.stats).toMatchObject({ slots: 8, deviations: 2, gaps: 2, longestRun: 2, worst: -13, peaks: 1 });
    expect(j.days).toHaveLength(1);
    const rows = j.days[0].rows;
    expect(rows.map(r => r.clock)).toEqual(['03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00']);   // Kyiv = UTC+3
    expect(rows[2]).toMatchObject({ gap: true, offline: true });
    expect(rows[3]).toMatchObject({ gap: true, offline: true });
    expect(rows[5]).toMatchObject({ gap: false, deviation: 'above' });
    expect(rows[5].actions[0]).toContain('Висока температура');
    expect(rows[5].actions[0]).toContain('Підтверджено 08:25 admin@x «двері»');
    expect(rows[5].actions[0]).toContain('Наряд #7 (виконано)');
    expect(rows[6]).toMatchObject({ deviation: 'above', actions: [] });
    expect(rows[7]).toMatchObject({ deviation: null, peak: true });               // max above the limit, average inside
    expect(j.days[0]).toMatchObject({ deviations: 2, gaps: 2 });

    // Without limits nothing is flagged, and the journal says so through hasLimits
    const none = T.buildJournal({ buckets, channels: ['air'], from, to, bucketSec: 3600, limits: { min: null, max: null, source: null }, alarms: [], tz: 'UTC', S, lang: 'uk' });
    expect(none.hasLimits).toBe(false);
    expect(none.stats.deviations).toBe(0);
    expect(none.days[0].rows[0].clock).toBe('00:00');
  });

  it('alarm names come out in the report language', () => {
    expect(T.alarmName('uk', 'high_temp_alarm')).toBe('Висока температура');
    expect(T.alarmName('de', 'protection.door_alarm')).toMatch(/Tür/);
    expect(T.alarmName('en', 'device_offline')).toBe('Device Offline');
    expect(T.alarmName('pl', 'something_new')).toBe('something_new');
  });
});

describe('HACCP journal end to end', () => {
  let tenant, site, device, admin;
  const parse = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'haccp-journal', plan: 'pro' });
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, city, country, timezone) VALUES ($1, 'Магазин №2', 'Львів', 'Україна', 'Europe/Kyiv') RETURNING id`, [tenant.id]);
    site = rows[0];
    device = await createDevice(tenant.id, { mqttId: 'HACJ01', name: 'Бонета' });
    await db.query(`UPDATE devices SET site_id = $1, last_state = '{"protection.high_limit": -10, "protection.low_limit": -30}'::jsonb WHERE id = $2`, [site.id, device.id]);
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@journal.test' });
  });

  afterAll(async () => { await cleanDatabase(); });

  it('the business sets the critical limits on the equipment; min must stay below max', async () => {
    const bad = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id)).send({ haccp_min: -10, haccp_max: -18 });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id))
      .send({ haccp_min: -18, haccp_max: -15, haccp_product: 'заморожені напівфабрикати' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ haccp_min: '-18.00', haccp_max: '-15.00', haccp_product: 'заморожені напівфабрикати' });
    const got = await request(app).get(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id));
    expect(got.body.data).toMatchObject({ haccp_min: '-18.00', haccp_max: '-15.00', haccp_product: 'заморожені напівфабрикати' });
    const cleared = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id)).send({ haccp_product: '' });
    expect(cleared.body.data.haccp_product).toBeNull();
  });

  it('the PDF carries the limits, flags the deviation, names the gap and the corrective action', async () => {
    const start = new Date(Date.now() - 2 * DAY);
    start.setUTCMinutes(0, 0, 0);
    // 8 hours of data with a 2-hour gap and a 2-hour excursion
    const values = []; const params = []; let i = 1;
    for (let h = 0; h < 8; h++) {
      if (h === 2 || h === 3) continue;
      for (let m = 0; m < 60; m += 5) {
        const t = new Date(start.getTime() + h * 3600e3 + m * 60e3);
        values.push(`($${i++}, $${i++}, $${i++}, 'air', $${i++})`);
        params.push(t, tenant.id, 'HACJ01', (h === 5 || h === 6) ? -12.5 : -17.4);
      }
    }
    await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
    const { rows: al } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, value, limit_value, triggered_at, cleared_at, acknowledged_by, acknowledged_at, ack_note)
       VALUES ($1, 'HACJ01', 'high_temp_alarm', 'critical', false, -12.5, -15, $2, $3, $4, $5, 'Завантаження товару') RETURNING id`,
      [tenant.id, new Date(start.getTime() + 5 * 3600e3 + 300e3), new Date(start.getTime() + 7 * 3600e3), admin.id, new Date(start.getTime() + 5 * 3600e3 + 900e3)]);
    await db.query(
      `INSERT INTO work_orders (tenant_id, site_id, device_id, device_mqtt_id, alarm_id, title, status, created_by, closed_at, closed_reason)
       VALUES ($1, $2, $3, 'HACJ01', $4, 'Перевірити ущільнювач', 'done', $5, now(), 'Ущільнювач замінено')`,
      [tenant.id, site.id, device.id, al[0].id, admin.id]);

    // What the document is built from (the device row as the export route reads it)
    const q = (sql, p) => db.query(sql, p);
    const fresh = async () => (await db.query('SELECT * FROM devices WHERE id = $1', [device.id])).rows[0];
    const d = await T_collect(q, tenant.id, await fresh(), start, new Date(start.getTime() + 8 * 3600e3));
    expect(d.limits).toEqual({ min: -18, max: -15, source: 'org' });
    expect(d.alarms).toHaveLength(1);
    expect(d.alarms[0]).toMatchObject({ alarm_code: 'high_temp_alarm', ack_note: 'Завантаження товару', ack_by: admin.email, wo_status: 'done', wo_closed_reason: 'Ущільнювач замінено' });
    const canon = JSON.parse(haccp.canonicalData({ kind: 'device', tenant, site, devices: [d], from: start, to: new Date(start.getTime() + 8 * 3600e3), bucketKey: '1h', source: 'raw', generatedAt: 'x' }));
    expect(canon.devices[0].limits).toEqual([-18, -15, 'org']);

    const from = start.toISOString(), to = new Date(start.getTime() + 8 * 3600e3).toISOString();
    const res = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&lang=uk&bucket=1h`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(20000);

    // The controller's own limits take over once the business clears its own
    await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id)).send({ haccp_min: null, haccp_max: null });
    const d2 = await T_collect(q, tenant.id, await fresh(), start, new Date(start.getTime() + 8 * 3600e3));
    expect(d2.limits).toEqual({ min: -30, max: -10, source: 'controller' });
    const res2 = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from}&to=${to}&lang=en`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res2.status).toBe(200);
  });

  async function T_collect(query, tenantId, dev, from, to) {
    return haccp.__test.collectDevice({ query, device: dev, tenantId, channels: ['air', 'evap', 'setpoint'], from, to, bucketSec: 3600, source: 'raw' });
  }
});
