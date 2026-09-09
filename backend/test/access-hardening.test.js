'use strict';

// globals: true in vitest.config.js
//
// Four boundaries the integrity audit of 09.09.2026 found open. Each test
// fails against the code as it stood before the fix:
//   • a reset code for a user whose home is another organisation
//   • notification subscribers and the delivery log with no role gate
//   • a service record deleted through a device the caller may not touch
//   • a compliance download that left no audit row

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, grantDeviceAccess, authHeader } = require('./helpers/factories');

const app = createTestApp();

afterAll(async () => { await shutdownDb(); });

describe('Access hardening (integrity audit)', () => {
  let home, other, homeAdmin, otherAdmin, superadmin, guest;

  beforeAll(async () => {
    await cleanDatabase();
    home  = await createTenant({ slug: 'harden-home' });
    other = await createTenant({ slug: 'harden-other' });

    homeAdmin  = await createUser(home.id,  { role: 'admin', email: 'admin@home.test' });
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@other.test' });
    superadmin = await createUser(home.id,  { role: 'superadmin', email: 'root@harden.test' });

    // A partner engineer: home organisation is `other`, a MEMBER of `home`.
    guest = await createUser(other.id, { role: 'technician', email: 'engineer@other.test' });
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'technician')
       ON CONFLICT DO NOTHING`, [guest.id, home.id]);
  });

  afterAll(async () => { await cleanDatabase(); });

  describe('a password reset belongs to the home organisation', () => {
    it('the admin of an organisation the user is only a member of gets 404', async () => {
      const res = await request(app)
        .post(`/api/users/${guest.id}/password-reset`)
        .set(authHeader(homeAdmin, home.id));
      expect(res.status).toBe(404);

      const { rows } = await db.query('SELECT password_reset_code FROM users WHERE id = $1', [guest.id]);
      expect(rows[0].password_reset_code).toBeNull();
    });

    it('the admin of the home organisation and a superadmin still get a code', async () => {
      const own = await request(app)
        .post(`/api/users/${guest.id}/password-reset`)
        .set(authHeader(otherAdmin, other.id));
      expect(own.status).toBe(200);
      expect(own.body.data.reset_code).toMatch(/^[0-9a-f]{16}$/);
      expect(own.body.data.email).toBe('engineer@other.test');

      const root = await request(app)
        .post(`/api/users/${guest.id}/password-reset`)
        .set(authHeader(superadmin, home.id));
      expect(root.status).toBe(200);
    });
  });

  describe('notification routes are administration', () => {
    it('a viewer may neither read the log nor add a recipient', async () => {
      const viewer = await createUser(home.id, { role: 'viewer', email: 'viewer@home.test' });
      const h = authHeader(viewer, home.id);

      expect((await request(app).get('/api/notifications/subscribers').set(h)).status).toBe(403);
      expect((await request(app).get('/api/notifications/log').set(h)).status).toBe(403);
      expect((await request(app).post('/api/notifications/subscribers').set(h)
        .send({ channel: 'email', address: 'leak@example.com' })).status).toBe(403);
      expect((await request(app).post('/api/notifications/test').set(h).send({})).status).toBe(403);

      const { rows } = await db.query('SELECT count(*)::int AS n FROM notification_subscribers WHERE tenant_id = $1', [home.id]);
      expect(rows[0].n).toBe(0);
    });

    it('an admin still manages them', async () => {
      const list = await request(app).get('/api/notifications/subscribers').set(authHeader(homeAdmin, home.id));
      expect(list.status).toBe(200);
    });
  });

  describe('a service record can only be deleted through its own device', () => {
    let devA, devB, recordB, tech;

    beforeAll(async () => {
      devA = await createDevice(home.id, { mqttId: 'HARD01', name: 'Вітрина A' });
      devB = await createDevice(home.id, { mqttId: 'HARD02', name: 'Вітрина B' });
      tech = await createUser(home.id, { role: 'technician', email: 'tech@home.test' });
      await grantDeviceAccess(tech.id, devA.id);

      const { rows } = await db.query(
        `INSERT INTO service_records (tenant_id, device_id, service_date, technician, reason, work_done)
         VALUES ($1, $2, '2026-09-01', 'Іван', 'ТО', 'Чистка конденсатора') RETURNING id`,
        [home.id, devB.id]);
      recordB = rows[0].id;
    });

    it('a technician cannot delete another device’s record through the one they hold', async () => {
      const res = await request(app)
        .delete(`/api/devices/${devA.id}/service-records/${recordB}`)
        .set(authHeader(tech, home.id));
      expect(res.status).toBe(404);

      const { rows } = await db.query('SELECT count(*)::int AS n FROM service_records WHERE id = $1', [recordB]);
      expect(rows[0].n).toBe(1);
    });

    it('the admin deletes it through the device that owns it', async () => {
      const wrong = await request(app)
        .delete(`/api/devices/${devA.id}/service-records/${recordB}`)
        .set(authHeader(homeAdmin, home.id));
      expect(wrong.status).toBe(404);

      const right = await request(app)
        .delete(`/api/devices/${devB.id}/service-records/${recordB}`)
        .set(authHeader(homeAdmin, home.id));
      expect(right.status).toBe(200);

      const { rows } = await db.query('SELECT count(*)::int AS n FROM service_records WHERE id = $1', [recordB]);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('a compliance download leaves an audit row', () => {
    it('records the archived report a handler flags, not only the paths that look like exports', async () => {
      const code = 'HARDEN000001';
      await db.query(
        `INSERT INTO report_exports (code, kind, tenant_id, device_id, site_id, period_from, period_to,
                                     bucket, source, lang, sha256, generated_by, report_type, pdf, file_name, bytes)
         VALUES ($1, 'site', $2, NULL, NULL, now() - interval '1 day', now(), '1h', 'raw', 'uk', $3, 'schedule', 'haccp', $4, 'haccp_test.pdf', 4)`,
        [code, home.id, 'a'.repeat(64), Buffer.from('%PDF')]);

      const res = await request(app)
        .get(`/api/reports/${code}/download`)
        .set(authHeader(homeAdmin, home.id))
        .buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);

      await new Promise(r => setTimeout(r, 250));
      const { rows } = await db.query(
        `SELECT action, entity_id, changes FROM audit_log WHERE action = 'report.download' AND entity_id = $1`, [code]);
      expect(rows).toHaveLength(1);
      expect(rows[0].changes.sha256).toBe('a'.repeat(64));
    });
  });
});
