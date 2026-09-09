'use strict';

/**
 * Bulk HACCP critical limits: the preset list, the bulk PATCH on the
 * dashboard, and the haccp_* columns of the CSV import.
 */

process.env.IMPORT_MAX_ROWS = '6';
process.env.IMPORT_MQTT_PACE_MS = '0';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const presets = require('../src/lib/haccp-presets');
const importSvc = require('../src/services/device-import');
const mqttSvc = require('../src/services/mqtt');

const app = createTestApp();
mqttSvc.sendJsonCommand = async () => {};

const csv = (header, ...rows) => Buffer.from('﻿' + [header, ...rows].map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'), 'utf8');
const post = (user, tenantId, buf) => request(app).post('/api/devices/pending/batch').set(authHeader(user, tenantId)).attach('file', buf, 'devices.csv');
importSvc.__test.setAutoRun(false);   // the test runs the job itself, like imports.test.js

afterAll(async () => { await shutdownDb(); });

describe('HACCP presets and bulk limits', () => {
  let tenant, other, admin, tech, otherAdmin, d1, d2, d3, foreign;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'haccp-bulk' });
    other = await createTenant({ slug: 'haccp-other' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@bulk.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@bulk.test' });
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@other.test' });
    d1 = await createDevice(tenant.id, { mqttId: 'BLK001', name: 'Морозильна 1' });
    d2 = await createDevice(tenant.id, { mqttId: 'BLK002', name: 'Морозильна 2' });
    d3 = await createDevice(tenant.id, { mqttId: 'BLK003', name: 'Вітрина з межами' });
    foreign = await createDevice(other.id, { mqttId: 'BLK009', name: 'Чужий' });
    await db.query('UPDATE devices SET haccp_max = -20, haccp_tolerance = 1, haccp_product = $2 WHERE id = $1', [d3.id, 'ручні межі']);
  });

  afterAll(async () => { await cleanDatabase(); });

  it('lists the presets with labels in every language, in display order', async () => {
    const res = await request(app).get('/api/devices/haccp-presets').set(authHeader(tech, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.key)).toEqual(presets.KEYS);
    for (const p of res.body.data) {
      expect(Object.keys(p.label).sort()).toEqual(['de', 'en', 'pl', 'uk']);
      expect(p.haccp_min === null || p.haccp_min < p.haccp_max).toBe(true);
      expect(p.haccp_tolerance).toBeGreaterThanOrEqual(0);
    }
    expect(res.body.data.find(p => p.key === 'freezer')).toMatchObject({ haccp_min: null, haccp_max: -18, haccp_tolerance: 3 });
    expect(presets.fieldsOf('pharma', 'en')).toEqual({ haccp_min: 2, haccp_max: 8, haccp_tolerance: 0, haccp_product: 'Medicines (2–8 °C)' });
    expect(presets.fieldsOf('nope')).toBeNull();
  });

  it('bulk PATCH applies a preset to empty devices only, by uuid or controller id, within the organisation', async () => {
    const res = await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id))
      .send({ ids: [d1.id, 'blk002', d3.id, foreign.id, '00000000-0000-4000-8000-000000000000'], preset: 'freezer', lang: 'uk' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ updated: 2, skipped: 3, fields: { haccp_min: null, haccp_max: -18, haccp_tolerance: 3, haccp_product: 'Заморожені продукти' } });
    expect(res.body.data.devices.map(d => d.mqtt_device_id).sort()).toEqual(['BLK001', 'BLK002']);

    const { rows } = await db.query('SELECT mqtt_device_id, haccp_min, haccp_max, haccp_tolerance, haccp_product FROM devices WHERE tenant_id = $1 ORDER BY mqtt_device_id', [tenant.id]);
    expect(rows.map(r => [r.mqtt_device_id, Number(r.haccp_max), Number(r.haccp_tolerance), r.haccp_product])).toEqual([
      ['BLK001', -18, 3, 'Заморожені продукти'], ['BLK002', -18, 3, 'Заморожені продукти'], ['BLK003', -20, 1, 'ручні межі'],
    ]);
    const { rows: [f] } = await db.query('SELECT haccp_max FROM devices WHERE id = $1', [foreign.id]);
    expect(f.haccp_max).toBeNull();

    await new Promise(r => setTimeout(r, 200));
    const { rows: audit } = await db.query(`SELECT changes FROM audit_log WHERE action = 'device.haccp_bulk' AND tenant_id = $1`, [tenant.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ preset: 'freezer', requested: 5, updated: 2, only_empty: true });
  });

  it('explicit fields override the preset; only_empty=false overwrites; validation', async () => {
    const res = await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id))
      .send({ ids: ['BLK001', 'BLK003'], preset: 'chilled', haccp_tolerance: 0.5, haccp_product: 'йогурти', only_empty: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ updated: 2, skipped: 0, fields: { haccp_min: 0, haccp_max: 6, haccp_tolerance: 0.5, haccp_product: 'йогурти' } });

    const fieldsOnly = await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id)).send({ ids: ['BLK002'], haccp_max: -15, only_empty: false });
    expect(fieldsOnly.status).toBe(200);
    expect(Number(fieldsOnly.body.data.devices[0].haccp_max)).toBe(-15);
    expect(Number(fieldsOnly.body.data.devices[0].haccp_tolerance)).toBe(3);   // the other columns stay

    expect((await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id)).send({ ids: ['BLK001'], preset: 'unknown' })).status).toBe(400);
    expect((await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id)).send({ ids: ['BLK001'] })).status).toBe(400);
    expect((await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id)).send({ ids: ['BLK001'], haccp_min: 5, haccp_max: 2 })).status).toBe(400);
    expect((await request(app).patch('/api/devices/haccp').set(authHeader(admin, tenant.id)).send({ ids: [], preset: 'freezer' })).status).toBe(400);
    expect((await request(app).patch('/api/devices/haccp').set(authHeader(tech, tenant.id)).send({ ids: ['BLK001'], preset: 'freezer' })).status).toBe(403);
    const cross = await request(app).patch('/api/devices/haccp').set(authHeader(otherAdmin, other.id)).send({ ids: ['BLK001'], preset: 'freezer', only_empty: false });
    expect(cross.status).toBe(200);
    expect(cross.body.data.updated).toBe(0);
  });

  it('CSV import: template has the columns; preset and explicit numbers land on assigned and pre-registered rows', async () => {
    const tpl = await request(app).get('/api/devices/pending/template.csv').set(authHeader(admin, tenant.id));
    const header = tpl.text.split('\n')[0].replace('﻿', '').split(',');
    expect(header.slice(-5)).toEqual(['haccp_preset', 'haccp_min', 'haccp_max', 'haccp_tolerance', 'haccp_product']);

    // Claimed by this organisation: the import takes a pending controller only
    // from its own queue, exactly as POST /devices/pending/:id/assign does.
    await db.query(
      `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code, claimed_by_tenant_id)
       VALUES ($1, 'B1C101', 'pending', false, 'CODEB1C101', $2), ($1, 'B1C102', 'pending', false, 'CODEB1C102', $2)`,
      [db.SYSTEM_TENANT_ID, tenant.id]);
    await db.query(`INSERT INTO tenant_settings (tenant_id, locale) VALUES ($1, 'en') ON CONFLICT (tenant_id) DO UPDATE SET locale = 'en'`, [tenant.id]);
    const H = ['mqtt_device_id', 'name', 'haccp_preset', 'haccp_min', 'haccp_max', 'haccp_tolerance', 'haccp_product'];
    const res = await post(admin, tenant.id, csv(H,
      ['B1C101', 'Ларь 1', 'freezer', '', '', '', ''],                 // preset only → label in the organisation's language
      ['B1C102', 'Вітрина м’ясо', 'meat', '', '3', '', 'свинина'],     // preset with an override and own product
      ['B1C103', 'Нова аптечна', '', '2', '8', '0', ''],               // explicit numbers, pre-registered
      ['B1C104', 'Без меж', '', '', '', '', '']));
    expect(res.status).toBe(202);
    const job = await importSvc.run(res.body.data.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job).toMatchObject({ assigned: 2, pre_registered: 2, failed_rows: 0 });

    const { rows } = await db.query(`SELECT mqtt_device_id, status, haccp_min, haccp_max, haccp_tolerance, haccp_product FROM devices WHERE mqtt_device_id LIKE 'B1C1%' ORDER BY mqtt_device_id`);
    const n = (v) => (v === null ? null : Number(v));
    expect(rows.map(r => [r.mqtt_device_id, r.status, n(r.haccp_min), n(r.haccp_max), n(r.haccp_tolerance), r.haccp_product])).toEqual([
      ['B1C101', 'active', null, -18, 3, 'Frozen food'],
      ['B1C102', 'active', 0, 3, 1, 'свинина'],
      ['B1C103', 'pending', 2, 8, 0, null],
      ['B1C104', 'pending', null, null, null, null],
    ]);
  });

  it('CSV import: bad HACCP values are refused up front with the row and field', async () => {
    const H = ['mqtt_device_id', 'name', 'haccp_preset', 'haccp_min', 'haccp_max', 'haccp_tolerance'];
    const res = await post(admin, tenant.id, csv(H,
      ['B1C201', 'a', 'sauna', '', '', ''],
      ['B1C202', 'b', '', '5', '2', ''],
      ['B1C203', 'c', '', '', 'cold', '40'],
      ['B1C204', 'd', 'Dairy', '−2,5', '', '1,5']));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.errors.map(e => [e.row, e.field])).toEqual([[2, 'haccp_preset'], [3, 'haccp_min'], [4, 'haccp_max'], [4, 'haccp_tolerance']]);
    expect(importSvc.haccpOf({ haccp_preset: 'Dairy', haccp_min: '−2,5', haccp_tolerance: '1,5' }, 'de')).toEqual({ haccp_min: -2.5, haccp_max: 6, haccp_tolerance: 1.5, haccp_product: 'Milchprodukte' });
  });
});
