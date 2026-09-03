'use strict';

// Showcase public links (site_public_links.rate_limit_exempt, migration 029)
// skip the per-IP limiter of /api/public; every other link keeps it.
// globals: true in vitest.config.js

const request = require('supertest');
const crypto  = require('crypto');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant } = require('./helpers/factories');
const publicRouter = require('../src/routes/public');

const app = createTestApp();

async function mintLink(tenantId, siteId, exempt) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await db.query(
    `INSERT INTO site_public_links (tenant_id, site_id, token_hash, label, expires_at, rate_limit_exempt)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days', $5)`,
    [tenantId, siteId, hash, exempt ? 'showcase' : 'normal', exempt]);
  return raw;
}

describe('showcase links skip the public limiter (plan epic 1.10)', () => {
  let tenant, site, showcase, normal;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'showcase' });
    const { rows } = await db.query(
      `INSERT INTO sites (tenant_id, name, city, country) VALUES ($1, 'Демо-точка', 'Київ', 'Україна') RETURNING id`, [tenant.id]);
    site = rows[0];
    showcase = await mintLink(tenant.id, site.id, true);
    normal   = await mintLink(tenant.id, site.id, false);
    await publicRouter.refreshExempt();
    await publicRouter.resetRateLimit();
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('a normal link is limited to 30 views per window', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await request(app).get('/api/public/site').set('X-Site-Token', normal)).status).toBe(200);
    }
    expect((await request(app).get('/api/public/site').set('X-Site-Token', normal)).status).toBe(429);
  });

  it('a showcase link keeps answering past the limit', async () => {
    await publicRouter.resetRateLimit();
    for (let i = 0; i < 40; i++) {
      const res = await request(app).get('/api/public/site').set('X-Site-Token', showcase);
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Демо-точка');
    }
    // and its views do not consume the budget of ordinary links from the same IP
    expect((await request(app).get('/api/public/site').set('X-Site-Token', normal)).status).toBe(200);
  });

  it('an unknown token is never exempt, and a revoked showcase link loses the exemption', async () => {
    expect(publicRouter.isExempt({ get: () => 'not-a-token' })).toBe(false);
    expect(publicRouter.isExempt({ get: () => showcase })).toBe(true);
    await db.query(`UPDATE site_public_links SET revoked_at = NOW() WHERE label = 'showcase'`);
    await publicRouter.refreshExempt();
    expect(publicRouter.isExempt({ get: () => showcase })).toBe(false);
  });
});
