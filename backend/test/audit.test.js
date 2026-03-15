'use strict';

// globals: true in vitest.config.js
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();

describe('Audit Log', () => {
  let tenant, superadmin, admin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'audit-test' });
    superadmin = await createUser(tenant.id, { role: 'superadmin', email: 'sa@audit.test' });
    admin = await createUser(tenant.id, { role: 'admin', email: 'admin@audit.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('mutation creates audit log entry', async () => {
    // Create a user (mutation) to trigger audit
    await request(app)
      .post('/api/users')
      .set(authHeader(admin, tenant.id))
      .send({ email: 'audited@audit.test', password: 'Test1234!', role: 'viewer' });

    // Wait briefly for async insert
    await new Promise(r => setTimeout(r, 100));

    const { rows } = await db.query(
      `SELECT * FROM audit_log WHERE action = 'user.create' ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].method).toBe('POST');
    expect(rows[0].user_email).toBe(admin.email);
    expect(rows[0].entity_type).toBe('user');
  });

  it('GET does not create audit entry', async () => {
    // Note: audit_log has immutability trigger on UPDATE/DELETE
    // but we use raw SQL DELETE in tests which bypasses trigger (we're superuser)
    const countBefore = (await db.query('SELECT COUNT(*)::int AS c FROM audit_log')).rows[0].c;

    await request(app)
      .get('/api/devices')
      .set(authHeader(admin, tenant.id));

    await new Promise(r => setTimeout(r, 100));

    const countAfter = (await db.query('SELECT COUNT(*)::int AS c FROM audit_log')).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('superadmin can query audit log', async () => {
    const res = await request(app)
      .get('/api/audit-log')
      .set(authHeader(superadmin, tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('admin cannot access audit log (403)', async () => {
    const res = await request(app)
      .get('/api/audit-log')
      .set(authHeader(admin, tenant.id));

    expect(res.status).toBe(403);
  });

  it('audit log supports filtering', async () => {
    const res = await request(app)
      .get(`/api/audit-log?entity_type=user&limit=5`)
      .set(authHeader(superadmin, tenant.id));

    expect(res.status).toBe(200);
    for (const entry of res.body.data) {
      expect(entry.entity_type).toBe('user');
    }
  });
});
