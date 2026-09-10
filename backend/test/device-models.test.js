'use strict';

// globals: true in vitest.config.js
//
// Equipment models: the power profile behind every energy figure.
//
// The whole router shipped without a single test — it was not even mounted in
// the test app, so no suite could have reached it (test/router-coverage.test.js
// now guards that). What it holds is not decorative: `compressor_kw` and its
// siblings are what `GET /devices/:id/energy/summary` and the live estimate in
// mqtt.js multiply the compressor's run time by.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

afterAll(async () => { await shutdownDb(); });

describe('Equipment models', () => {
  let tenantA, tenantB, adminA, adminB, techA, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA = await createTenant({ slug: 'models-a' });
    tenantB = await createTenant({ slug: 'models-b' });
    adminA  = await createUser(tenantA.id, { role: 'admin', email: 'admin@models-a.test' });
    adminB  = await createUser(tenantB.id, { role: 'admin', email: 'admin@models-b.test' });
    techA   = await createUser(tenantA.id, { role: 'technician', email: 'tech@models-a.test' });
    superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'super@models.test' });
  });

  const create = (user, tenant, body) =>
    request(app).post('/api/device-models').set(authHeader(user, tenant.id)).send(body);

  it('an administrator creates a model; a technician may read but not write', async () => {
    const res = await create(adminA, tenantA, {
      name: 'Бонета 2.5 м', compressor_kw: 1.5, evap_fan_kw: 0.12, cond_fan_kw: 0.2,
      defrost_heater_kw: 0.9, standby_kw: 0.02,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Бонета 2.5 м', energy_source: 'estimated' });
    expect(Number(res.body.data.compressor_kw)).toBe(1.5);

    const list = await request(app).get('/api/device-models').set(authHeader(techA, tenantA.id));
    expect(list.status).toBe(200);
    expect(list.body.data.map(m => m.name)).toContain('Бонета 2.5 м');

    expect((await create(techA, tenantA, { name: 'Не можна' })).status).toBe(403);
  });

  it('refuses a nameless model and an unknown energy source', async () => {
    expect((await create(adminA, tenantA, { name: '' })).status).toBe(400);
    expect((await create(adminA, tenantA, { name: 'X', energy_source: 'guessed' })).status).toBe(400);
  });

  it('the list is the organisation\'s own; a superadmin sees every organisation', async () => {
    await create(adminB, tenantB, { name: 'Шафа B', compressor_kw: 3 });

    const a = await request(app).get('/api/device-models').set(authHeader(adminA, tenantA.id));
    expect(a.body.data.map(m => m.name)).not.toContain('Шафа B');

    const all = await request(app).get('/api/device-models').set(authHeader(superadmin, tenantA.id));
    expect(all.body.data.map(m => m.name)).toEqual(expect.arrayContaining(['Бонета 2.5 м', 'Шафа B']));
    expect(all.body.data.every(m => m.tenant_name)).toBe(true);
  });

  it('renames and repowers a model, and refuses to touch another organisation\'s', async () => {
    const { rows: [mine] } = await db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw) VALUES ($1, 'Стара назва', 1) RETURNING id`, [tenantA.id]);

    const ok = await request(app).patch(`/api/device-models/${mine.id}`)
      .set(authHeader(adminA, tenantA.id)).send({ name: 'Нова назва', compressor_kw: 2.25 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('Нова назва');
    expect(Number(ok.body.data.compressor_kw)).toBe(2.25);

    const foreign = await request(app).patch(`/api/device-models/${mine.id}`)
      .set(authHeader(adminB, tenantB.id)).send({ name: 'Захоплення' });
    expect(foreign.status).toBe(404);
  });

  it('a model in use is not deleted, and the count is of the organisation\'s own devices', async () => {
    const { rows: [model] } = await db.query(
      `INSERT INTO device_models (tenant_id, name, compressor_kw) VALUES ($1, 'У вжитку', 1) RETURNING id`, [tenantA.id]);
    const device = await createDevice(tenantA.id, { mqttId: 'MODEL1', name: 'Камера' });
    await db.query('UPDATE devices SET model_id = $1 WHERE id = $2', [model.id, device.id]);

    // A stale cross-tenant reference — the shape PATCH /devices/:id used to allow.
    // It must not show up in this organisation's count, nor block its delete.
    const foreignDevice = await createDevice(tenantB.id, { mqttId: 'MODEL2', name: 'Чужа' });
    await db.query('UPDATE devices SET model_id = $1 WHERE id = $2', [model.id, foreignDevice.id]);

    const list = await request(app).get('/api/device-models').set(authHeader(adminA, tenantA.id));
    expect(list.body.data.find(m => m.id === model.id).device_count).toBe(1);

    const busy = await request(app).delete(`/api/device-models/${model.id}`).set(authHeader(adminA, tenantA.id));
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('in_use');

    await db.query('UPDATE devices SET model_id = NULL WHERE id = $1', [device.id]);
    await db.query('UPDATE devices SET model_id = NULL WHERE id = $1', [foreignDevice.id]);

    const gone = await request(app).delete(`/api/device-models/${model.id}`).set(authHeader(adminA, tenantA.id));
    expect(gone.status).toBe(200);
    expect((await request(app).delete(`/api/device-models/${model.id}`).set(authHeader(adminA, tenantA.id))).status).toBe(404);
  });
});
