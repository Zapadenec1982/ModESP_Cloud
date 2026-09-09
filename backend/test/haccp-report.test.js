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

describe('HACCP inspector report: limits, excursions, gaps, notes', () => {
  const S = haccp.strings('uk');
  const T = haccp.__test;
  const from = new Date('2026-09-04T00:00:00Z');
  const to   = new Date('2026-09-04T08:00:00Z');
  const at = (min) => from.getTime() + min * 60e3;
  const STEP = 5 * 60e3;
  // Eight hours of 5-minute samples: −19 °C, with the exceptions the callers add
  const series = (edit) => {
    const pts = [];
    for (let m = 0; m < 8 * 60; m += 5) { const p = { t: at(m), v: -19 }; if (edit(p, m) === false) continue; pts.push(p); }
    return pts;
  };
  const limits = { min: null, max: -18, source: 'org' };

  it('limits: the business wins over the device; the sentence and the column say what the limit is', () => {
    expect(T.limitsFor({ haccp_min: null, haccp_max: '-18.00', last_state: { 'protection.high_limit': -10 } })).toEqual({ min: null, max: -18, source: 'org' });
    expect(T.limitsFor({ haccp_min: null, haccp_max: null, last_state: { 'protection.high_limit': -10, 'protection.low_limit': -30 } })).toEqual({ min: -30, max: -10, source: 'controller' });
    expect(T.limitsFor({ last_state: {} })).toEqual({ min: null, max: null, source: null });
    expect(T.toleranceOf({ haccp_tolerance: '3.0' })).toBe(3);
    expect(T.toleranceOf({ haccp_tolerance: null })).toBe(0);
    expect(T.limitSentence(S, limits, 3)).toBe('не вище -18 °C, допустиме відхилення 3 °C (за програмою HACCP підприємства)');
    expect(T.limitSentence(S, { min: 2, max: 6, source: 'controller' }, 0)).toBe('від 2 до 6 °C (за налаштуваннями приладу)');
    expect(T.limitSentence(S, { min: null, max: null, source: null }, 0)).toContain(S.limit_none);
    expect(T.limitShort(limits, 3)).toBe('≤ -18 (+3)');
    expect(T.limitShort({ min: 2, max: 6 }, 0)).toBe('2…6');
    expect(T.limitShort({ min: null, max: null }, 0)).toBe('—');
  });

  it('excursions: past the limit plus tolerance for at least the threshold; a short blip and defrost do not count', () => {
    // 09:00–09:15 blip (15 min, −14: past −15) — below the 30-minute threshold
    // 12:00–12:20 defrost with air up to −13 — excluded
    // 15:00–15:50 at −12 (50 min) — an excursion
    const points = series((p, m) => {
      if (m >= 60 && m < 75) p.v = -14;
      if (m >= 180 && m < 200) p.v = -13;
      if (m >= 300 && m < 350) p.v = -12 + (m % 10 === 0 ? 0.5 : 0);
    });
    const defrost = [[at(180), at(200)]];
    const ex = T.detectExcursions({ points, limits, tolerance: 3, excursionMin: 30, defrost, stepMs: STEP, hourly: false });
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ start: at(300), end: at(350), minutes: 50, kind: 'above', peak: -11.5 });
    // Without the tolerance the −14 blip is still too short; without the defrost exclusion the 12:00 spike becomes an excursion? No — 20 min < 30
    expect(T.detectExcursions({ points, limits, tolerance: 0, excursionMin: 30, defrost: [], stepMs: STEP, hourly: false })).toHaveLength(1);
    // A lower threshold catches the blip too
    expect(T.detectExcursions({ points, limits, tolerance: 3, excursionMin: 10, defrost, stepMs: STEP, hourly: false })).toHaveLength(2);
    // No limits — nothing to evaluate
    expect(T.detectExcursions({ points, limits: { min: null, max: null, source: null }, tolerance: 0, excursionMin: 30, defrost, stepMs: STEP, hourly: false })).toEqual([]);
    // A data gap inside a run ends it
    const broken = points.filter(p => !(p.t >= at(320) && p.t < at(335)));
    const ex2 = T.detectExcursions({ points: broken, limits, tolerance: 3, excursionMin: 30, defrost, stepMs: STEP, hourly: false });
    expect(ex2).toHaveLength(0);
    // Hourly archive: the hour's max decides, one hour is one interval
    const hourly = [{ t: at(0), min: -19.5, max: -18.5, avg: -19, samples: 12 }, { t: at(60), min: -19, max: -12, avg: -15, samples: 12 }, { t: at(120), min: -19, max: -12.5, avg: -15, samples: 12 }];
    const ex3 = T.detectExcursions({ points: hourly, limits, tolerance: 3, excursionMin: 30, defrost: [], stepMs: 3600e3, hourly: true });
    expect(ex3).toEqual([{ start: at(60), end: at(180), minutes: 120, kind: 'above', peak: -12 }]);
  });

  it('defrost intervals come from the defrost channel; gaps are stretches longer than one measurement interval', () => {
    const defrostPts = [];
    for (let m = 0; m < 480; m += 5) defrostPts.push({ t: at(m), v: (m >= 180 && m < 200) ? 1 : 0 });
    expect(T.defrostIntervals(defrostPts, STEP, false)).toEqual([[at(180), at(200)]]);
    expect(T.defrostIntervals([{ t: at(60), v: 0.4 }, { t: at(120), v: 0 }], 3600e3, true)).toEqual([[at(60), at(120)]]);

    const points = series((p, m) => (m >= 120 && m < 150 ? false : undefined));   // 30 minutes missing at 02:00
    expect(T.stepOf(points, 60)).toBe(STEP);
    const gaps = T.detectGaps({ points, from, to, stepMs: STEP, hourly: false });
    expect(gaps).toEqual([{ from: at(120), to: at(150), minutes: 30 }]);
    // One missing sample is not a gap; a missing head or tail of the period is
    const oneMissing = series((p, m) => (m === 200 ? false : undefined));
    expect(T.detectGaps({ points: oneMissing, from, to, stepMs: STEP, hourly: false })).toEqual([]);
    const late = series((p, m) => (m < 30 ? false : undefined));
    expect(T.detectGaps({ points: late, from, to, stepMs: STEP, hourly: false })).toEqual([{ from: at(0), to: at(30), minutes: 30 }]);
    expect(T.detectGaps({ points: [], from, to, stepMs: STEP, hourly: false })).toEqual([{ from: at(0), to: at(480), minutes: 480 }]);
    // Hourly: missing hours
    const hourly = [0, 1, 4, 5, 6, 7].map(h => ({ t: at(h * 60), min: -19, max: -18, avg: -18.5, samples: 12 }));
    expect(T.detectGaps({ points: hourly, from, to, stepMs: 3600e3, hourly: true })).toEqual([{ from: at(120), to: at(240), minutes: 120 }]);
  });

  it('log rows: interval average, the deviation flag from the excursions, notes for defrost, door and gap', () => {
    const buckets = [];
    for (let h = 0; h < 8; h++) {
      if (h === 2) continue;
      buckets.push({ time: new Date(at(h * 60)).toISOString(), air: { min: -19.5, max: h === 3 ? -13 : -18.5, avg: h === 5 ? -12.4 : (h === 3 ? -17.3 : -19), samples: 12 } });
    }
    const d = {
      buckets, defrost: [[at(180), at(200)]], doors: [[at(65), at(90)]],
      excursions: [{ start: at(300), end: at(350), minutes: 50, kind: 'above', peak: -11.5 }],
      gaps: [{ from: at(120), to: at(180), minutes: 60 }],
    };
    const days = T.buildRows({ d, from, to, bucketSec: 3600, tz: 'Europe/Kyiv', S, doorMin: 10 });
    expect(days).toHaveLength(1);
    const rows = days[0].rows;
    expect(rows.map(r => r.clock)).toEqual(['03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00']);   // Kyiv = UTC+3
    expect(rows[1]).toMatchObject({ deviation: false, gap: false, notes: ['двері > 10 хв'] });
    expect(rows[2]).toMatchObject({ value: null, gap: true, notes: ['розрив'] });
    expect(rows[3]).toMatchObject({ value: -17.3, deviation: false, notes: ['відтайка'] });        // defrost hour: not an excursion
    expect(rows[5]).toMatchObject({ value: -12.4, deviation: true, notes: [] });
    expect(days[0].deviations).toBe(1);
    expect(T.actionFor(S, d.excursions[0], [{ created: at(330), title: 'Перевірити двері', status: 'done', closed_reason: 'Ущільнювач замінено', assignee: 'tech@x', technician: null }]))
      .toEqual({ action: 'Ущільнювач замінено', responsible: 'tech@x' });
    expect(T.actionFor(S, d.excursions[0], [{ created: at(330), title: 'Перевірити двері', status: 'assigned', closed_reason: null, assignee: null, technician: 'Іван' }]))
      .toEqual({ action: 'Перевірити двері (призначено)', responsible: 'Іван' });
    expect(T.actionFor(S, d.excursions[0], [])).toEqual({ action: '', responsible: '' });
    expect(T.fmtDuration(50, S)).toBe('50 хв');
    expect(T.fmtDuration(135, S)).toBe('2 год 15 хв');
    expect(T.fmtDuration(1500, S)).toBe('1 дн 1 год');
  });
});

describe('HACCP inspector report end to end', () => {
  let tenant, site, device, admin;
  const parse = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
  const T = haccp.__test;
  const q = (sql, p) => db.query(sql, p);
  // 04.09 00:00 Kyiv → 06.09 00:00 Kyiv, like the acceptance run
  const from = new Date('2026-09-03T21:00:00Z');
  const to   = new Date('2026-09-05T21:00:00Z');
  const at = (min) => new Date(from.getTime() + min * 60e3);

  async function insert(mqttId, edit) {
    const values = []; const params = []; let i = 1;
    for (let m = 0; m < 48 * 60; m += 5) {
      const utcH = ((from.getUTCHours() + m / 60) % 24);
      const p = { air: -19.3, defrost: 0, evap: -25 };
      if (utcH >= 9 && utcH < 9.34) { p.defrost = 1; p.air = -19 + (utcH - 9) / 0.34 * 5.5; }     // 12:00–12:20 Kyiv defrost, air up to −13.5
      else if (utcH >= 9.34 && utcH < 9.67) p.air = -13.5 - (utcH - 9.34) / 0.33 * 5.8;
      if (edit(p, m) === false) continue;
      for (const [ch, v] of Object.entries(p)) { values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`); params.push(at(m), tenant.id, mqttId, ch, v); }
    }
    await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  }

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'haccp-inspector', plan: 'pro' });
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, city, country, timezone) VALUES ($1, 'Магазин №2', 'Львів', 'Україна', 'Europe/Kyiv') RETURNING id`, [tenant.id]);
    site = rows[0];
    device = await createDevice(tenant.id, { mqttId: 'EE0000000007', name: 'Бонета морозильна' });
    await db.query(`UPDATE devices SET site_id = $1, last_state = '{"protection.high_limit": -10, "protection.low_limit": -30}'::jsonb WHERE id = $2`, [site.id, device.id]);
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@inspector.test' });
  });

  afterAll(async () => { await cleanDatabase(); });

  it('the business sets the critical limit, tolerance and product; the excursion threshold lives on the organisation and the site', async () => {
    const bad = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id)).send({ haccp_min: -10, haccp_max: -18 });
    expect(bad.status).toBe(400);
    const badTol = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id)).send({ haccp_tolerance: -1 });
    expect(badTol.status).toBe(400);
    const ok = await request(app).patch(`/api/devices/${device.id}`).set(authHeader(admin, tenant.id))
      .send({ haccp_max: -18, haccp_tolerance: 3, haccp_product: 'заморожені напівфабрикати' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ haccp_min: null, haccp_max: '-18.00', haccp_tolerance: '3.0', haccp_product: 'заморожені напівфабрикати' });

    const settings = await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id)).send({ haccp_excursion_min: 45 });
    expect(settings.status).toBe(200);
    expect(settings.body.data.haccp_excursion_min).toBe(45);
    expect(settings.body.data.defaults.haccp_excursion_min).toBe(30);
    const tooLong = await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id)).send({ haccp_excursion_min: 0 });
    expect(tooLong.status).toBe(400);
    const siteRes = await request(app).patch(`/api/sites/${site.id}`).set(authHeader(admin, tenant.id)).send({ haccp_excursion_min: 30 });
    expect(siteRes.status).toBe(200);
    expect(siteRes.body.data.haccp_excursion_min).toBe(30);
    const siteCleared = await request(app).patch(`/api/sites/${site.id}`).set(authHeader(admin, tenant.id)).send({ haccp_excursion_min: null });
    expect(siteCleared.body.data.haccp_excursion_min).toBeNull();
    await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id)).send({ haccp_excursion_min: 30 });
  });

  it('acceptance: a clean two days — the 12:00 row says "відтайка" and is not an excursion, no evaporator, both blocks empty', async () => {
    await insert('EE0000000007', () => {});
    const { rows: [fresh] } = await db.query('SELECT * FROM devices WHERE id = $1', [device.id]);
    const d = await T.collectDevice({ query: q, device: fresh, tenantId: tenant.id, from, to, bucketSec: 3600, source: 'raw', excursionMin: 30, samplingSec: 60 });
    expect(d.stepSec).toBe(300);
    expect(d.limits).toEqual({ min: null, max: -18, source: 'org' });
    expect(d.tolerance).toBe(3);
    expect(d.defrost).toHaveLength(2);
    expect(d.excursions).toEqual([]);
    expect(d.gaps).toEqual([]);
    expect(Number(d.summary.max)).toBeCloseTo(-13.5, 0);
    const S = haccp.strings('uk');
    const days = T.buildRows({ d, from, to, bucketSec: 3600, tz: 'Europe/Kyiv', S, doorMin: 10 });
    expect(days.map(x => x.day)).toEqual(['2026-09-04', '2026-09-05']);
    for (const day of days) {
      const noon = day.rows.find(r => r.clock === '12:00');
      expect(noon).toMatchObject({ deviation: false, gap: false, notes: ['відтайка'] });
      expect(day.rows.filter(r => r.deviation)).toHaveLength(0);
      expect(day.rows).toHaveLength(24);
    }
    const { docDefinition } = T.buildDocument({
      kind: 'device', lang: 'uk', tz: 'Europe/Kyiv', tenant: { ...tenant, legal_name: 'ТОВ «Морозко»' }, site, devices: [d], from, to,
      bucketKey: '1h', bucketSec: 3600, source: 'raw', generatedBy: 'test', generatedAt: new Date().toISOString(),
      code: 'ABCDEFGHJKLM', hash: 'ab'.repeat(32), verifyUrl: 'https://modesp.com.ua/api/public/report/ABCDEFGHJKLM', rawRetentionDays: 400, doorMin: 10,
    });
    const text = JSON.stringify(docDefinition.content);
    expect(text).not.toContain('Випарник');
    expect(text).not.toContain('Аварії');
    expect(text).toContain(S.excursions_none);
    expect(text).toContain(S.gaps_none);
    expect(text).toContain('не вище -18 °C, допустиме відхилення 3 °C');
    expect(text).toContain('кожні 5 хв');
    expect(text).toContain('400 днів');
    expect(text).toContain('довше ніж 30 хв');
    expect(JSON.stringify(docDefinition.content.find(c => c.columns && c.columns.some(x => x.qr)))).toContain('"qr":"https://modesp.com.ua/api/public/report/ABCDEFGHJKLM"');

    const res = await request(app).get(`/api/devices/${device.id}/telemetry/export.pdf?from=${from.toISOString()}&to=${to.toISOString()}&lang=uk&bucket=1h`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(30000);
  });

  it('a 50-minute excursion, a 30-minute recording gap and a door alarm show up with the corrective action from the work order', async () => {
    const dev2 = await createDevice(tenant.id, { mqttId: 'EE0000000008', name: 'Камера заморозки' });
    await db.query(`UPDATE devices SET site_id = $1, haccp_max = -18, haccp_tolerance = 3 WHERE id = $2`, [site.id, dev2.id]);
    // 05.09 03:00–03:30 Kyiv: no data; 05.09 15:00–15:50 Kyiv: −12; 04.09 09:00–09:15 Kyiv: −14 (too short)
    await insert('EE0000000008', (p, m) => {
      if (m >= 27 * 60 && m < 27 * 60 + 30) return false;
      if (m >= 39 * 60 && m < 39 * 60 + 50) p.air = -12;
      if (m >= 9 * 60 && m < 9 * 60 + 15) p.air = -14;
    });
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, 'EE0000000008', 'door_alarm', 'warning', false, $2, $3), ($1, 'EE0000000008', 'high_temp_alarm', 'critical', false, $4, $5)`,
      [tenant.id, at(39 * 60 + 5), at(39 * 60 + 30), at(39 * 60 + 10), at(39 * 60 + 55)]);
    await db.query(
      `INSERT INTO work_orders (tenant_id, site_id, device_id, device_mqtt_id, title, status, created_by, assigned_to, created_at, closed_at, closed_reason)
       VALUES ($1, $2, $3, 'EE0000000008', 'Перевірити ущільнювач', 'done', $4, $4, $5, $6, 'Ущільнювач замінено')`,
      [tenant.id, site.id, dev2.id, admin.id, at(39 * 60 + 40), at(41 * 60)]);

    const { rows: [fresh] } = await db.query('SELECT * FROM devices WHERE id = $1', [dev2.id]);
    const d = await T.collectDevice({ query: q, device: fresh, tenantId: tenant.id, from, to, bucketSec: 3600, source: 'raw', excursionMin: 30, samplingSec: 60 });
    expect(d.excursions).toHaveLength(1);
    expect(d.excursions[0]).toMatchObject({ start: at(39 * 60).getTime(), end: at(39 * 60 + 50).getTime(), minutes: 50, kind: 'above', peak: -12 });
    expect(d.gaps).toEqual([{ from: at(27 * 60).getTime(), to: at(27 * 60 + 30).getTime(), minutes: 30 }]);
    expect(d.doors).toHaveLength(1);
    expect(d.workOrders).toHaveLength(1);
    const S = haccp.strings('uk');
    expect(T.actionFor(S, d.excursions[0], d.workOrders)).toEqual({ action: 'Ущільнювач замінено', responsible: admin.email });
    const days = T.buildRows({ d, from, to, bucketSec: 3600, tz: 'Europe/Kyiv', S, doorMin: 10 });
    const day2 = days[1];
    expect(day2.rows.find(r => r.clock === '03:00')).toMatchObject({ gap: true, deviation: false, notes: ['розрив'] });
    expect(day2.rows.find(r => r.clock === '15:00')).toMatchObject({ deviation: true, notes: ['двері > 10 хв'] });
    expect(days[0].rows.find(r => r.clock === '09:00')).toMatchObject({ deviation: false });
    expect(day2.deviations).toBe(1);
    const canon = JSON.parse(haccp.canonicalData({ kind: 'device', tenant, site, devices: [d], from, to, bucketKey: '1h', source: 'raw', generatedAt: 'x' }));
    expect(canon.devices[0].limits).toEqual([null, -18, 3, 30, 'org']);
    expect(canon.devices[0].excursions).toHaveLength(1);
    expect(canon.devices[0].gaps).toHaveLength(1);

    const res = await request(app).get(`/api/sites/${site.id}/export.pdf?from=${from.toISOString()}&to=${to.toISOString()}&lang=en`)
      .set(authHeader(admin, tenant.id)).buffer(true).parse(parse);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });
});
