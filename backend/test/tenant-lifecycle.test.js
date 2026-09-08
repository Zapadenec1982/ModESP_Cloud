'use strict';

// globals: true in vitest.config.js
//
// Organisation lifecycle and data export (plan epic 2.10): closed_at follows
// the status, a closed organisation is read-only, the export zip carries every
// table and a HACCP PDF per site, exports expire, the sweep purges after
// CLOSED_RETENTION_DAYS, a deleted user leaves a pseudonymised audit trail,
// and bulk delete goes through the shared procedure.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const zip = require('./helpers/zip');
const exportSvc = require('../src/services/tenant-export');
const lifecycle = require('../src/services/tenant-lifecycle');

const app = createTestApp();
const PW = 'LifecycleTestPassw0rd!';
const DAY = 86_400_000;
const EXPORT_DIR = path.join(__dirname, '../.tmp-exports');

async function insertRaw(tenantId, deviceId, start, hours) {
  const values = [], params = [];
  let i = 1;
  for (let m = 0; m < hours * 60; m += 5) {
    const t = new Date(start.getTime() + m * 60000);
    for (const [ch, base] of [['air', -18], ['evap', -25], ['setpoint', -18]]) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(t, tenantId, deviceId, ch, base + Math.sin(m / 60));
    }
  }
  await db.query(`INSERT INTO telemetry (time, tenant_id, device_id, channel, value) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  return values.length;
}

const download = (req) => req.buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

describe('organisation lifecycle (plan epic 2.10)', () => {
  let tenant, other, site, device, model, admin, viewer, otherAdmin, superadmin, telemetryRows;

  beforeAll(async () => {
    await cleanDatabase();
    process.env.EXPORT_DIR = EXPORT_DIR;
    process.env.CLOSED_RETENTION_DAYS = '30';
    exportSvc.__test.setAutoRun(false);
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true });

    tenant = await createTenant({ slug: 'life-a', plan: 'pro' });
    other  = await createTenant({ slug: 'life-b', plan: 'pro' });
    site = (await db.query(
      `INSERT INTO sites (tenant_id, name, address_line, city, country, timezone) VALUES ($1, 'Магазин №7', 'вул. Лесі Українки 3', 'Луцьк', 'Україна', 'Europe/Kyiv') RETURNING id, name`, [tenant.id])).rows[0];
    model = (await db.query(`INSERT INTO device_models (tenant_id, name, compressor_kw) VALUES ($1, 'Бонета 2.4', 1.2) RETURNING id`, [tenant.id])).rows[0];
    device = await createDevice(tenant.id, { mqttId: 'LIFE01', name: 'Вітрина 1' });
    await createDevice(tenant.id, { mqttId: 'LIFE02', name: 'Вітрина 2' });
    await db.query('UPDATE devices SET site_id = $1, model_id = $2 WHERE tenant_id = $3', [site.id, model.id, tenant.id]);
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@life.test', password: PW });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@life.test', password: PW });
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@life-b.test', password: PW });
    superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@life.test', password: PW });

    telemetryRows = await insertRaw(tenant.id, 'LIFE01', new Date(Date.now() - 2 * DAY), 3);
    await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active, triggered_at, cleared_at)
       VALUES ($1, 'LIFE01', 'high_temp_alarm', 'critical', false, now() - interval '1 day', now() - interval '23 hours')`, [tenant.id]);
    await db.query(`INSERT INTO events (tenant_id, device_id, event_type, payload, time) VALUES ($1, 'LIFE01', 'compressor_on', '{}', now() - interval '1 day')`, [tenant.id]);
  });

  afterAll(async () => {
    exportSvc.__test.setAutoRun(true);
    delete process.env.EXPORT_DIR;
    delete process.env.CLOSED_RETENTION_DAYS;
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
    await cleanDatabase();
    await shutdownDb();
  });

  it('closing stamps closed_at; reopening clears it', async () => {
    const closed = await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'closed' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('closed');
    let { rows } = await db.query('SELECT closed_at, purged_at, active FROM tenants WHERE id = $1', [tenant.id]);
    expect(rows[0].closed_at).toBeTruthy();
    expect(rows[0].purged_at).toBeNull();
    expect(rows[0].active).toBe(false);

    const reopened = await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'active' });
    expect(reopened.status).toBe(200);
    ({ rows } = await db.query('SELECT closed_at FROM tenants WHERE id = $1', [tenant.id]));
    expect(rows[0].closed_at).toBeNull();

    // closed again for the rest of the file
    await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'closed' });
    const list = await request(app).get('/api/tenants').set(authHeader(superadmin, other.id));
    expect(list.body.data.find(t => t.id === tenant.id).closed_at).toBeTruthy();
  });

  it('a closed organisation signs in read-only: reads pass, writes are refused with 423', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: admin.email, password: PW });
    expect(login.status).toBe(200);
    expect(login.body.data.tenant.status).toBe('closed');
    const until = new Date(login.body.data.tenant.read_only_until) - new Date(login.body.data.tenant.closed_at);
    expect(Math.round(until / DAY)).toBe(30);

    const bearer = { Authorization: `Bearer ${login.body.data.access_token}` };
    expect((await request(app).get('/api/devices').set(bearer)).status).toBe(200);
    expect((await request(app).get('/api/sites').set(bearer)).status).toBe(200);

    const patch = await request(app).patch(`/api/devices/${device.id}`).set(bearer).send({ name: 'Нова назва' });
    expect(patch.status).toBe(423);
    expect(patch.body.error).toBe('organisation_closed');
    expect((await request(app).post('/api/sites').set(bearer).send({ name: 'Нова точка' })).status).toBe(423);
    expect((await request(app).post('/api/users').set(bearer).send({ email: 'x@life.test', password: PW, role: 'viewer' })).status).toBe(423);
    expect((await db.query('SELECT name FROM devices WHERE id = $1', [device.id])).rows[0].name).toBe('Вітрина 1');

    // Auth and the own profile keep working; a superadmin is never held back
    expect((await request(app).post('/api/auth/logout').set(bearer).send({ refresh_token: login.body.data.refresh_token })).status).toBe(200);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(superadmin, tenant.id)).send({ timezone: 'Europe/Warsaw' })).status).toBe(200);
  });

  let exportRow;

  it('the export packs every table, a HACCP PDF per site, and nothing secret', async () => {
    expect((await request(app).post(`/api/tenants/${tenant.id}/export`).set(authHeader(viewer, tenant.id))).status).toBe(403);
    expect((await request(app).post(`/api/tenants/${tenant.id}/export`).set(authHeader(otherAdmin, other.id))).status).toBe(403);

    const res = await request(app).post(`/api/tenants/${tenant.id}/export`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ tenant_id: tenant.id, status: 'pending', requested_by: admin.id });
    expect((await request(app).post(`/api/tenants/${tenant.id}/export`).set(authHeader(admin, tenant.id))).status).toBe(409);
    expect((await request(app).get(`/api/tenants/${tenant.id}/exports/${res.body.data.id}/download`).set(authHeader(admin, tenant.id))).status).toBe(409);

    exportRow = await exportSvc.run(res.body.data.id);
    expect(exportRow.status).toBe('ready');
    expect(exportRow.file_name).toMatch(/^modesp_life_a_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}\.zip$/);
    expect(exportRow.bytes).toBeGreaterThan(1000);
    expect(exportRow.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(exportRow.expires_at) - new Date(exportRow.completed_at)).toBe(7 * DAY);
    expect(exportRow.manifest.tables.telemetry).toBe(telemetryRows);
    expect(exportRow.manifest.tables.devices).toBe(2);
    expect(exportRow.manifest.tables.users).toBe(2);
    expect(exportRow.manifest.reports).toHaveLength(1);
    expect(exportRow.manifest.reports[0].site).toBe(site.name);
    expect(await exportSvc.run(res.body.data.id)).toBeNull();      // already claimed

    const list = await request(app).get(`/api/tenants/${tenant.id}/exports`).set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: exportRow.id, status: 'ready', file_name: exportRow.file_name });
    expect(list.body.data[0].file_path).toBeUndefined();
    expect(list.body.meta.ttl_days).toBe(7);

    const dl = await download(request(app).get(`/api/tenants/${tenant.id}/exports/${exportRow.id}/download`).set(authHeader(admin, tenant.id)));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/zip/);
    expect(dl.headers['x-export-sha256']).toBe(exportRow.sha256);
    expect(dl.body.length).toBe(exportRow.bytes);

    const names = zip.entries(dl.body).map(e => e.name);
    for (const n of ['sites.csv', 'devices.csv', 'users.csv', 'alarms.csv', 'events.csv', 'telemetry.csv', 'audit_log.csv', 'invoices.csv', 'README.txt', 'manifest.json']) {
      expect(names).toContain(n);
    }
    expect(names.filter(n => n.startsWith('reports/haccp_'))).toHaveLength(1);
    expect(zip.read(dl.body, names.find(n => n.startsWith('reports/'))).slice(0, 4).toString()).toBe('%PDF');

    const users = zip.read(dl.body, 'users.csv').toString('utf8').replace(/^﻿/, '');
    const header = users.split('\n')[0];
    expect(header).toContain('email');
    expect(header).not.toContain('password_hash');
    expect(header).not.toContain('mfa_secret');
    expect(header).not.toContain('tenant_id');
    expect(users).toContain('admin@life.test');
    const telemetry = zip.read(dl.body, 'telemetry.csv').toString('utf8').trim().split('\n');
    expect(telemetry).toHaveLength(telemetryRows + 1);
    expect(telemetry[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z,LIFE01,/);
    const manifest = JSON.parse(zip.read(dl.body, 'manifest.json').toString('utf8'));
    expect(manifest.organisation.slug).toBe('life-a');

    // The other organisation cannot reach it
    expect((await request(app).get(`/api/tenants/${tenant.id}/exports/${exportRow.id}/download`).set(authHeader(otherAdmin, other.id))).status).toBe(403);
  });

  it('an expired export loses its file but keeps its row', async () => {
    expect(await exportSvc.expire()).toBe(0);
    await db.query(`UPDATE tenant_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exportRow.id]);
    expect(await exportSvc.expire()).toBe(1);
    expect(fs.existsSync(exportRow.file_path)).toBe(false);
    const { rows } = await db.query('SELECT status, file_path, sha256 FROM tenant_exports WHERE id = $1', [exportRow.id]);
    expect(rows[0]).toMatchObject({ status: 'expired', file_path: null, sha256: exportRow.sha256 });
    expect((await request(app).get(`/api/tenants/${tenant.id}/exports/${exportRow.id}/download`).set(authHeader(admin, tenant.id))).status).toBe(410);
  });

  it('the sweep purges an organisation CLOSED_RETENTION_DAYS after it closed', async () => {
    const recent = await createTenant({ slug: 'life-recent' });
    await db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [recent.id]);
    await db.query(`UPDATE tenants SET closed_at = now() - interval '5 days' WHERE id = $1`, [recent.id]);
    // Not due yet: nothing happens
    expect(await lifecycle.purgeClosed()).toEqual([]);

    await db.query(`UPDATE tenants SET closed_at = now() - interval '31 days' WHERE id = $1`, [tenant.id]);
    process.env.CLOSED_RETENTION_DAYS = '-1';
    expect(await lifecycle.purgeClosed()).toEqual([]);           // purge switched off
    process.env.CLOSED_RETENTION_DAYS = '30';

    const purged = await lifecycle.purgeClosed();
    expect(purged.map(p => p.id)).toEqual([tenant.id]);
    expect(purged[0].devices.sort()).toEqual(['LIFE01', 'LIFE02']);
    expect(purged[0].counts.alarms).toBe(1);

    const count = async (sql) => Number((await db.query(sql, [tenant.id])).rows[0].n);
    expect(await count('SELECT COUNT(*) AS n FROM telemetry WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM alarms WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM sites WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM device_models WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM tenant_exports WHERE tenant_id = $1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM devices WHERE tenant_id = $1')).toBe(0);
    // Controllers wait in the pending queue with their credentials; the organisation and its people stay
    const { rows: devs } = await db.query(`SELECT tenant_id, status, site_id, model_id, mqtt_password_hash FROM devices WHERE mqtt_device_id IN ('LIFE01', 'LIFE02')`);
    expect(devs).toHaveLength(2);
    for (const d of devs) expect(d).toMatchObject({ tenant_id: db.SYSTEM_TENANT_ID, status: 'pending', site_id: null, model_id: null });
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE tenant_id = $1')).toBe(2);
    const { rows: t } = await db.query('SELECT status, purged_at, closed_at FROM tenants WHERE id = $1', [tenant.id]);
    expect(t[0].status).toBe('closed');
    expect(t[0].purged_at).toBeTruthy();
    // Never twice
    expect(await lifecycle.purgeClosed()).toEqual([]);
  });

  it('deleting a user leaves a pseudonymised audit trail; the trail stays immutable otherwise', async () => {
    const victim = await createUser(other.id, { role: 'technician', email: 'gone@life-b.test' });
    await db.query(
      `INSERT INTO audit_log (tenant_id, user_id, user_email, user_role, action, method, endpoint, status_code, ip, user_agent)
       VALUES ($1, $2, $3, 'technician', 'device.update', 'PATCH', '/api/devices/life-x', 200, '203.0.113.9', 'Mozilla/5.0'),
              ($1, $2, $3, 'technician', 'auth.login', 'POST', '/api/auth/life-x', 200, '203.0.113.9', 'Mozilla/5.0')`,
      [other.id, victim.id, victim.email]);
    const res = await request(app).delete(`/api/users/${victim.id}`).set(authHeader(otherAdmin, other.id));
    expect(res.status).toBe(200);
    const { rows } = await db.query(`SELECT user_id, user_email, ip, user_agent, action, tenant_id FROM audit_log WHERE endpoint IN ('/api/devices/life-x', '/api/auth/life-x') ORDER BY action`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.user_id).toBeNull();
      expect(r.user_email).toMatch(/^deleted-[0-9a-f]{12}@removed$/);
      expect(r.ip).toBeNull();
      expect(r.user_agent).toBeNull();
      expect(r.tenant_id).toBe(other.id);
    }
    expect(rows[0].user_email).toBe(rows[1].user_email);           // one stable pseudonym per person
    await expect(db.query(`UPDATE audit_log SET action = 'tampered' WHERE endpoint = '/api/devices/life-x'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE audit_log SET user_email = 'x@y' WHERE endpoint = '/api/devices/life-x'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM audit_log WHERE endpoint = '/api/devices/life-x'`)).rejects.toThrow(/immutable/);
    // A caller who sets the flag by hand still cannot change a non-person column
    await expect(db.transaction(async (c) => {
      await c.query(`SELECT set_config('modesp.audit_pii_scrub', 'on', true)`);
      await c.query(`UPDATE audit_log SET status_code = 500 WHERE endpoint = '/api/devices/life-x'`);
    })).rejects.toThrow(/immutable/);
  });

  it('bulk delete runs the shared procedure: device models and the audit trail no longer block it', async () => {
    const gone = await createTenant({ slug: 'life-gone' });
    const goneAdmin = await createUser(gone.id, { role: 'admin', email: 'admin@life-gone.test' });
    const m = (await db.query(`INSERT INTO device_models (tenant_id, name) VALUES ($1, 'Модель') RETURNING id`, [gone.id])).rows[0];
    const d = await createDevice(gone.id, { mqttId: 'GONE01' });
    await db.query('UPDATE devices SET model_id = $1 WHERE id = $2', [m.id, d.id]);
    await insertRaw(gone.id, 'GONE01', new Date(Date.now() - DAY), 1);
    await db.query(
      `INSERT INTO audit_log (tenant_id, user_id, user_email, user_role, action, method, endpoint, status_code)
       VALUES ($1, $2, $3, 'admin', 'site.create', 'POST', '/api/sites/life-gone', 201)`, [gone.id, goneAdmin.id, goneAdmin.email]);

    const res = await request(app).delete('/api/tenants/bulk').set(authHeader(superadmin, other.id)).send({ ids: [gone.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1);
    expect(res.body.data.movedDevices).toBe(1);
    expect((await db.query('SELECT 1 FROM tenants WHERE id = $1', [gone.id])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM device_models WHERE tenant_id = $1', [gone.id])).rows).toHaveLength(0);
    expect((await db.query(`SELECT tenant_id, status FROM devices WHERE mqtt_device_id = 'GONE01'`)).rows[0]).toMatchObject({ tenant_id: db.SYSTEM_TENANT_ID, status: 'pending' });
    const { rows: trail } = await db.query(`SELECT tenant_id, user_id, user_email FROM audit_log WHERE endpoint = '/api/sites/life-gone'`);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ tenant_id: null, user_id: null });
    expect(trail[0].user_email).toMatch(/^deleted-/);
  });
});
