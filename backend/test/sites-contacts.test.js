'use strict';

// globals: true in vitest.config.js
//
// The contact person of a trade point (migration 054): three nullable columns
// on `sites`, written by the organisation's admin through POST / PATCH, read
// with every site row, and never published on the public status page.

const request = require('supertest');
const crypto  = require('crypto');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');

const app = createTestApp();

const CONTACT = { contact_name: 'Олена Коваль', contact_phone: '+380 67 123 45 67', contact_email: 'store142@company.ua' };

/** The audit insert is fire-and-forget — give it a moment, then read it back. */
async function latestAudit(action) {
  await new Promise(r => setTimeout(r, 150));
  const { rows } = await db.query(
    'SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1', [action]);
  return rows[0] || null;
}

describe('Site contacts (migration 054)', () => {
  let tenant, other, admin, tech, otherAdmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'site-contacts' });
    other  = await createTenant({ slug: 'site-contacts-other' });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@contacts.test' });
    tech   = await createUser(tenant.id, { role: 'technician', email: 'tech@contacts.test' });
    otherAdmin = await createUser(other.id, { role: 'admin', email: 'admin@contacts-other.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('the columns exist with the declared lengths', async () => {
    const { rows } = await db.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'sites' AND column_name LIKE 'contact\\_%'
        ORDER BY column_name`);
    expect(rows).toEqual([
      { column_name: 'contact_email', data_type: 'character varying', character_maximum_length: 160, is_nullable: 'YES' },
      { column_name: 'contact_name',  data_type: 'character varying', character_maximum_length: 120, is_nullable: 'YES' },
      { column_name: 'contact_phone', data_type: 'character varying', character_maximum_length: 40,  is_nullable: 'YES' },
    ]);
  });

  it('POST /api/sites stores the contact and returns it; the list and the detail carry it', async () => {
    const res = await request(app).post('/api/sites').set(authHeader(admin, tenant.id))
      .send({ name: 'Магазин №142', city: 'Львів', ...CONTACT });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject(CONTACT);

    const list = await request(app).get('/api/sites').set(authHeader(admin, tenant.id));
    expect(list.status).toBe(200);
    expect(list.body.data.find(s => s.id === res.body.data.id)).toMatchObject(CONTACT);

    const detail = await request(app).get(`/api/sites/${res.body.data.id}`).set(authHeader(admin, tenant.id));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ ...CONTACT, devices: [] });
  });

  it('a site created without a contact answers null, not undefined or an empty string', async () => {
    const res = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Без контакту' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ contact_name: null, contact_phone: null, contact_email: null });
  });

  it('PATCH /api/sites/:id changes and clears the contact, trims what was typed, and audits before/after', async () => {
    const created = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Склад', ...CONTACT });
    const id = created.body.data.id;

    const changed = await request(app).patch(`/api/sites/${id}`).set(authHeader(admin, tenant.id))
      .send({ contact_name: '  Іван Петренко  ', contact_phone: '', contact_email: ' ivan@company.ua ' });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ contact_name: 'Іван Петренко', contact_phone: null, contact_email: 'ivan@company.ua' });
    // The rest of the row is untouched by a contact-only patch
    expect(changed.body.data.name).toBe('Склад');

    const audit = await latestAudit('site.update');
    expect(audit).not.toBeNull();
    expect(audit.changes.before.contact_name).toBe(CONTACT.contact_name);
    expect(audit.changes.after.contact_name).toBe('Іван Петренко');
    expect(audit.changes.after.contact_phone).toBeNull();

    const cleared = await request(app).patch(`/api/sites/${id}`).set(authHeader(admin, tenant.id))
      .send({ contact_name: null, contact_email: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ contact_name: null, contact_phone: null, contact_email: null });
  });

  it('rejects a malformed e-mail and an over-long name, but accepts an empty e-mail as "none"', async () => {
    const bad = await request(app).post('/api/sites').set(authHeader(admin, tenant.id))
      .send({ name: 'Bad mail', contact_email: 'not-an-address' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation_failed');
    expect(bad.body.message).toMatch(/contact_email/);

    const long = await request(app).post('/api/sites').set(authHeader(admin, tenant.id))
      .send({ name: 'Long name', contact_name: 'x'.repeat(121) });
    expect(long.status).toBe(400);

    const empty = await request(app).post('/api/sites').set(authHeader(admin, tenant.id))
      .send({ name: 'Empty mail', contact_email: '   ' });
    expect(empty.status).toBe(201);
    expect(empty.body.data.contact_email).toBeNull();

    const created = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Patch bad', ...CONTACT });
    const patched = await request(app).patch(`/api/sites/${created.body.data.id}`).set(authHeader(admin, tenant.id))
      .send({ contact_email: 'nope' });
    expect(patched.status).toBe(400);
  });

  it('only an admin writes the contact; a technician reads it with the site', async () => {
    const created = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Tech site', ...CONTACT });
    const site = created.body.data;
    const dev = await createDevice(tenant.id, { name: 'Вітрина' });
    await db.query('UPDATE devices SET site_id = $1 WHERE id = $2', [site.id, dev.id]);
    await db.query('INSERT INTO user_sites (user_id, site_id, tenant_id, granted_by) VALUES ($1, $2, $3, $4)', [tech.id, site.id, tenant.id, admin.id]);

    const denied = await request(app).patch(`/api/sites/${site.id}`).set(authHeader(tech, tenant.id)).send({ contact_phone: '000' });
    expect(denied.status).toBe(403);

    const read = await request(app).get(`/api/sites/${site.id}`).set(authHeader(tech, tenant.id));
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject(CONTACT);
    expect(read.body.data.devices).toHaveLength(1);
  });

  it('CROSS-TENANT: another organisation neither reads nor writes the contact', async () => {
    const created = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Private', ...CONTACT });
    const id = created.body.data.id;
    expect((await request(app).get(`/api/sites/${id}`).set(authHeader(otherAdmin, other.id))).status).toBe(404);
    expect((await request(app).patch(`/api/sites/${id}`).set(authHeader(otherAdmin, other.id)).send({ contact_name: 'x' })).status).toBe(404);
    const { rows } = await db.query('SELECT contact_name FROM sites WHERE id = $1', [id]);
    expect(rows[0].contact_name).toBe(CONTACT.contact_name);
  });

  it('the public status page never shows the contact', async () => {
    const created = await request(app).post('/api/sites').set(authHeader(admin, tenant.id)).send({ name: 'Public one', city: 'Київ', ...CONTACT });
    const site = created.body.data;
    const raw  = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await db.query(
      `INSERT INTO site_public_links (tenant_id, site_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [tenant.id, site.id, hash]);

    const res = await request(app).get('/api/public/site').set('X-Site-Token', raw);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('Public one');
    expect(text).not.toContain(CONTACT.contact_name);
    expect(text).not.toContain(CONTACT.contact_phone);
    expect(text).not.toContain(CONTACT.contact_email);
  });
});
