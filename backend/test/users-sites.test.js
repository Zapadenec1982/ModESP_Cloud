'use strict';

// Site-level access grants (POST/GET/DELETE /api/users/:id/sites) and the two
// halves of the technician home base (§7.4): the admin one on PUT /api/users/:id
// and the self-service one on /api/profile.
//
// globals: true in vitest.config.js

const request = require('supertest');
const express = require('express');
const crypto  = require('crypto');
const pino    = require('pino');

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const { authenticate, authorize } = require('../src/middleware/auth');
const createAuditMiddleware = require('../src/middleware/audit');

const silentLogger = pino({ level: 'silent' });

// ── App ───────────────────────────────────────────────────
// helpers/app.js hand-builds its own mount list and carries no /api/profile, so
// this suite assembles the same chain index.js uses around the two routers under
// test — including the ordering that matters: /api/profile is mounted ABOVE the
// admin-only /api/users, otherwise a technician editing their own home base 403s.
function createUsersApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', createAuditMiddleware(silentLogger));
  app.use('/api', authenticate);
  app.use('/api/profile', require('../src/routes/profile'));
  app.use('/api/users', authorize('admin'), require('../src/routes/users'));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });
  return app;
}

const app = createUsersApp();

// ── Local fixtures ────────────────────────────────────────
// sites / user_sites arrive with migration 021 and helpers/factories.js is shared
// with every other suite, so the geo fixtures live here.

function rnd(n = 8) {
  return crypto.randomBytes(8).toString('hex').slice(0, n);
}

async function createSite(tenantId, overrides = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (tenant_id, name, country_code, country, region, city, geo_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      tenantId,
      overrides.name ?? `Site ${rnd()}`,
      overrides.country_code ?? 'UA',
      overrides.country ?? 'Україна',
      overrides.region ?? null,
      overrides.city ?? null,
      overrides.geo_source ?? 'none',
    ]
  );
  return rows[0];
}

async function attachDeviceToSite(deviceId, siteId) {
  await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [siteId, deviceId]);
}

async function grantRows(userId) {
  const { rows } = await db.query(
    'SELECT user_id, site_id, tenant_id, granted_by FROM user_sites WHERE user_id = $1 ORDER BY site_id',
    [userId]
  );
  return rows;
}

// audit_log inserts are fire-and-forget on res 'finish'
async function waitForAudit(sql, params, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const { rows } = await db.query(sql, params);
    if (rows.length > 0) return rows;
    await new Promise(r => setTimeout(r, 50));
  }
  return [];
}

const UNKNOWN_UUID = '00000000-0000-0000-0000-0000000000ff';

describe('User site grants + home base', () => {
  let tenantA, tenantB;
  let adminA, techA, viewerA, superadmin, userB, multiTenantUser;
  let siteA1, siteA2, siteB;
  let devA1, devA2, devDeleted;

  beforeAll(async () => {
    await cleanDatabase();

    tenantA = await createTenant({ slug: 'usites-a' });
    tenantB = await createTenant({ slug: 'usites-b' });

    adminA     = await createUser(tenantA.id, { role: 'admin',      email: 'admin@usites.test' });
    techA      = await createUser(tenantA.id, { role: 'technician', email: 'tech@usites.test' });
    viewerA    = await createUser(tenantA.id, { role: 'viewer',     email: 'viewer@usites.test' });
    superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'root@usites.test' });
    userB      = await createUser(tenantB.id, { role: 'technician', email: 'tech@usites-b.test' });

    // Home tenant A, but also a member of tenant B (switch-tenant flow)
    multiTenantUser = await createUser(tenantA.id, { role: 'technician', email: 'multi@usites.test' });
    await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [multiTenantUser.id, tenantB.id]
    );

    siteA1 = await createSite(tenantA.id, { name: 'АТБ №142', city: 'Київ' });
    siteA2 = await createSite(tenantA.id, { name: 'Сільпо №7', city: 'Львів' });
    siteB  = await createSite(tenantB.id, { name: 'Foreign Site', city: 'Brno' });

    // Two visible devices + one soft-deleted one, all on siteA1
    devA1      = await createDevice(tenantA.id, { name: 'Cabinet 1' });
    devA2      = await createDevice(tenantA.id, { name: 'Cabinet 2' });
    devDeleted = await createDevice(tenantA.id, { name: 'Retired cabinet' });
    await attachDeviceToSite(devA1.id, siteA1.id);
    await attachDeviceToSite(devA2.id, siteA1.id);
    await attachDeviceToSite(devDeleted.id, siteA1.id);
    await db.query(
      `UPDATE devices SET status = 'deleted', deleted_at = NOW() WHERE id = $1`,
      [devDeleted.id]
    );
  });

  afterAll(async () => {
    await shutdownDb();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_sites');
  });

  // ── GET /api/users/:id/sites ────────────────────────────
  describe('GET /api/users/:id/sites', () => {
    it('returns an empty list for a user with no grants', async () => {
      const res = await request(app)
        .get(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('lists granted sites with a device count that ignores soft-deleted devices', async () => {
      await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: siteA1.id });

      const res = await request(app)
        .get(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(siteA1.id);
      expect(res.body.data[0].name).toBe('АТБ №142');
      expect(res.body.data[0].city).toBe('Київ');
      expect(res.body.data[0].device_count).toBe(2);
      expect(res.body.data[0].granted_by).toBe(adminA.id);
    });

    it('404s for a non-UUID user id instead of raising 22P02', async () => {
      const res = await request(app)
        .get('/api/users/notauuid/sites')
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('404s for a user in another tenant', async () => {
      const res = await request(app)
        .get(`/api/users/${userB.id}/sites`)
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
    });

    it('403s for a technician (admin-only mount)', async () => {
      const res = await request(app)
        .get(`/api/users/${techA.id}/sites`)
        .set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(403);
    });

    it('401s without an Authorization header', async () => {
      const res = await request(app).get(`/api/users/${techA.id}/sites`);
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/users/:id/sites ───────────────────────────
  describe('POST /api/users/:id/sites', () => {
    it('grants a site and records tenant_id + granted_by', async () => {
      const res = await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: siteA1.id });

      expect(res.status).toBe(201);
      expect(res.body.data.site_id).toBe(siteA1.id);

      const rows = await grantRows(techA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].site_id).toBe(siteA1.id);
      expect(rows[0].tenant_id).toBe(tenantA.id);
      expect(rows[0].granted_by).toBe(adminA.id);
    });

    it('is idempotent — a repeated grant does not duplicate the row', async () => {
      const hdr = authHeader(adminA, tenantA.id);
      await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: siteA1.id });
      const res = await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: siteA1.id });

      expect(res.status).toBe(201);
      expect(await grantRows(techA.id)).toHaveLength(1);
    });

    it('REFUSES a site from another tenant and writes nothing', async () => {
      const res = await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: siteB.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_site');
      expect(await grantRows(techA.id)).toHaveLength(0);
    });

    it('refuses a site id that does not exist', async () => {
      const res = await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: UNKNOWN_UUID });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_site');
    });

    it('400s on a missing or malformed site_id', async () => {
      const hdr = authHeader(adminA, tenantA.id);

      const missing = await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('validation_failed');

      const malformed = await request(app)
        .post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: 'not-a-uuid' });
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe('validation_failed');
    });

    it('404s for a target user in another tenant — a grant cannot cross a tenant', async () => {
      const res = await request(app)
        .post(`/api/users/${userB.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: siteB.id });

      expect(res.status).toBe(404);
      expect(await grantRows(userB.id)).toHaveLength(0);
    });

    it('403s for a technician and for a viewer', async () => {
      const asTech = await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(techA, tenantA.id))
        .send({ site_id: siteA1.id });
      expect(asTech.status).toBe(403);

      const asViewer = await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(viewerA, tenantA.id))
        .send({ site_id: siteA1.id });
      expect(asViewer.status).toBe(403);
    });

    it('writes one audit_log row naming the granted site', async () => {
      // A site used by no other case: audit_log survives every test in this file
      // (its immutability trigger forbids DELETE), so the assertion must key on
      // something unique to this grant.
      const auditSite = await createSite(tenantA.id, { name: `Audit ${rnd()}`, city: 'Дніпро' });

      await request(app)
        .post(`/api/users/${techA.id}/sites`)
        .set(authHeader(adminA, tenantA.id))
        .send({ site_id: auditSite.id });

      const rows = await waitForAudit(
        `SELECT action, entity_id, changes, status_code FROM audit_log
          WHERE method = 'POST' AND changes->>'site_id' = $1`,
        [auditSite.id]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].status_code).toBe(201);
      expect(rows[0].entity_id).toBe(techA.id);
      expect(rows[0].changes.action).toBe('grant');
    });

    it('scopes the site check to the TARGET user tenant for a superadmin', async () => {
      // Superadmin is acting inside tenant A but granting to a tenant-B user.
      const ok = await request(app)
        .post(`/api/users/${userB.id}/sites`)
        .set(authHeader(superadmin, tenantA.id))
        .send({ site_id: siteB.id });

      expect(ok.status).toBe(201);
      const rows = await grantRows(userB.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantB.id);

      // …and the site of the tenant the superadmin is acting in is still refused.
      const refused = await request(app)
        .post(`/api/users/${userB.id}/sites`)
        .set(authHeader(superadmin, tenantA.id))
        .send({ site_id: siteA1.id });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_site');
      expect(await grantRows(userB.id)).toHaveLength(1);
    });
  });

  // ── DELETE /api/users/:id/sites/:siteId ─────────────────
  describe('DELETE /api/users/:id/sites/:siteId', () => {
    it('revokes a grant', async () => {
      const hdr = authHeader(adminA, tenantA.id);
      await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: siteA1.id });
      expect(await grantRows(techA.id)).toHaveLength(1);

      const res = await request(app)
        .delete(`/api/users/${techA.id}/sites/${siteA1.id}`)
        .set(hdr);

      expect(res.status).toBe(200);
      expect(await grantRows(techA.id)).toHaveLength(0);
    });

    it('leaves other grants of the same user untouched', async () => {
      const hdr = authHeader(adminA, tenantA.id);
      await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: siteA1.id });
      await request(app).post(`/api/users/${techA.id}/sites`).set(hdr).send({ site_id: siteA2.id });

      await request(app).delete(`/api/users/${techA.id}/sites/${siteA1.id}`).set(hdr);

      const rows = await grantRows(techA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].site_id).toBe(siteA2.id);
    });

    it('404s for a non-UUID id and for a user in another tenant', async () => {
      const hdr = authHeader(adminA, tenantA.id);

      const badId = await request(app).delete(`/api/users/${techA.id}/sites/nope`).set(hdr);
      expect(badId.status).toBe(404);

      const otherTenant = await request(app)
        .delete(`/api/users/${userB.id}/sites/${siteB.id}`).set(hdr);
      expect(otherTenant.status).toBe(404);
    });

    it('cannot revoke a grant held in another tenant', async () => {
      // Grant recorded directly: userB lives in tenant B.
      await db.query(
        `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by)
         VALUES ($1, $2, $3, $4)`,
        [userB.id, siteB.id, tenantB.id, null]
      );

      const res = await request(app)
        .delete(`/api/users/${userB.id}/sites/${siteB.id}`)
        .set(authHeader(adminA, tenantA.id));

      expect(res.status).toBe(404);
      expect(await grantRows(userB.id)).toHaveLength(1);
    });

    it('403s for a technician', async () => {
      const res = await request(app)
        .delete(`/api/users/${techA.id}/sites/${siteA1.id}`)
        .set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(403);
    });
  });

  // ── Membership removal cleans up grants ─────────────────
  describe('DELETE /api/users/:id/tenants/:tenantId', () => {
    it('removes the site grants held in the tenant the user just left', async () => {
      await db.query(
        `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)`,
        [multiTenantUser.id, siteA1.id, tenantA.id, adminA.id]
      );
      await db.query(
        `INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)`,
        [multiTenantUser.id, siteB.id, tenantB.id, adminA.id]
      );

      const res = await request(app)
        .delete(`/api/users/${multiTenantUser.id}/tenants/${tenantB.id}`)
        .set(authHeader(superadmin, tenantA.id));

      expect(res.status).toBe(200);

      const rows = await grantRows(multiTenantUser.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantA.id);
    });
  });

  // ── Home base via the admin endpoint ────────────────────
  describe('PUT /api/users/:id — technician home base', () => {
    afterEach(async () => {
      await db.query(
        'UPDATE users SET base_latitude = NULL, base_longitude = NULL, base_address = NULL WHERE id = $1',
        [techA.id]
      );
    });

    it('lets an admin set a base location', async () => {
      const res = await request(app)
        .put(`/api/users/${techA.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ base_latitude: 50.4498, base_longitude: 30.5231, base_address: 'Хрещатик 22, Київ' });

      expect(res.status).toBe(200);
      expect(res.body.data.base_latitude).toBeCloseTo(50.4498, 4);
      expect(res.body.data.base_longitude).toBeCloseTo(30.5231, 4);
      expect(res.body.data.base_address).toBe('Хрещатик 22, Київ');

      const { rows } = await db.query(
        'SELECT base_latitude, base_longitude FROM users WHERE id = $1', [techA.id]
      );
      expect(Number(rows[0].base_latitude)).toBeCloseTo(50.4498, 4);
    });

    it('clears a base location with explicit nulls', async () => {
      const hdr = authHeader(adminA, tenantA.id);
      await request(app).put(`/api/users/${techA.id}`).set(hdr)
        .send({ base_latitude: 49.8440, base_longitude: 24.0262, base_address: 'Львів' });

      const res = await request(app).put(`/api/users/${techA.id}`).set(hdr)
        .send({ base_latitude: null, base_longitude: null, base_address: null });

      expect(res.status).toBe(200);
      expect(res.body.data.base_latitude).toBeNull();
      expect(res.body.data.base_longitude).toBeNull();
    });

    it('rejects a half-set coordinate pair', async () => {
      const res = await request(app)
        .put(`/api/users/${techA.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ base_latitude: 50.4498 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('rejects an out-of-range coordinate', async () => {
      const res = await request(app)
        .put(`/api/users/${techA.id}`)
        .set(authHeader(adminA, tenantA.id))
        .send({ base_latitude: 91, base_longitude: 30 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('exposes the base location on GET /api/users and GET /api/profile', async () => {
      const hdr = authHeader(adminA, tenantA.id);
      await request(app).put(`/api/users/${techA.id}`).set(hdr)
        .send({ base_latitude: 46.4843, base_longitude: 30.7406, base_address: 'Дерибасівська 12, Одеса' });

      const list = await request(app).get('/api/users').set(hdr);
      expect(list.status).toBe(200);
      const listed = list.body.data.find(u => u.id === techA.id);
      expect(Number(listed.base_latitude)).toBeCloseTo(46.4843, 4);
      expect(listed.base_address).toBe('Дерибасівська 12, Одеса');

      const me = await request(app).get('/api/profile').set(hdr);
      expect(me.status).toBe(200);
      expect(me.body.data).toHaveProperty('base_latitude');
      expect(me.body.data).toHaveProperty('base_longitude');
      expect(me.body.data).toHaveProperty('base_address');
    });
  });

  // ── Home base via self-service /api/profile ─────────────
  describe('/api/profile', () => {
    afterEach(async () => {
      await db.query(
        'UPDATE users SET base_latitude = NULL, base_longitude = NULL, base_address = NULL WHERE id = $1',
        [techA.id]
      );
    });

    it('returns only the profile fields — never a hash or a token', async () => {
      const res = await request(app).get('/api/profile').set(authHeader(techA, tenantA.id));

      expect(res.status).toBe(200);
      // Plan epic 1.5 widened the row to what the settings menu needs, but it
      // must never carry a hash, a reset code or a link code.
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['active', 'base_address', 'base_latitude', 'base_longitude', 'created_at', 'email',
         'id', 'last_login', 'role', 'telegram_id'].sort()
      );
      expect(JSON.stringify(res.body.data)).not.toContain('$2b$');
      expect(res.body.data).not.toHaveProperty('password_hash');
      expect(res.body.data).not.toHaveProperty('password_reset_code');
      expect(res.body.data).not.toHaveProperty('telegram_link_code');
    });

    it('lets a technician move their own home base', async () => {
      const res = await request(app)
        .patch('/api/profile')
        .set(authHeader(techA, tenantA.id))
        .send({ base_latitude: 49.9991, base_longitude: 36.2322, base_address: 'Сумська 25, Харків' });

      expect(res.status).toBe(200);
      expect(res.body.data.base_address).toBe('Сумська 25, Харків');

      const after = await request(app).get('/api/profile').set(authHeader(techA, tenantA.id));
      expect(Number(after.body.data.base_latitude)).toBeCloseTo(49.9991, 4);
    });

    it('ignores every field that is not a base location', async () => {
      const res = await request(app)
        .patch('/api/profile')
        .set(authHeader(techA, tenantA.id))
        .send({ role: 'admin', email: 'hacker@usites.test', active: false, base_address: 'Полтава' });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('technician');
      expect(res.body.data.email).toBe('tech@usites.test');

      const { rows } = await db.query('SELECT role, email, active FROM users WHERE id = $1', [techA.id]);
      expect(rows[0].role).toBe('technician');
      expect(rows[0].email).toBe('tech@usites.test');
      expect(rows[0].active).toBe(true);
    });

    it('400s on an empty body, a half-set pair and an out-of-range coordinate', async () => {
      const hdr = authHeader(techA, tenantA.id);

      const empty = await request(app).patch('/api/profile').set(hdr).send({});
      expect(empty.status).toBe(400);

      const half = await request(app).patch('/api/profile').set(hdr).send({ base_longitude: 30 });
      expect(half.status).toBe(400);

      const range = await request(app).patch('/api/profile').set(hdr)
        .send({ base_latitude: 10, base_longitude: 181 });
      expect(range.status).toBe(400);
    });

    it('never touches another user row', async () => {
      await request(app)
        .patch('/api/profile')
        .set(authHeader(techA, tenantA.id))
        .send({ base_latitude: 48.4645, base_longitude: 35.0474, base_address: 'Дніпро' });

      const { rows } = await db.query(
        'SELECT base_latitude FROM users WHERE id = $1', [viewerA.id]
      );
      expect(rows[0].base_latitude).toBeNull();
    });

    it('401s without an Authorization header', async () => {
      const res = await request(app).get('/api/profile');
      expect(res.status).toBe(401);
    });
  });
});
