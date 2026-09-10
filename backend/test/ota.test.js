'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createDevice, createFirmware, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('OTA Routes', () => {
  let tenant, admin, viewer, device, firmware;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'ota-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@ota.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@ota.test' });
    device = await createDevice(tenant.id, { name: 'OTA Device' });
    firmware = await createFirmware(tenant.id, { version: '1.0.0-ota' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // --- Deploy single ---
  it('admin can deploy firmware to single device', async () => {
    const res = await request(app)
      .post('/api/ota/deploy')
      .set(authHeader(admin, tenant.id))
      .send({ firmware_id: firmware.id, device_id: device.mqtt_device_id });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('sent');
    expect(res.body.data.device_id).toBe(device.mqtt_device_id);
  });

  it('rejects deploy without firmware_id', async () => {
    const res = await request(app)
      .post('/api/ota/deploy')
      .set(authHeader(admin, tenant.id))
      .send({ device_id: device.mqtt_device_id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_params');
  });

  it('rejects deploy without device_id', async () => {
    const res = await request(app)
      .post('/api/ota/deploy')
      .set(authHeader(admin, tenant.id))
      .send({ firmware_id: firmware.id });

    expect(res.status).toBe(400);
  });

  // --- Rollout ---
  it('admin can create rollout', async () => {
    const res = await request(app)
      .post('/api/ota/rollout')
      .set(authHeader(admin, tenant.id))
      .send({
        firmware_id: firmware.id,
        batch_size: 3,
        batch_interval_s: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('running');
  });

  it('mass rollout is a plan feature; a free organisation is refused, a «Про» one is not', async () => {
    // `ota_rollout` sat in plan_limits.features from the first seed and was never
    // checked, so a free organisation could roll firmware across its whole fleet —
    // the one OTA operation with real blast radius. Single-device deploy stays
    // open to every plan.
    const freeTenant = await createTenant({ slug: 'ota-free', plan: 'free' });
    const freeAdmin  = await createUser(freeTenant.id, { role: 'admin', email: 'admin@ota-free.test' });
    const freeDevice = await createDevice(freeTenant.id, { name: 'Free Device' });
    const freeFw     = await createFirmware(freeTenant.id, { version: '1.0.0-free' });

    const refused = await request(app)
      .post('/api/ota/rollout')
      .set(authHeader(freeAdmin, freeTenant.id))
      .send({ firmware_id: freeFw.id, device_ids: [freeDevice.mqtt_device_id] });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe('plan_feature');

    // the single-device path is not gated
    const single = await request(app)
      .post('/api/ota/deploy')
      .set(authHeader(freeAdmin, freeTenant.id))
      .send({ firmware_id: freeFw.id, device_id: freeDevice.mqtt_device_id });
    expect(single.status).toBe(201);

    const allowed = await request(app)
      .post('/api/ota/rollout')
      .set(authHeader(admin, tenant.id))
      .send({ firmware_id: firmware.id, device_ids: [device.mqtt_device_id] });
    expect(allowed.status).toBe(201);
  });

  it('rejects rollout without firmware_id', async () => {
    const res = await request(app)
      .post('/api/ota/rollout')
      .set(authHeader(admin, tenant.id))
      .send({});

    expect(res.status).toBe(400);
  });

  // --- List jobs/rollouts ---
  it('admin can list OTA jobs', async () => {
    const res = await request(app)
      .get('/api/ota/jobs')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('admin can list rollouts', async () => {
    const res = await request(app)
      .get('/api/ota/rollouts')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  // --- RBAC ---
  it('viewer cannot deploy OTA (403)', async () => {
    const res = await request(app)
      .post('/api/ota/deploy')
      .set(authHeader(viewer, tenant.id))
      .send({ firmware_id: firmware.id, device_id: device.mqtt_device_id });

    expect(res.status).toBe(403);
  });

  it('viewer cannot list OTA jobs (403)', async () => {
    const res = await request(app)
      .get('/api/ota/jobs')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  it('viewer cannot create rollout (403)', async () => {
    const res = await request(app)
      .post('/api/ota/rollout')
      .set(authHeader(viewer, tenant.id))
      .send({ firmware_id: firmware.id });

    expect(res.status).toBe(403);
  });
});
