'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Notifications', () => {
  let tenant, admin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'notif-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@notif.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Subscribers CRUD ──

  it('can create a telegram subscriber', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'telegram', address: '123456789', label: 'Test Bot' });

    expect(res.status).toBe(201);
    expect(res.body.data.channel).toBe('telegram');
    expect(res.body.data.address).toBe('123456789');
    expect(res.body.data.active).toBe(true);
  });

  it('rejects duplicate subscriber', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'telegram', address: '123456789' });

    expect(res.status).toBe(409);
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'telegram' });

    expect(res.status).toBe(400);
  });

  it('validates channel type', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'invalid', address: '123' });

    expect(res.status).toBe(400);
  });

  it('can list subscribers', async () => {
    const res = await request(app)
      .get('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('can soft-delete a subscriber', async () => {
    // Create a subscriber to delete
    const createRes = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'telegram', address: '999888777', label: 'To Delete' });

    const subId = createRes.body.data.id;

    const res = await request(app)
      .delete(`/api/notifications/subscribers/${subId}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
  });

  it('reactivates a soft-deleted subscriber on re-create', async () => {
    const res = await request(app)
      .post('/api/notifications/subscribers')
      .set(authHeader(admin, tenant.id))
      .send({ channel: 'telegram', address: '999888777', label: 'Reactivated' });

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
  });

  it('returns 404 deleting nonexistent subscriber', async () => {
    const res = await request(app)
      .delete('/api/notifications/subscribers/00000000-0000-0000-0000-000000000099')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });

  // ── Test send ──

  it('test send requires subscriber_id', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set(authHeader(admin, tenant.id))
      .send({});

    expect(res.status).toBe(400);
  });

  // ── Notification log ──

  it('can retrieve notification log', async () => {
    const res = await request(app)
      .get('/api/notifications/log')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .get('/api/notifications/subscribers');

    expect(res.status).toBe(401);
  });
});
