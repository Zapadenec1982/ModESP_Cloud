'use strict';

// globals: true in vitest.config.js
//
// «Is this organisation still ours to serve?»
//
// tenants.status is trial / active / past_due / suspended / closed. Most
// background work already agreed that the first three are a running customer —
// past_due included, because an unpaid invoice must not switch a fridge alarm off
// — and wrote the list inline. Two jobs never asked at all, and one public page
// never asked either:
//
//   • the webhook queue kept POSTing a suspended customer's alarms to their
//     integration, with a retry backlog nobody reads;
//   • the offline detector kept raising alarms for them — and every controller of
//     an organisation that leaves goes quiet at once, so that is one alarm per
//     cabinet, two minutes later;
//   • the public status page kept showing a closed organisation's equipment names
//     and temperatures to anyone still holding the link, which needs no sign-in —
//     that one is covered in public-site.test.js, which assembles the route above
//     the auth gate the way index.js does.
//
// The rule now lives in lib/tenant-status.js.

const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant } = require('./helpers/factories');
const { isServing, servingSql, SERVING, NOT_SERVING } = require('../src/lib/tenant-status');
const webhooks = require('../src/services/webhooks');

afterAll(async () => { await shutdownDb(); });

describe('The serving rule itself', () => {
  it('serves a running customer, including one with an unpaid invoice', () => {
    for (const s of SERVING) expect(isServing(s)).toBe(true);
    expect(SERVING).toContain('past_due');
  });

  it('stops at suspended and closed', () => {
    for (const s of NOT_SERVING) expect(isServing(s)).toBe(false);
  });

  it('treats an unknown or missing status as serving, so nothing goes silent by accident', () => {
    for (const s of [null, undefined, '', 'something_new']) expect(isServing(s)).toBe(true);
  });

  it('offers the same rule as SQL, with no placeholder to renumber', () => {
    expect(servingSql('t')).toBe("t.status IN ('trial', 'active', 'past_due')");
    expect(servingSql('w')).toContain('w.status');
  });
});

describe('A suspended organisation stops receiving webhook deliveries (M3)', () => {
  let tenant;

  const hook = async (tenantId) => db.query(
    `INSERT INTO webhooks (tenant_id, name, url, secret, events, enabled)
     VALUES ($1, 'Тест', 'https://example.test/hook', 'x', ARRAY['*'], true)`, [tenantId]);
  const queued = async (tenantId) => (await db.query(
    'SELECT count(*)::int AS n FROM webhook_deliveries WHERE tenant_id = $1', [tenantId])).rows[0].n;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'serving-hooks' });
    await hook(tenant.id);
  });

  afterAll(async () => { await cleanDatabase(); });

  it('queues while the organisation is served, and stops when it is suspended', async () => {
    for (const status of SERVING) {
      await db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, status]);
      const ids = await webhooks.enqueue(tenant.id, 'alarm.raised', { device_id: 'X' });
      expect(ids).toHaveLength(1);
    }
    expect(await queued(tenant.id)).toBe(SERVING.length);

    for (const status of NOT_SERVING) {
      await db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, status]);
      const ids = await webhooks.enqueue(tenant.id, 'alarm.raised', { device_id: 'X' });
      expect(ids).toEqual([]);
    }
    expect(await queued(tenant.id)).toBe(SERVING.length);   // nothing added
  });
});
