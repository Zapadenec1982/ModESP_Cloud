'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Devices CRUD', () => {
  let tenant, admin, tech;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'devices-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@devices.test' });
    tech = await createUser(tenant.id, { role: 'technician', email: 'tech@devices.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin can list devices', async () => {
    await createDevice(tenant.id, { name: 'Dev1' });
    const res = await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('admin can get single device', async () => {
    const device = await createDevice(tenant.id, { name: 'Single' });
    const res = await request(app)
      .get(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(device.id);
  });

  // Regression: 9-16 char mqtt ids used to be misdetected as UUIDs and 500
  it('admin can get single device by 12-char mqtt_device_id', async () => {
    const device = await createDevice(tenant.id, { mqttId: 'EE0000000002' });
    const res = await request(app)
      .get('/api/devices/EE0000000002')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(device.id);
  });

  it('admin can update device metadata', async () => {
    const device = await createDevice(tenant.id, { name: 'Old Name' });
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id))
      .send({ name: 'New Name', location: 'Room 101' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
    expect(res.body.data.location).toBe('Room 101');
  });

  it('viewer cannot update device', async () => {
    const viewer = await createUser(tenant.id, { role: 'viewer', email: 'v@devices.test' });
    const device = await createDevice(tenant.id, { name: 'Protected' });
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set(authHeader(viewer, tenant.id))
      .send({ name: 'Hacked' });

    expect([403, 404]).toContain(res.status);
  });

  it('get nonexistent device returns 404', async () => {
    const res = await request(app)
      .get('/api/devices/00000000-0000-0000-0000-000000000001')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });

  it('admin can delete device', async () => {
    const device = await createDevice(tenant.id, { name: 'To Delete' });
    const res = await request(app)
      .delete(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
  });

  // ── devices.assigned_at ─────────────────────────────────
  // The column is only ever read by the mosquitto ACL query, where it decides how long
  // an active device keeps modesp/v1/pending/<id> (migration 022). The ACL SQL itself is
  // covered in device-acl-grace.test.js; these tests pin the write side — that the HTTP
  // flows keep the column truthful. A missed stamp silently re-creates the deadlock.

  async function readDeviceRow(id) {
    const { rows } = await db.query('SELECT * FROM devices WHERE id = $1', [id]);
    return rows[0];
  }

  it('assigning a pending device stamps assigned_at', async () => {
    const mqttId = 'AS0001';
    await db.query(
      `INSERT INTO devices (tenant_id, mqtt_device_id, mqtt_username, status, online)
       VALUES ($1, $2, $3, 'pending', false)`,
      [db.SYSTEM_TENANT_ID, mqttId, `device_${mqttId}`]
    );

    // Since plan epic 1.7 an organisation assigns only what it has claimed with
    // the controller's code (pending-claim.test.js covers the claim itself).
    await db.query('UPDATE devices SET claimed_by_tenant_id = $1 WHERE mqtt_device_id = $2', [tenant.id, mqttId]);

    const res = await request(app)
      .post(`/api/devices/pending/${mqttId}/assign`)
      .set(authHeader(admin, tenant.id))
      .send({ name: 'Freshly assigned' });

    expect(res.status).toBe(200);

    const row = await readDeviceRow(res.body.data.device_id);
    expect(row.status).toBe('active');
    expect(row.assigned_at).not.toBeNull();
    // The grant must be OPEN right after an assign: the device has not checked in yet.
    expect(row.last_seen === null || new Date(row.last_seen) <= new Date(row.assigned_at)).toBe(true);
  });

  it('reset-pending clears assigned_at', async () => {
    const device = await createDevice(tenant.id, { name: 'Back to pending' });
    await db.query('UPDATE devices SET assigned_at = NOW() WHERE id = $1', [device.id]);

    const res = await request(app)
      .post(`/api/devices/${device.id}/reset-pending`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);

    const row = await readDeviceRow(device.id);
    expect(row.status).toBe('pending');
    expect(row.assigned_at).toBeNull();
  });

  it('reassign stamps assigned_at and leaves last_seen alone', async () => {
    // The grant must be OPEN again after a reassign — the device has not checked in
    // under the NEW tenant, whatever it did under the old one. An admin action must
    // never advance last_seen; that is what closes the grant, and doing it here left a
    // device that was quiet at reassign time denied on both prefixes with no way back.
    const otherTenant = await createTenant({ slug: 'devices-reassign-target' });
    const superadmin = await createUser(tenant.id, {
      role: 'superadmin', email: 'super@devices.test',
    });
    const device = await createDevice(tenant.id, { name: 'Moving house' });
    const seenAt = new Date(Date.now() - 60_000);
    await db.query(
      'UPDATE devices SET assigned_at = $1, last_seen = $2 WHERE id = $3',
      [new Date(Date.now() - 120_000), seenAt, device.id]
    );

    const res = await request(app)
      .post(`/api/devices/${device.id}/reassign`)
      .set(authHeader(superadmin, tenant.id))
      .send({ tenant_id: otherTenant.id });

    expect(res.status).toBe(200);

    const row = await readDeviceRow(device.id);
    expect(row.tenant_id).toBe(otherTenant.id);
    expect(new Date(row.last_seen).getTime()).toBe(seenAt.getTime());
    expect(new Date(row.last_seen) <= new Date(row.assigned_at)).toBe(true);
  });

  it('soft delete clears assigned_at', async () => {
    const device = await createDevice(tenant.id, { name: 'Delete clears stamp' });
    await db.query('UPDATE devices SET assigned_at = NOW() WHERE id = $1', [device.id]);

    const res = await request(app)
      .delete(`/api/devices/${device.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);

    const row = await readDeviceRow(device.id);
    expect(row.status).toBe('deleted');
    expect(row.assigned_at).toBeNull();
  });
});
