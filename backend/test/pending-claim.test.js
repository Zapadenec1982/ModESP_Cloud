'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const { generateClaimCode, normalizeClaimCode } = require('../src/lib/claim-code');

const app = createTestApp();

async function createPending(mqttId, claimCode) {
  const { rows } = await db.query(
    `INSERT INTO devices (tenant_id, mqtt_device_id, status, online, claim_code)
     VALUES ($1, $2, 'pending', false, $3) RETURNING id, mqtt_device_id, claim_code`,
    [db.SYSTEM_TENANT_ID, mqttId, claimCode]
  );
  return rows[0];
}

describe('Pending devices — claim codes', () => {
  let tenantA, tenantB, adminA, adminB, superadmin, pending;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA    = await createTenant({ slug: 'claim-a' });
    tenantB    = await createTenant({ slug: 'claim-b' });
    adminA     = await createUser(tenantA.id, { role: 'admin', email: 'admin@claim-a.test' });
    adminB     = await createUser(tenantB.id, { role: 'admin', email: 'admin@claim-b.test' });
    superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'super@claim.test' });
    pending    = await createPending('C1A001', 'ABCD2345');
    await createPending('C1A002', 'WXYZ6789');
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('organisation admins see no unclaimed pending devices; the superadmin sees them with codes', async () => {
    const a = await request(app).get('/api/devices/pending').set(authHeader(adminA, tenantA.id));
    expect(a.status).toBe(200);
    expect(a.body.data).toEqual([]);

    const s = await request(app).get('/api/devices/pending').set(authHeader(superadmin, tenantA.id));
    expect(s.body.data.map(d => d.mqtt_device_id).sort()).toEqual(['C1A001', 'C1A002']);
    expect(s.body.data.find(d => d.mqtt_device_id === 'C1A001').claim_code).toBe('ABCD2345');
  });

  it('a wrong or malformed code is refused', async () => {
    expect((await request(app).post('/api/devices/claim').set(authHeader(adminA, tenantA.id)).send({ claim_code: 'NOPE1234' })).status).toBe(404);
    expect((await request(app).post('/api/devices/claim').set(authHeader(adminA, tenantA.id)).send({ claim_code: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/devices/claim').set(authHeader(adminA, tenantA.id)).send({})).status).toBe(400);
  });

  it('the printed code (spaces, dashes, lowercase tolerated) claims the device for the organisation', async () => {
    const res = await request(app).post('/api/devices/claim').set(authHeader(adminA, tenantA.id)).send({ claim_code: 'abcd-2345 ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mqtt_device_id: 'C1A001', claimed: true });

    const list = await request(app).get('/api/devices/pending').set(authHeader(adminA, tenantA.id));
    expect(list.body.data.map(d => d.mqtt_device_id)).toEqual(['C1A001']);
    expect(list.body.data[0].claimed_by_tenant_id).toBe(tenantA.id);

    const other = await request(app).get('/api/devices/pending').set(authHeader(adminB, tenantB.id));
    expect(other.body.data).toEqual([]);
  });

  it('another organisation cannot claim, assign or delete a device claimed elsewhere', async () => {
    const claim = await request(app).post('/api/devices/claim').set(authHeader(adminB, tenantB.id)).send({ claim_code: 'ABCD2345' });
    expect(claim.status).toBe(409);

    const assign = await request(app).post('/api/devices/pending/C1A001/assign').set(authHeader(adminB, tenantB.id))
      .send({ name: 'Stolen cabinet' });
    expect(assign.status).toBe(404);

    const del = await request(app).delete('/api/devices/pending/C1A001').set(authHeader(adminB, tenantB.id));
    expect(del.status).toBe(404);

    const unclaimed = await request(app).post('/api/devices/pending/C1A002/assign').set(authHeader(adminB, tenantB.id))
      .send({ name: 'Unclaimed cabinet' });
    expect(unclaimed.status).toBe(404);
  });

  it('the claiming organisation can assign the device; a re-claim by the same organisation is idempotent', async () => {
    expect((await request(app).post('/api/devices/claim').set(authHeader(adminA, tenantA.id)).send({ claim_code: 'ABCD2345' })).status).toBe(200);
    const assign = await request(app).post('/api/devices/pending/C1A001/assign').set(authHeader(adminA, tenantA.id))
      .send({ name: 'Cabinet A1' });
    expect([200, 201]).toContain(assign.status);
    const { rows } = await db.query('SELECT tenant_id, status FROM devices WHERE mqtt_device_id = $1', ['C1A001']);
    expect(rows[0]).toMatchObject({ tenant_id: tenantA.id, status: 'active' });
  });

  it('recover: an organisation admin cannot reset another organisation\'s device, and keeps its own in its queue', async () => {
    process.env.MQTT_BOOTSTRAP_PASSWORD = process.env.MQTT_BOOTSTRAP_PASSWORD || 'test-bootstrap-secret';

    const foreign = await request(app).post('/api/devices/recover').set(authHeader(adminB, tenantB.id)).send({ mqtt_device_id: 'C1A001' });
    expect(foreign.status).toBe(404);
    const { rows: still } = await db.query('SELECT status FROM devices WHERE mqtt_device_id = $1', ['C1A001']);
    expect(still[0].status).toBe('active');

    const own = await request(app).post('/api/devices/recover').set(authHeader(adminA, tenantA.id)).send({ mqtt_device_id: 'c1a001' });
    expect(own.status).toBe(200);
    const { rows } = await db.query('SELECT status, claimed_by_tenant_id, claim_code FROM devices WHERE mqtt_device_id = $1', ['C1A001']);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].claimed_by_tenant_id).toBe(tenantA.id);
    expect(rows[0].claim_code).toBe('ABCD2345');

    const list = await request(app).get('/api/devices/pending').set(authHeader(adminA, tenantA.id));
    expect(list.body.data.map(d => d.mqtt_device_id)).toEqual(['C1A001']);

    expect((await request(app).post('/api/devices/recover').set(authHeader(adminA, tenantA.id)).send({ mqtt_device_id: 'ZZ' })).status).toBe(400);
    expect((await request(app).post('/api/devices/recover').set(authHeader(adminA, tenantA.id)).send({ mqtt_device_id: 'ABCDEF0123' })).status).toBe(200);
  });
});

describe('claim-code helpers', () => {
  it('generates unambiguous 8-character codes and normalises user input', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateClaimCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
    expect(normalizeClaimCode(' ab-cd 2345 ')).toBe('ABCD2345');
    expect(normalizeClaimCode('abc')).toBeNull();
    expect(normalizeClaimCode(42)).toBeNull();
  });
});
