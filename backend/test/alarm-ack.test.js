'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('POST /alarms/:id/ack', () => {
  let tenant, other, admin, tech, techNoAccess, viewer, adminOther, device, alarmId;

  beforeAll(async () => {
    await cleanDatabase();
    tenant       = await createTenant({ slug: 'ack-a' });
    other        = await createTenant({ slug: 'ack-b' });
    admin        = await createUser(tenant.id, { role: 'admin', email: 'admin@ack.test' });
    tech         = await createUser(tenant.id, { role: 'technician', email: 'tech@ack.test' });
    techNoAccess = await createUser(tenant.id, { role: 'technician', email: 'tech2@ack.test' });
    viewer       = await createUser(tenant.id, { role: 'viewer', email: 'viewer@ack.test' });
    adminOther   = await createUser(other.id, { role: 'admin', email: 'admin@ack-b.test' });
    device       = await createDevice(tenant.id, { mqttId: 'ACK001' });
    await grantDeviceAccess(tech.id, device.id, admin.id);
    await grantDeviceAccess(viewer.id, device.id, admin.id);
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'ACK001', 'high_temp_alarm', 'critical', true) RETURNING id`, [tenant.id]);
    alarmId = rows[0].id;
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  const ack = (user, tid, id, body = {}) => request(app).post(`/api/alarms/${id}/ack`).set(authHeader(user, tid)).send(body);

  it('viewers and technicians without device access cannot acknowledge', async () => {
    expect((await ack(viewer, tenant.id, alarmId)).status).toBe(403);
    expect((await ack(techNoAccess, tenant.id, alarmId)).status).toBe(403);
    expect((await ack(adminOther, other.id, alarmId)).status).toBe(404);
    expect((await ack(admin, tenant.id, 'abc')).status).toBe(404);
    expect((await ack(admin, tenant.id, 999999999)).status).toBe(404);
  });

  it('a technician with device access acknowledges with a note; a second ack is a conflict', async () => {
    const res = await ack(tech, tenant.id, alarmId, { note: 'On my way, ETA 30 min' });
    expect(res.status).toBe(200);
    expect(res.body.data.acknowledged_at).toBeTruthy();
    expect(res.body.data.ack_note).toBe('On my way, ETA 30 min');
    expect(res.body.data.acknowledged_by_email).toBe('tech@ack.test');

    const again = await ack(admin, tenant.id, alarmId);
    expect(again.status).toBe(409);

    const list = await request(app).get('/api/alarms?active=true').set(authHeader(admin, tenant.id));
    const row = list.body.data.find(a => a.id === alarmId);
    expect(row.acknowledged_by_email).toBe('tech@ack.test');
    expect(row.ack_note).toBe('On my way, ETA 30 min');

    const dev = await request(app).get(`/api/devices/${device.id}/alarms`).set(authHeader(tech, tenant.id));
    expect(dev.status).toBe(200);
    expect(dev.body.data.find(a => a.id === alarmId).acknowledged_at).toBeTruthy();
  });

  it('rejects an oversized note', async () => {
    const { rows } = await db.query(
      `INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'ACK001', 'door_alarm', 'warning', true) RETURNING id`, [tenant.id]);
    const res = await ack(admin, tenant.id, rows[0].id, { note: 'x'.repeat(600) });
    expect(res.status).toBe(400);
  });

  it('GET /alarms/:id/deliveries lists the notification log of the alarm for admins', async () => {
    await db.query(
      `INSERT INTO notification_log (tenant_id, channel, device_id, alarm_code, status, user_id, alarm_id)
       VALUES ($1, 'telegram', 'ACK001', 'high_temp_alarm', 'sent', $2, $3), ($1, 'email', 'ACK001', 'high_temp_alarm', 'failed', $2, $3)`,
      [tenant.id, tech.id, alarmId]);
    const res = await request(app).get(`/api/alarms/${alarmId}/deliveries`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ channel: 'telegram', status: 'sent', user_email: 'tech@ack.test' });
    expect((await request(app).get(`/api/alarms/${alarmId}/deliveries`).set(authHeader(tech, tenant.id))).status).toBe(403);
    expect((await request(app).get(`/api/alarms/${alarmId}/deliveries`).set(authHeader(adminOther, other.id))).status).toBe(404);
  });
});
