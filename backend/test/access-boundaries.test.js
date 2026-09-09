'use strict';

// globals: true in vitest.config.js
//
// Three boundaries the integrity audit of 09.09.2026 found open, all of the same
// shape: a rule enforced on one path and not on its twin.
//
//   H4  the impersonation deny-list closed the import credentials CSV, but not the
//       three other routes that hand back a plaintext MQTT password
//   H5  POST /devices/pending/:id/assign requires the controller to be claimed by
//       the caller's organisation; the CSV import took any pending row
//   H12 (device grants over WebSocket) lives in ws-isolation.test.js, which needs
//       no database

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const impersonation = require('../src/services/impersonation');
const { grantedDeviceId, grantedMqttIds } = require('../src/middleware/device-access');
const importSvc = require('../src/services/device-import');
const mqttSvc = require('../src/services/mqtt');

const app = createTestApp();

afterAll(async () => { await shutdownDb(); });

describe('Impersonation never hands over a secret (H4)', () => {
  // isDenied() is the whole gate — middleware/auth.js calls it and answers 403
  // impersonation_scope. Driving it directly covers every route it guards without
  // minting a token per route.
  const denied = (m, u) => impersonation.isDenied(m, u);

  it('closes every route that returns a plaintext MQTT password', () => {
    expect(denied('POST', '/api/imports/11111111-1111-1111-1111-111111111111/credentials.csv')).toBe(true);
    expect(denied('GET',  '/api/imports/11111111-1111-1111-1111-111111111111/credentials.csv')).toBe(true);
    // These three were open. Each answers with the password in the body.
    expect(denied('POST', '/api/devices/22222222-2222-2222-2222-222222222222/mqtt-credentials')).toBe(true);
    expect(denied('POST', '/api/devices/pending/A1B2C3/assign')).toBe(true);
    expect(denied('POST', '/api/devices/33333333-3333-3333-3333-333333333333/reassign')).toBe(true);
  });

  it('closes the public site token and the making of accounts', () => {
    expect(denied('POST',   '/api/sites/44444444-4444-4444-4444-444444444444/public-links')).toBe(true);
    expect(denied('DELETE', '/api/sites/44444444-4444-4444-4444-444444444444/public-links/1')).toBe(true);
    expect(denied('POST',   '/api/users')).toBe(true);
    expect(denied('POST',   '/api/invitations')).toBe(true);
  });

  it('leaves the support engineer everything they came to do', () => {
    // Reading, and the ordinary repairs — a token that could only read would not
    // be worth having.
    expect(denied('GET',   '/api/devices')).toBe(false);
    expect(denied('GET',   '/api/sites/44444444-4444-4444-4444-444444444444/public-links')).toBe(false);
    expect(denied('GET',   '/api/alarms')).toBe(false);
    expect(denied('PATCH', '/api/devices/22222222-2222-2222-2222-222222222222')).toBe(false);
    expect(denied('POST',  '/api/devices/22222222-2222-2222-2222-222222222222/command')).toBe(false);
    expect(denied('PATCH', '/api/users/55555555-5555-5555-5555-555555555555')).toBe(false);
  });
});

describe('The CSV import obeys the claim, like the single assign does (H5)', () => {
  let mine, theirs, admin;
  let seq = 0xC00;
  const nextId = () => (seq++).toString(16).toUpperCase().padStart(6, '0');

  const HEADER = ['mqtt_device_id', 'name', 'claim_code'];
  const csv = (...rows) => Buffer.from('﻿' + [HEADER, ...rows].map(r => r.join(',')).join('\n'), 'utf8');
  const upload = (buf) => request(app).post('/api/devices/pending/batch')
    .set(authHeader(admin, mine.id)).attach('file', buf, 'devices.csv');

  const pending = async (id, claimedBy, code) => db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code, claimed_by_tenant_id)
     VALUES ($1, $2, 'pending', false, $3, $4)`, [db.SYSTEM_TENANT_ID, id, code, claimedBy || null]);

  const deviceRow = async (id) => (await db.query(
    'SELECT tenant_id, status, claim_code, claimed_by_tenant_id FROM devices WHERE mqtt_device_id = $1', [id])).rows[0];

  beforeAll(async () => {
    await cleanDatabase();
    mine   = await createTenant({ slug: 'claim-mine' });
    theirs = await createTenant({ slug: 'claim-theirs' });
    admin  = await createUser(mine.id, { role: 'admin', email: 'admin@claim.test' });
    mqttSvc.sendJsonCommand = async () => {};
  });

  afterAll(async () => { await cleanDatabase(); });

  it('will not take a controller another organisation has claimed', async () => {
    const id = nextId();
    await pending(id, theirs.id, 'THEIRCODE');

    const res = await upload(csv([id, 'Крадена вітрина', '']));
    expect(res.status).toBe(202);
    expect(res.body.data.forecast).toMatchObject({ assign: 0, skip: 1 });

    const job = await importSvc.run(res.body.data.id);
    expect(job.assigned).toBe(0);
    expect(job.skipped).toBe(1);
    const dev = await deviceRow(id);
    expect(dev.tenant_id).toBe(db.SYSTEM_TENANT_ID);          // still in the queue
    expect(dev.claimed_by_tenant_id).toBe(theirs.id);         // still theirs
  });

  it('will not take an unclaimed controller listed without its code', async () => {
    const id = nextId();
    await pending(id, null, 'SOMECODE');

    const res = await upload(csv([id, 'Чужа вітрина', '']));
    expect(res.body.data.forecast).toMatchObject({ assign: 0, skip: 1 });
    const job = await importSvc.run(res.body.data.id);
    expect(job.skipped).toBe(1);
    const results = (await db.query('SELECT results FROM imports WHERE id = $1', [res.body.data.id])).rows[0].results;
    expect(results[0].error).toMatch(/claim_code/);
    expect((await deviceRow(id)).tenant_id).toBe(db.SYSTEM_TENANT_ID);
  });

  it('refuses a code that belongs to a different controller', async () => {
    const id = nextId();
    await pending(id, null, 'RIGHTCODE');

    const res = await upload(csv([id, 'Вітрина', 'WRONGCODE']));
    const job = await importSvc.run(res.body.data.id);
    expect(job.skipped).toBe(1);
    expect((await deviceRow(id)).tenant_id).toBe(db.SYSTEM_TENANT_ID);
  });

  it('takes one already claimed, and one whose code the row carries', async () => {
    const claimed = nextId(), byCode = nextId();
    await pending(claimed, mine.id, 'MINECODE1');
    await pending(byCode,  null,    'MINECODE2');

    const res = await upload(csv([claimed, 'Вітрина 1', ''], [byCode, 'Вітрина 2', 'mine-code2']));
    expect(res.body.data.forecast).toMatchObject({ assign: 2, skip: 0 });

    const job = await importSvc.run(res.body.data.id);
    expect(job.assigned).toBe(2);
    for (const id of [claimed, byCode]) {
      const dev = await deviceRow(id);
      expect(dev).toMatchObject({ tenant_id: mine.id, status: 'active', claimed_by_tenant_id: mine.id });
    }
  });

  it('a pre-registered row is claimed for the organisation that listed it', async () => {
    // Otherwise the operator could not assign the very row they had just created:
    // the pending queue shows only what the organisation has claimed.
    const fresh = nextId();
    const res = await upload(csv([fresh, 'Ще не бачений', '']));
    expect(res.body.data.forecast).toMatchObject({ pre_register: 1 });

    await importSvc.run(res.body.data.id);
    const dev = await deviceRow(fresh);
    expect(dev).toMatchObject({ tenant_id: db.SYSTEM_TENANT_ID, status: 'pending', claimed_by_tenant_id: mine.id });
    expect(dev.claim_code).toMatch(/^[A-Z0-9]{6,12}$/);

    // …and the queue really does show it now.
    const queue = await request(app).get('/api/devices/pending').set(authHeader(admin, mine.id));
    expect(queue.body.data.map(d => d.mqtt_device_id)).toContain(fresh);
  });
});

// The other half of H12: the WebSocket used to authorise a subscription against
// user_devices alone, while REST grants access through user_sites as well. A
// technician who reaches a device through a site grant could open its page and was
// refused live data on that very device. Both now call the same two functions.
describe('A site grant reaches a device over REST and over the socket alike (H12)', () => {
  let tenant, site, viaDevice, viaSite, unreachable, tech;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'grant-union' });
    tech   = await createUser(tenant.id, { role: 'technician', email: 'tech@grant.test' });

    site = (await db.query(
      `INSERT INTO sites (tenant_id, name) VALUES ($1, 'Магазин №7') RETURNING id`, [tenant.id])).rows[0];

    viaDevice   = await createDevice(tenant.id, { mqttId: 'GRNT01', name: 'Пряма видача' });
    viaSite     = await createDevice(tenant.id, { mqttId: 'GRNT02', name: 'Через точку' });
    unreachable = await createDevice(tenant.id, { mqttId: 'GRNT03', name: 'Без жодного гранта' });

    await grantDeviceAccess(tech.id, viaDevice.id);
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, viaSite.id]);
    await db.query(
      `INSERT INTO user_sites (user_id, site_id, tenant_id) VALUES ($1, $2, $3)`, [tech.id, site.id, tenant.id]);
  });

  afterAll(async () => { await cleanDatabase(); });

  it('resolves a device held directly and one held through its site, by uuid or mqtt id', async () => {
    expect(await grantedDeviceId(tech.id, tenant.id, 'GRNT01')).toBe(viaDevice.id);
    expect(await grantedDeviceId(tech.id, tenant.id, 'GRNT02')).toBe(viaSite.id);
    expect(await grantedDeviceId(tech.id, tenant.id, viaSite.id)).toBe(viaSite.id);
    expect(await grantedDeviceId(tech.id, tenant.id, 'GRNT03')).toBeNull();
  });

  it('the set the socket filters its feed with holds exactly those devices', async () => {
    const scope = await grantedMqttIds(tech.id, tenant.id);
    expect([...scope].sort()).toEqual(['GRNT01', 'GRNT02']);
  });

  it('and REST agrees — the list shows the same two', async () => {
    const res = await request(app).get('/api/devices').set(authHeader(tech, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.map(d => d.mqtt_device_id).sort()).toEqual(['GRNT01', 'GRNT02']);
    expect((await request(app).get('/api/devices/GRNT02').set(authHeader(tech, tenant.id))).status).toBe(200);
    expect((await request(app).get('/api/devices/GRNT03').set(authHeader(tech, tenant.id))).status).toBe(403);
  });
});
