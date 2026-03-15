'use strict';

const request = require('supertest');
const path = require('path');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { createTenant, createUser, createFirmware, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Firmware CRUD', () => {
  let tenant, admin, viewer;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'firmware-test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@firmware.test' });
    viewer = await createUser(tenant.id, { role: 'viewer', email: 'viewer@firmware.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('admin can list firmwares (empty)', async () => {
    const res = await request(app)
      .get('/api/firmware')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('admin can upload firmware (.bin file)', async () => {
    const res = await request(app)
      .post('/api/firmware/upload')
      .set(authHeader(admin, tenant.id))
      .field('version', '1.0.0')
      .field('notes', 'Initial release')
      .attach('file', Buffer.from('fake-firmware-binary'), 'firmware.bin');

    expect(res.status).toBe(201);
    expect(res.body.data.version).toBe('1.0.0');
    expect(res.body.data.checksum).toMatch(/^sha256:/);
  });

  it('rejects duplicate firmware version', async () => {
    // version 1.0.0 was already uploaded above
    const res = await request(app)
      .post('/api/firmware/upload')
      .set(authHeader(admin, tenant.id))
      .field('version', '1.0.0')
      .attach('file', Buffer.from('another-binary'), 'firmware.bin');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_version');
  });

  it('rejects upload without version', async () => {
    const res = await request(app)
      .post('/api/firmware/upload')
      .set(authHeader(admin, tenant.id))
      .attach('file', Buffer.from('data'), 'firmware.bin');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_version');
  });

  it('rejects non-.bin file', async () => {
    const res = await request(app)
      .post('/api/firmware/upload')
      .set(authHeader(admin, tenant.id))
      .field('version', '2.0.0')
      .attach('file', Buffer.from('data'), 'firmware.txt');

    // Multer fileFilter error propagates through Express error handler
    expect([400, 500]).toContain(res.status);
  });

  it('admin can get firmware by id', async () => {
    const fw = await createFirmware(tenant.id, { version: '2.0.0' });
    const res = await request(app)
      .get(`/api/firmware/${fw.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe('2.0.0');
  });

  it('returns 404 for nonexistent firmware', async () => {
    const res = await request(app)
      .get('/api/firmware/00000000-0000-0000-0000-000000000001')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(404);
  });

  it('admin can delete firmware', async () => {
    const fw = await createFirmware(tenant.id, { version: '3.0.0-del' });
    const res = await request(app)
      .delete(`/api/firmware/${fw.id}`)
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it('viewer cannot access firmware routes (403)', async () => {
    const res = await request(app)
      .get('/api/firmware')
      .set(authHeader(viewer, tenant.id));

    expect(res.status).toBe(403);
  });

  it('viewer cannot upload firmware (403)', async () => {
    const res = await request(app)
      .post('/api/firmware/upload')
      .set(authHeader(viewer, tenant.id))
      .field('version', '9.9.9')
      .attach('file', Buffer.from('data'), 'firmware.bin');

    expect(res.status).toBe(403);
  });
});
