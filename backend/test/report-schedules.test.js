'use strict';

// globals: true in vitest.config.js
//
// Scheduled reports (plan epic 2.7): local-time periods, the schedule CRUD
// and its plan gate, a manual run that archives and e-mails the PDFs, the
// archive with per-site access, the due-schedule sweep with its idempotency,
// and the archive purge.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const scheduler = require('../src/services/report-scheduler');
const emailSvc = require('../src/services/email');

const app = createTestApp();
const TZ = 'Europe/Kyiv';

// The previous whole month relative to NOW holds every fixture: NOW is the
// 3rd of the current UTC month at noon, the data sits on the 10th of the
// month before. The "run now" route uses the real clock, which lands on the
// same previous month.
const today = new Date();
const NOW = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 3, 12, 0, 0));
const DATA_AT = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 10, 12, 0, 0));

let mails = [];
emailSvc.sendScheduledReport = async (m) => { mails.push(m); return true; };

async function insertRaw(tenantId, deviceId, start, hours, stepMin = 5) {
  const values = [], params = [];
  let i = 1;
  for (let m = 0; m < hours * 60; m += stepMin) {
    const t = new Date(start.getTime() + m * 60000);
    for (const [ch, base] of [['air', -18], ['evap', -25], ['setpoint', -18], ['energy', 0.05]]) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(t, tenantId, deviceId, ch, ch === 'energy' ? base : base + Math.sin(m / 60));
    }
  }
  await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
}

describe('scheduled reports (plan epic 2.7)', () => {
  let tenant, other, freeTenant, site, site2, device, admin, viewer, tech, otherAdmin, freeAdmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'rep-a', plan: 'pro' });
    other  = await createTenant({ slug: 'rep-b', plan: 'pro' });
    freeTenant = await createTenant({ slug: 'rep-free', plan: 'free' });
    await db.query(`UPDATE tenants SET legal_name = 'ТОВ «Морозко»', electricity_rate = 7.5, electricity_currency = 'UAH' WHERE id = $1`, [tenant.id]);
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, address_line, city, country, timezone) VALUES ($1, 'Магазин №1', 'вул. Соборна 10', 'Луцьк', 'Україна', $2) RETURNING id, name`, [tenant.id, TZ]);
    site = rows[0];
    site2 = (await db.query(`INSERT INTO sites (tenant_id, name, timezone) VALUES ($1, 'Склад без обладнання', $2) RETURNING id, name`, [tenant.id, TZ])).rows[0];
    device = await createDevice(tenant.id, { mqttId: 'REP001', name: 'Вітрина 1' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, device.id]);
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@rep.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@rep.test' });
    tech   = await createUser(tenant.id, { role: 'technician', email: 'tech@rep.test' });
    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)', [tech.id, site.id, tenant.id, admin.id]);
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@rep-b.test' });
    freeAdmin  = await createUser(freeTenant.id, { role: 'admin', email: 'admin@rep-free.test' });

    await insertRaw(tenant.id, 'REP001', DATA_AT, 6);
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at, acknowledged_by, acknowledged_at)
       VALUES ($1, 'REP001', 'high_temp_alarm', 'critical', false, $2, $3, $4, $3),
              ($1, 'REP001', 'door_alarm', 'warning', false, $5, $6, NULL, NULL)`,
      [tenant.id, new Date(DATA_AT.getTime() + 3600000), new Date(DATA_AT.getTime() + 7200000), admin.id,
        new Date(DATA_AT.getTime() + 9000000), new Date(DATA_AT.getTime() + 9600000)]);
    await db.query(
      `INSERT INTO events (tenant_id, device_id, event_type, payload, time) VALUES ($1, 'REP001', 'compressor_on', '{}', $2), ($1, 'REP001', 'compressor_off', '{}', $3)`,
      [tenant.id, new Date(DATA_AT.getTime() + 600000), new Date(DATA_AT.getTime() + 4200000)]);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  beforeEach(() => { mails = []; });

  it('cuts whole local weeks and months and picks the next 06:00 send', () => {
    const { periodFor, nextRunAfter } = scheduler;
    // Tuesday 8 September 2026, 13:00 Kyiv
    const now = new Date('2026-09-08T10:00:00Z');
    expect(periodFor('weekly', TZ, now)).toEqual({ from: new Date('2026-08-30T21:00:00Z'), to: new Date('2026-09-06T21:00:00Z') });
    expect(periodFor('monthly', TZ, now)).toEqual({ from: new Date('2026-07-31T21:00:00Z'), to: new Date('2026-08-31T21:00:00Z') });
    // Across the March DST change: February is EET (+2), April starts in EEST (+3)
    expect(periodFor('monthly', TZ, new Date('2026-04-05T12:00:00Z'))).toEqual({ from: new Date('2026-02-28T22:00:00Z'), to: new Date('2026-03-31T21:00:00Z') });
    expect(periodFor('monthly', 'UTC', new Date('2026-01-15T00:00:00Z'))).toEqual({ from: new Date('2025-12-01T00:00:00Z'), to: new Date('2026-01-01T00:00:00Z') });
    // Before 06:00 on the 1st the send is still today; after it, next month
    expect(nextRunAfter('monthly', TZ, new Date('2026-09-01T02:00:00Z'))).toEqual(new Date('2026-09-01T03:00:00Z'));
    expect(nextRunAfter('monthly', TZ, new Date('2026-09-01T04:00:00Z'))).toEqual(new Date('2026-10-01T03:00:00Z'));
    expect(nextRunAfter('weekly', TZ, now)).toEqual(new Date('2026-09-14T03:00:00Z'));
    expect(nextRunAfter('weekly', TZ, new Date('2026-09-07T01:00:00Z'))).toEqual(new Date('2026-09-07T03:00:00Z'));
  });

  let schedule;

  it('creating a schedule needs an admin, the reports feature and valid input', async () => {
    expect((await request(app).get('/api/reports/schedules').set(authHeader(viewer, tenant.id))).status).toBe(403);
    const free = await request(app).post('/api/reports/schedules').set(authHeader(freeAdmin, freeTenant.id))
      .send({ site_id: null, type: 'haccp', cadence: 'monthly', recipients: ['a@b.co'] });
    expect(free.status).toBe(402);
    expect(free.body.error).toBe('plan_feature');

    const post = (body) => request(app).post('/api/reports/schedules').set(authHeader(admin, tenant.id)).send(body);
    expect((await post({ type: 'haccp', cadence: 'monthly', recipients: ['not-an-email'] })).status).toBe(400);
    expect((await post({ type: 'weather', cadence: 'monthly', recipients: ['a@b.co'] })).status).toBe(400);
    expect((await post({ type: 'haccp', cadence: 'daily', recipients: ['a@b.co'] })).status).toBe(400);
    expect((await post({ type: 'haccp', cadence: 'monthly', recipients: [] })).status).toBe(400);
    const foreignSite = (await db.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Чужа') RETURNING id`, [other.id])).rows[0];
    expect((await post({ site_id: foreignSite.id, type: 'haccp', cadence: 'monthly', recipients: ['a@b.co'] })).status).toBe(404);

    const res = await post({ site_id: site.id, type: 'haccp', cadence: 'monthly', recipients: ['Owner@Morozko.UA', 'haccp@morozko.ua'], lang: 'uk' });
    expect(res.status).toBe(201);
    schedule = res.body.data;
    expect(schedule).toMatchObject({ site_id: site.id, site_name: site.name, type: 'haccp', cadence: 'monthly', lang: 'uk', bucket: '1h', enabled: true, created_by: admin.email });
    expect(schedule.recipients).toEqual(['owner@morozko.ua', 'haccp@morozko.ua']);
    expect(new Date(schedule.next_run_at) > new Date()).toBe(true);
    expect(schedule.last_run_at).toBeNull();
  });

  it('lists, updates and deletes inside the organisation only', async () => {
    const list = await request(app).get('/api/reports/schedules').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.map(s => s.id)).toEqual([schedule.id]);
    expect((await request(app).get('/api/reports/schedules').set(authHeader(otherAdmin, other.id))).body.data).toEqual([]);
    expect((await request(app).patch(`/api/reports/schedules/${schedule.id}`).set(authHeader(otherAdmin, other.id)).send({ enabled: false })).status).toBe(404);
    expect((await request(app).delete(`/api/reports/schedules/${schedule.id}`).set(authHeader(otherAdmin, other.id))).status).toBe(404);

    const weekly = await request(app).patch(`/api/reports/schedules/${schedule.id}`).set(authHeader(admin, tenant.id)).send({ cadence: 'weekly', recipients: ['haccp@morozko.ua'] });
    expect(weekly.status).toBe(200);
    expect(weekly.body.data.cadence).toBe('weekly');
    expect(weekly.body.data.recipients).toEqual(['haccp@morozko.ua']);
    expect(weekly.body.data.next_run_at).not.toBe(schedule.next_run_at);
    const back = await request(app).patch(`/api/reports/schedules/${schedule.id}`).set(authHeader(admin, tenant.id)).send({ cadence: 'monthly' });
    expect(back.body.data.next_run_at).toBe(schedule.next_run_at);
  });

  let report;

  it('"run now" generates the last month, archives the PDF and e-mails it', async () => {
    const res = await request(app).post(`/api/reports/schedules/${schedule.id}/run`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.emailed).toBe(true);
    expect(res.body.data.reports).toHaveLength(1);
    report = res.body.data.reports[0];
    expect(report).toMatchObject({ site_id: site.id, site: site.name, empty: false, source: 'raw' });
    expect(report.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(report.file_name).toMatch(/^haccp_Магазин_1_\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.pdf$/);

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(['haccp@morozko.ua']);
    expect(mails[0]).toMatchObject({ lang: 'uk', tenantName: tenant.name, type: 'haccp', cadence: 'monthly', tz: TZ, part: 1, parts: 1 });
    expect(mails[0].sites).toEqual([{ name: site.name, code: report.code, empty: false, error: false }]);
    expect(mails[0].attachments).toHaveLength(1);
    expect(mails[0].attachments[0].filename).toBe(report.file_name);
    expect(Buffer.from(mails[0].attachments[0].content, 'base64').slice(0, 4).toString()).toBe('%PDF');
    expect(new Date(mails[0].periodTo) - new Date(mails[0].periodFrom)).toBeGreaterThan(27 * 86400000);

    const { rows } = await db.query('SELECT report_type, schedule_id, kind, site_id, file_name, bytes, pdf IS NOT NULL AS archived, generated_by FROM report_exports WHERE code = $1', [report.code.replace(/-/g, '')]);
    expect(rows[0]).toMatchObject({ report_type: 'haccp', schedule_id: schedule.id, kind: 'site', site_id: site.id, file_name: report.file_name, archived: true, generated_by: 'schedule' });
    expect(rows[0].bytes).toBeGreaterThan(1000);
    const s = (await request(app).get('/api/reports/schedules').set(authHeader(admin, tenant.id))).body.data[0];
    expect(s.last_status).toBe('ok');
    expect(s.last_error).toBeNull();
    expect(new Date(s.last_period_to).getTime()).toBe(new Date(mails[0].periodTo).getTime());
  });

  it('the archive lists the report and hands the PDF out to those who may see the site', async () => {
    const list = await request(app).get('/api/reports').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ code: report.code, report_type: 'haccp', site_id: site.id, site_name: site.name, schedule_id: schedule.id, archived: true, file_name: report.file_name });
    expect((await request(app).get('/api/reports?type=energy').set(authHeader(admin, tenant.id))).body.data).toEqual([]);
    expect((await request(app).get('/api/reports?scheduled=true').set(authHeader(admin, tenant.id))).body.data).toHaveLength(1);

    const dl = await request(app).get(`/api/reports/${report.code}/download`).set(authHeader(admin, tenant.id)).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect(dl.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(report.file_name)}`);
    expect(dl.headers['x-report-code']).toBe(report.code);
    expect(dl.body.slice(0, 4).toString()).toBe('%PDF');

    // A viewer without grants sees nothing; a technician with the site grant sees and downloads
    expect((await request(app).get('/api/reports').set(authHeader(viewer, tenant.id))).body.data).toEqual([]);
    expect((await request(app).get(`/api/reports/${report.code}/download`).set(authHeader(viewer, tenant.id))).status).toBe(404);
    expect((await request(app).get('/api/reports').set(authHeader(tech, tenant.id))).body.data).toHaveLength(1);
    expect((await request(app).get(`/api/reports/${report.code}/download`).set(authHeader(tech, tenant.id))).status).toBe(200);
    // Another organisation never sees it
    expect((await request(app).get('/api/reports').set(authHeader(otherAdmin, other.id))).body.data).toEqual([]);
    expect((await request(app).get(`/api/reports/${report.code}/download`).set(authHeader(otherAdmin, other.id))).status).toBe(404);
    expect((await request(app).get('/api/reports/nope/download').set(authHeader(admin, tenant.id))).status).toBe(404);
  });

  it('the sweep runs what is due, once per period, in open organisations only', async () => {
    const past = new Date(NOW.getTime() - 3600000);
    const ins = (tenantId, cols) => db.query(
      `INSERT INTO report_schedules (tenant_id, site_id, type, cadence, recipients, lang, enabled, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tenantId, cols.site_id || null, cols.type, cols.cadence, cols.recipients || ['ops@morozko.ua'], cols.lang || 'en', cols.enabled !== false, cols.next_run_at || past]);
    const allSites = (await ins(tenant.id, { type: 'alarms', cadence: 'weekly' })).rows[0];
    const disabled = (await ins(tenant.id, { type: 'alarms', cadence: 'weekly', enabled: false })).rows[0];
    const future   = (await ins(tenant.id, { type: 'alarms', cadence: 'weekly', next_run_at: new Date(NOW.getTime() + 3600000) })).rows[0];
    const foreign  = (await ins(other.id, { type: 'alarms', cadence: 'monthly' })).rows[0];
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [other.id]);

    const due = await scheduler.listDue(NOW);
    expect(due.map(s => s.id)).toEqual([allSites.id]);

    const ran = await scheduler.runDue({ now: NOW });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ id: allSites.id, status: 'ok', emailed: true, tz: TZ });
    // Every site of the organisation: the one with equipment gets a document (a week without alarms is still a page), the empty one is listed as such
    const bySite = Object.fromEntries(ran[0].reports.map(r => [r.site, r]));
    expect(bySite[site.name].empty).toBe(false);
    expect(bySite[site.name].file_name).toMatch(/^alarms_/);
    expect(bySite[site2.name].empty).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0].attachments).toHaveLength(1);
    expect(mails[0].sites.find(s => s.name === site2.name)).toEqual({ name: site2.name, code: null, empty: true, error: false });
    expect(mails[0].lang).toBe('en');

    const { rows: [row] } = await db.query('SELECT next_run_at, last_period_to, last_status FROM report_schedules WHERE id = $1', [allSites.id]);
    expect(new Date(row.next_run_at) > NOW).toBe(true);
    expect(row.last_status).toBe('ok');
    expect(new Date(row.last_period_to)).toEqual(scheduler.periodFor('weekly', TZ, NOW).to);

    // Same period again: skipped, nothing sent
    mails = [];
    const again = await scheduler.runSchedule({ ...allSites, tenant_id: tenant.id, site_id: null, type: 'alarms', cadence: 'weekly', recipients: ['ops@morozko.ua'], lang: 'en', last_period_to: row.last_period_to }, { now: NOW });
    expect(again.status).toBe('skipped');
    expect(mails).toHaveLength(0);
    expect(await scheduler.runDue({ now: NOW })).toEqual([]);
    // The next week is due once its Monday 06:00 has passed
    const nextWeek = new Date(scheduler.nextRunAfter('weekly', TZ, NOW).getTime() + 1000);
    expect((await scheduler.listDue(nextWeek)).map(s => s.id)).toContain(allSites.id);

    await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [other.id]);
    await db.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[allSites.id, disabled.id, future.id, foreign.id]]);
  });

  it('an energy report sums the energy channel and compressor run time', async () => {
    const res = await request(app).post('/api/reports/schedules').set(authHeader(admin, tenant.id))
      .send({ site_id: site.id, type: 'energy', cadence: 'monthly', recipients: ['energy@morozko.ua'], lang: 'de' });
    expect(res.status).toBe(201);
    const { rows } = await db.query('SELECT * FROM report_schedules WHERE id = $1', [res.body.data.id]);
    const out = await scheduler.runSchedule(rows[0], { now: NOW, force: true });
    expect(out.status).toBe('ok');
    expect(out.reports[0].file_name).toMatch(/^energy_/);
    const { rows: [exp] } = await db.query('SELECT report_type, lang, pdf IS NOT NULL AS archived FROM report_exports WHERE code = $1', [out.reports[0].code.replace(/-/g, '')]);
    expect(exp).toMatchObject({ report_type: 'energy', lang: 'de', archived: true });
    expect(mails[0].type).toBe('energy');
    // The empty site has no energy at all → no document, said so in the mail
    const none = await scheduler.runSchedule({ ...rows[0], site_id: site2.id }, { now: NOW, force: true });
    expect(none.status).toBe('empty');
    expect(none.reports[0].empty).toBe(true);
    expect(mails[1].attachments).toEqual([]);
  });

  it('a plan without the feature stops the run without sending', async () => {
    await db.query(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
    const { rows } = await db.query('SELECT * FROM report_schedules WHERE id = $1', [schedule.id]);
    const out = await scheduler.runSchedule(rows[0], { now: NOW, force: true });
    expect(out.status).toBe('error');
    expect(mails).toHaveLength(0);
    expect((await db.query('SELECT last_error FROM report_schedules WHERE id = $1', [schedule.id])).rows[0].last_error).toBe('plan_feature');
    await db.query(`UPDATE tenants SET plan = 'pro' WHERE id = $1`, [tenant.id]);
    require('../src/middleware/plan').invalidate(tenant.id);
  });

  it('the purge drops old PDFs but keeps the code and hash for verification', async () => {
    const code = report.code.replace(/-/g, '');
    await db.query(`UPDATE report_exports SET generated_at = now() - interval '4 years' WHERE code = $1`, [code]);
    expect(await scheduler.purgeArchive({ now: NOW })).toBe(1);
    const { rows } = await db.query('SELECT pdf, sha256 FROM report_exports WHERE code = $1', [code]);
    expect(rows[0].pdf).toBeNull();
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(app).get(`/api/reports/${report.code}/download`).set(authHeader(admin, tenant.id))).status).toBe(404);
    expect((await request(app).get('/api/reports').set(authHeader(admin, tenant.id))).body.data.find(r => r.code === report.code).archived).toBe(false);
    expect((await request(app).get(`/api/public/report/${report.code}`)).status).toBe(200);
  });

  it('deleting the schedule keeps the archived reports', async () => {
    expect((await request(app).delete(`/api/reports/schedules/${schedule.id}`).set(authHeader(admin, tenant.id))).status).toBe(200);
    expect((await request(app).delete(`/api/reports/schedules/${schedule.id}`).set(authHeader(admin, tenant.id))).status).toBe(404);
    const { rows } = await db.query('SELECT schedule_id FROM report_exports WHERE code = $1', [report.code.replace(/-/g, '')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule_id).toBeNull();
  });
});
