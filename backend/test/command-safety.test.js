'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');
const { validateCommandValue, DANGEROUS_KEYS } = require('../src/config/command-policy');

const app = createTestApp();

describe('POST /devices/:id/command — role gate, validation, confirmation, audit', () => {
  let tenant, admin, tech, viewer, device;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'cmd-test' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@cmd.test' });
    tech   = await createUser(tenant.id, { role: 'technician', email: 'tech@cmd.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@cmd.test' });
    device = await createDevice(tenant.id, { mqttId: 'CMD001', name: 'Cabinet 1' });
    await grantDeviceAccess(tech.id, device.id, admin.id);
    await grantDeviceAccess(viewer.id, device.id, admin.id);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  const send = (user, body) => request(app).post(`/api/devices/${device.id}/command`).set(authHeader(user, tenant.id)).send(body);

  it('a viewer with device access is still refused (403)', async () => {
    const res = await send(viewer, { key: 'protection.door_delay', value: 10 });
    expect(res.status).toBe(403);
  });

  it('a technician with device access can send a valid, harmless command', async () => {
    const res = await send(tech, { key: 'protection.door_delay', value: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ device_id: 'CMD001', key: 'protection.door_delay', value: 10, sent: true });
  });

  it('a technician without access to the device gets 403 from the per-device check', async () => {
    const other = await createDevice(tenant.id, { mqttId: 'CMD002' });
    const res = await request(app).post(`/api/devices/${other.id}/command`).set(authHeader(tech, tenant.id))
      .send({ key: 'protection.door_delay', value: 10 });
    expect(res.status).toBe(403);
  });

  it('rejects unknown keys, out-of-range values, wrong types and off-step values', async () => {
    expect((await send(admin, { key: 'equipment.air_temp', value: 1 })).status).toBe(400);
    const high = await send(admin, { key: 'protection.door_delay', value: 61 });
    expect(high.status).toBe(400);
    expect(high.body.message).toMatch(/at most 60/);
    expect((await send(admin, { key: 'protection.door_delay', value: -1 })).status).toBe(400);
    expect((await send(admin, { key: 'protection.door_delay', value: 'ten' })).status).toBe(400);
    expect((await send(admin, { key: 'protection.door_delay', value: 2.5 })).status).toBe(400);
    const step = await send(admin, { key: 'thermostat.setpoint', value: 4.3, confirm: true });
    expect(step.status).toBe(400);
    expect(step.body.message).toMatch(/multiple of 0.5/);
  });

  it('coerces booleans and numeric strings', async () => {
    const b = await send(admin, { key: 'thermostat.night_active', value: 'true' });
    expect(b.status).toBe(200);
    expect(b.body.data.value).toBe(true);
    const n = await send(admin, { key: 'protection.door_delay', value: '15' });
    expect(n.status).toBe(200);
    expect(n.body.data.value).toBe(15);
  });

  it('a dangerous key needs confirm: true', async () => {
    const noConfirm = await send(tech, { key: 'thermostat.setpoint', value: -18 });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toBe('confirmation_required');

    const ok = await send(tech, { key: 'thermostat.setpoint', value: -18, confirm: true });
    expect(ok.status).toBe(200);

    const reset = await send(admin, { key: 'protection.reset_alarms', value: true });
    expect(reset.status).toBe(400);
    expect((await send(admin, { key: 'protection.reset_alarms', value: true, confirm: true })).status).toBe(200);
  });

  it('every command lands in the audit log as device.command and is listed for admins', async () => {
    await new Promise(r => setTimeout(r, 200));   // audit rows are written asynchronously
    const { rows } = await db.query(
      `SELECT action, changes FROM audit_log WHERE entity_id = 'CMD001' AND action = 'device.command' ORDER BY created_at DESC`);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0].changes).toMatchObject({ key: 'protection.reset_alarms', value: 'true', confirmed: true, dangerous: true });

    const list = await request(app).get(`/api/devices/${device.id}/commands`).set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(4);
    expect(list.body.data[0]).toMatchObject({ key: 'protection.reset_alarms', value: 'true', user_email: 'admin@cmd.test', dangerous: true });
    expect(list.body.data.some(c => c.user_email === 'tech@cmd.test' && c.key === 'thermostat.setpoint')).toBe(true);

    expect((await request(app).get(`/api/devices/${device.id}/commands`).set(authHeader(tech, tenant.id))).status).toBe(403);
  });
});

describe('validateCommandValue()', () => {
  it('applies type, range and step from the metadata', () => {
    const meta = { key: 'x', type: 'float', min: -50, max: 50, step: 0.5 };
    expect(validateCommandValue(meta, 4)).toEqual({ ok: true, value: 4 });
    expect(validateCommandValue(meta, -49.5).ok).toBe(true);
    expect(validateCommandValue(meta, 50.5).ok).toBe(false);
    expect(validateCommandValue(meta, 0.3).ok).toBe(false);
    expect(validateCommandValue({ key: 'y', type: 'int', min: 30, max: 600, step: 10 }, 125).ok).toBe(false);
    expect(validateCommandValue({ key: 'y', type: 'int', min: 30, max: 600, step: 10 }, 130).ok).toBe(true);
    expect(validateCommandValue({ key: 'b', type: 'bool' }, 0)).toEqual({ ok: true, value: false });
    expect(validateCommandValue({ key: 'b', type: 'bool' }, 'yes').ok).toBe(false);
  });

  it('keeps the dangerous list to equipment-changing keys', () => {
    expect(DANGEROUS_KEYS.has('thermostat.setpoint')).toBe(true);
    expect(DANGEROUS_KEYS.has('protection.reset_alarms')).toBe(true);
    expect(DANGEROUS_KEYS.has('protection.door_delay')).toBe(false);
  });
});
