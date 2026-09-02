'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const pino = require('pino');
const mqttSvc = require('../src/services/mqtt');
mqttSvc.__test.setLogger(pino({ level: 'silent' }));

const app = createTestApp();

describe('organisation settings', () => {
  let tenant, other, admin, tech, adminOther, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant     = await createTenant({ slug: 'settings-a' });
    other      = await createTenant({ slug: 'settings-b' });
    admin      = await createUser(tenant.id, { role: 'admin', email: 'admin@settings.test' });
    tech       = await createUser(tenant.id, { role: 'technician', email: 'tech@settings.test' });
    adminOther = await createUser(other.id, { role: 'admin', email: 'admin@settings-b.test' });
    superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@settings.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('returns platform defaults until something is set', async () => {
    const res = await request(app).get(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tenant_id: tenant.id, timezone: 'Europe/Kyiv', locale: 'uk', door_alarm_delay_ms: null });
    expect(res.body.data.defaults.door_alarm_delay_ms).toBe(600000);
    expect(res.body.data.defaults.ack_escalation_min).toBe(15);
  });

  it('only admins of the organisation (or a superadmin) may read or change them', async () => {
    expect((await request(app).get(`/api/tenants/${tenant.id}/settings`).set(authHeader(tech, tenant.id))).status).toBe(403);
    expect((await request(app).get(`/api/tenants/${tenant.id}/settings`).set(authHeader(adminOther, other.id))).status).toBe(403);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(adminOther, other.id)).send({ locale: 'en' })).status).toBe(403);
    expect((await request(app).get(`/api/tenants/${tenant.id}/settings`).set(authHeader(superadmin, other.id))).status).toBe(200);
  });

  it('an organisation admin sets delays, escalation and the electricity rate from the API', async () => {
    const res = await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id))
      .send({ timezone: 'Europe/Warsaw', locale: 'en', door_alarm_delay_ms: 300000, ack_escalation_min: 30, electricity_rate: 7.5, electricity_currency: 'uah' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      timezone: 'Europe/Warsaw', locale: 'en', door_alarm_delay_ms: 300000, ack_escalation_min: 30,
      electricity_currency: 'UAH',
    });
    expect(Number(res.body.data.electricity_rate)).toBe(7.5);

    // The MQTT service reads the override with its registries (refreshRegistries after PATCH;
    // the test app stubs that call, so load them here)
    await mqttSvc.__test.loadRegistries();
    expect(mqttSvc.__test.tenantSettings.get(tenant.id).door_alarm_delay_ms).toBe(300000);

    // Partial update keeps the rest; NULL clears an override
    const res2 = await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(authHeader(admin, tenant.id))
      .send({ door_alarm_delay_ms: null });
    expect(res2.body.data).toMatchObject({ timezone: 'Europe/Warsaw', door_alarm_delay_ms: null, ack_escalation_min: 30 });
  });

  it('validates ranges and time zones', async () => {
    const hdr = authHeader(admin, tenant.id);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(hdr).send({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(hdr).send({ offline_threshold_ms: 1000 })).status).toBe(400);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(hdr).send({ ack_escalation_min: 0 })).status).toBe(400);
    expect((await request(app).patch(`/api/tenants/${tenant.id}/settings`).set(hdr).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/tenants/${db.SYSTEM_TENANT_ID}/settings`).set(authHeader(superadmin, other.id)).send({ locale: 'en' })).status).toBe(400);
  });
});
