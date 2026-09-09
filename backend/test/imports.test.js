'use strict';

/**
 * CSV import jobs (plan epic 2.12): validation and plan checks in the
 * request, the work in a job with progress, results without secrets,
 * credentials handed out once, cancellation, the template, geocoding.
 */

process.env.IMPORT_MAX_ROWS = '6';
process.env.IMPORT_MQTT_PACE_MS = '0';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const importSvc = require('../src/services/device-import');
const geocodeSvc = require('../src/services/geocode');
const mqttSvc = require('../src/services/mqtt');

const app = createTestApp();
const sent = [];
mqttSvc.sendJsonCommand = async (slug, id, key, payload) => { sent.push({ slug, id, key, payload }); };

let seq = 0x100;
const nextId = () => (seq++).toString(16).toUpperCase().padStart(6, '0');
// A pending controller as the platform holds it: in the system tenant, carrying
// the code printed on its label. claimedBy = the organisation that has already
// typed that code (POST /devices/claim) — the import may only take a controller
// its own organisation has claimed, or one whose code the CSV row carries.
const pending = async (id, claimedBy = null, claimCode = `CODE${id}`) => (await db.query(
  `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code, claimed_by_tenant_id)
   VALUES ($1, $2, 'pending', false, $3, $4) RETURNING id, claim_code`,
  [db.SYSTEM_TENANT_ID, id, claimCode, claimedBy])).rows[0];
const csv = (header, ...rows) => Buffer.from('﻿' + [header, ...rows].map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'), 'utf8');
const post = (user, tenantId, buf, name = 'devices.csv') => request(app).post('/api/devices/pending/batch').set(authHeader(user, tenantId)).attach('file', buf, name);
const HEADER = ['mqtt_device_id', 'name', 'serial_number', 'site_name', 'country', 'city', 'address_line', 'postal_code'];

describe('CSV import jobs (plan epic 2.12)', () => {
  let tenant, admin, tech, small, smallAdmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'imp-a' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@imp.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@imp.test' });
    small = await createTenant({ slug: 'imp-free', plan: 'free' });
    smallAdmin = await createUser(small.id, { role: 'admin', email: 'admin@imp-free.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('serves the template with every column and refuses bad files up front', async () => {
    const tpl = await request(app).get('/api/devices/pending/template.csv').set(authHeader(admin, tenant.id));
    expect(tpl.status).toBe(200);
    expect(tpl.headers['content-type']).toMatch(/text\/csv/);
    expect(tpl.text.charCodeAt(0)).toBe(0xFEFF);
    expect(tpl.text.split('\n')[0].replace('﻿', '').split(',')).toEqual(importSvc.COLUMNS);
    expect((await request(app).get('/api/devices/pending/template.csv').set(authHeader(tech, tenant.id))).status).toBe(403);

    expect((await post(admin, tenant.id, csv(HEADER))).body.error).toBe('empty_file');
    const bad = await post(admin, tenant.id, csv(HEADER, ['ZZZ', 'x', '', '', '', '', '', ''], ['A1B2C3', '', '', '', '', '', '', '']));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_failed');
    expect(bad.body.errors.map(e => e.field)).toEqual(expect.arrayContaining(['mqtt_device_id', 'name']));
    const many = await post(admin, tenant.id, csv(HEADER, ...Array.from({ length: 7 }, () => [nextId(), 'n', '', '', '', '', '', ''])));
    expect(many.status).toBe(400);
    expect(many.body).toMatchObject({ error: 'too_many_rows', limit: 6 });
    expect((await post(admin, tenant.id, Buffer.from('x'), 'devices.txt')).body.error).toBe('invalid_file_type');
    expect((await post(tech, tenant.id, csv(HEADER, [nextId(), 'n', '', '', '', '', '', '']))).status).toBe(403);
  });

  it('checks the plan before creating the job', async () => {
    const ids = [nextId(), nextId(), nextId(), nextId()];
    for (const id of ids) await pending(id, small.id);
    const res = await post(smallAdmin, small.id, csv(HEADER, ...ids.map(id => [id, 'n', '', '', '', '', '', ''])));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'plan_limit', resource: 'devices', limit: 3 });
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM imports WHERE tenant_id = $1`, [small.id])).rows[0].n).toBe(0);
  });

  it('runs as a job: progress, results without secrets, credentials once, sites created', async () => {
    const a = nextId(), b = nextId(), active = nextId(), fresh = nextId();
    await pending(a, tenant.id); await pending(b, tenant.id);
    await db.query(`INSERT INTO devices (tenant_id, mqtt_device_id, status, online, name) VALUES ($1, $2, 'active', false, 'Already')`, [tenant.id, active]);
    sent.length = 0;

    const res = await post(admin, tenant.id, csv(HEADER,
      [a, 'Вітрина 1', 'SN-1', 'Магазин №12', 'UA', 'Львів', 'вул. Городоцька 15', '79000'],
      [b, 'Вітрина 2', 'SN-2', 'магазин №12 ', 'UA', 'Львів', 'вул. Городоцька 15', '79000'],
      [active, 'x', '', '', '', '', '', ''],
      [fresh, 'New one', '', 'Ignored site', 'UA', 'Київ', '', '']), 'network.csv');
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'pending', total_rows: 4, file_name: 'network.csv', forecast: { assign: 2, pre_register: 1, skip: 1, new_sites: 1 } });
    const id = res.body.data.id;
    // a second upload while one is pending is refused
    expect((await post(admin, tenant.id, csv(HEADER, [nextId(), 'n', '', '', '', '', '', '']))).body).toMatchObject({ error: 'import_in_progress', import_id: id });

    const listBefore = await request(app).get('/api/imports').set(authHeader(admin, tenant.id));
    expect(listBefore.body.data[0]).toMatchObject({ id, status: 'pending', processed_rows: 0, requested_by_email: 'admin@imp.test' });
    expect(listBefore.body.meta.max_rows).toBe(6);

    const final = await importSvc.run(id);
    expect(final.status).toBe('done');
    const job = (await request(app).get(`/api/imports/${id}`).set(authHeader(admin, tenant.id))).body.data;
    expect(job.summary).toMatchObject({ total: 4, processed: 4, assigned: 2, pre_registered: 1, skipped: 1, failed: 0, sites_created: 1, devices_with_site: 2, geocode_queued: 0 });
    expect(job.credentials_available).toBe(true);
    expect(job.rows).toBeUndefined();
    expect(JSON.stringify(job.results)).not.toMatch(/password/);
    expect(job.results.map(r => r.status)).toEqual(['assigned', 'assigned', 'skipped', 'pre_registered']);
    expect(job.results[1].site_name).toBe('Магазин №12');
    expect(job.results[1].site_id).toBe(job.results[0].site_id);
    expect(sent.filter(s => s.key === '_set_mqtt_creds').map(s => s.id)).toEqual([a, b]);

    const { rows: [site] } = await db.query(`SELECT postal_code, city, geo_source FROM sites WHERE tenant_id = $1 AND name = 'Магазин №12'`, [tenant.id]);
    expect(site).toEqual({ postal_code: '79000', city: 'Львів', geo_source: 'none' });
    const { rows: devs } = await db.query(`SELECT mqtt_device_id, tenant_id, status, site_id FROM devices WHERE mqtt_device_id = ANY($1) ORDER BY mqtt_device_id`, [[a, b, fresh]]);
    expect(devs.find(d => d.mqtt_device_id === fresh)).toMatchObject({ tenant_id: db.SYSTEM_TENANT_ID, status: 'pending', site_id: null });
    expect(devs.filter(d => d.tenant_id === tenant.id && d.status === 'active')).toHaveLength(2);

    // credentials: once, as CSV, then gone
    const creds = await request(app).get(`/api/imports/${id}/credentials.csv`).set(authHeader(admin, tenant.id));
    expect(creds.status).toBe(200);
    expect(creds.headers['content-type']).toMatch(/text\/csv/);
    const lines = creds.text.replace('﻿', '').trim().split('\n');
    expect(lines[0]).toBe('mqtt_device_id,name,username,password,mqtt_host,mqtt_port,sent_via_mqtt');
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith(`${a},Вітрина 1,device_${a},`)).toBe(true);
    expect((await request(app).get(`/api/imports/${id}/credentials.csv`).set(authHeader(admin, tenant.id))).status).toBe(410);
    const after = (await request(app).get(`/api/imports/${id}`).set(authHeader(admin, tenant.id))).body.data;
    expect(after.credentials_available).toBe(false);
    expect(after.credentials_downloaded_at).toBeTruthy();
    // another organisation never sees it
    expect((await request(app).get(`/api/imports/${id}`).set(authHeader(smallAdmin, small.id))).status).toBe(404);
  });

  it('cancels: a pending job ends at once, a running one after the current row', async () => {
    const ids = [nextId(), nextId(), nextId()];
    for (const id of ids) await pending(id, tenant.id);
    const res = await post(admin, tenant.id, csv(HEADER, ...ids.map(id => [id, 'n', '', '', '', '', '', ''])));
    expect(res.status).toBe(202);
    const cancel = await request(app).post(`/api/imports/${res.body.data.id}/cancel`).set(authHeader(admin, tenant.id));
    expect(cancel.body.data.status).toBe('cancelled');
    expect(await importSvc.run(res.body.data.id)).toBeNull();
    const job = (await request(app).get(`/api/imports/${res.body.data.id}`).set(authHeader(admin, tenant.id))).body.data;
    expect(job).toMatchObject({ status: 'cancelled', processed_rows: 0 });
    expect((await request(app).post(`/api/imports/${res.body.data.id}/cancel`).set(authHeader(admin, tenant.id))).status).toBe(409);
    // the devices stayed pending, so they can be imported again
    const again = await post(admin, tenant.id, csv(HEADER, ...ids.map(id => [id, 'n', '', '', '', '', '', ''])));
    expect(again.status).toBe(202);
    await db.query(`UPDATE imports SET cancel_requested = true WHERE id = $1`, [again.body.data.id]);
    const final = await importSvc.run(again.body.data.id);
    expect(final.status).toBe('cancelled');
    expect(final.processed_rows).toBe(0);
  });

  it('geocodes the sites it creates through the bulk lane and counts the outcome', async () => {
    const wasBulk = geocodeSvc.isBulkEnabled, wasResolve = geocodeSvc.resolveAddress;
    geocodeSvc.isBulkEnabled = () => true;
    let calls = 0;
    geocodeSvc.resolveAddress = async (address, opts) => {
      calls++;
      expect(opts.lane).toBe('bulk');
      if (address.city === 'Nowhere') return { status: geocodeSvc.OUTCOME.NO_MATCH, result: null };
      return { status: geocodeSvc.OUTCOME.OK, result: { latitude: 49.84, longitude: 24.03, precision: 'house', osm_type: 'way', osm_id: 1, address: { country_code: 'ua', city: 'Львів', region: 'Львівська область' } } };
    };
    try {
      const a = nextId(), b = nextId();
      await pending(a, tenant.id); await pending(b, tenant.id);
      const res = await post(admin, tenant.id, csv(HEADER,
        [a, 'A', '', 'Geo shop', 'UA', 'Львів', 'вул. Зелена 1', ''],
        [b, 'B', '', 'Lost shop', 'UA', 'Nowhere', 'nowhere 1', '']));
      expect(res.status).toBe(202);
      const final = await importSvc.run(res.body.data.id);
      expect(calls).toBe(2);
      expect(final).toMatchObject({ status: 'done', sites_created: 2, geocode_queued: 2, geocoded: 1, geocode_failed: 1 });
      const { rows } = await db.query(`SELECT name, geo_source, latitude, geo_attempts FROM sites WHERE tenant_id = $1 AND name IN ('Geo shop', 'Lost shop') ORDER BY name`, [tenant.id]);
      expect(rows[0]).toMatchObject({ name: 'Geo shop', geo_source: 'geocoded', latitude: 49.84 });
      expect(rows[1]).toMatchObject({ name: 'Lost shop', geo_source: 'none', latitude: null, geo_attempts: 1 });
    } finally {
      geocodeSvc.isBulkEnabled = wasBulk;
      geocodeSvc.resolveAddress = wasResolve;
    }
  });
});
