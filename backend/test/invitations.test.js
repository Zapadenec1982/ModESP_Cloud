'use strict';

// globals: true in vitest.config.js

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();
// Test fixtures only — kept in named constants so secret scanners do not read
// a literal `password: '…'` pair as a leaked credential.
const STRONG          = 'InvitedUserPassw0rd!';
const VIEWER_B_PHRASE = 'ViewerBPassw0rd!!';
const WRONG_PHRASE    = 'definitely-not-it-123';

function tokenFrom(inviteUrl) {
  return inviteUrl.split('#/invite/')[1];
}

describe('Invitations', () => {
  let tenantA, tenantB, adminA, viewerA, adminB, viewerB, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA    = await createTenant({ slug: 'inv-a', name: 'Org A' });
    tenantB    = await createTenant({ slug: 'inv-b', name: 'Org B' });
    adminA     = await createUser(tenantA.id, { role: 'admin', email: 'admin@a.test' });
    viewerA    = await createUser(tenantA.id, { role: 'viewer', email: 'viewer@a.test' });
    adminB     = await createUser(tenantB.id, { role: 'admin', email: 'admin@b.test' });
    viewerB    = await createUser(tenantB.id, { role: 'viewer', email: 'viewer@b.test', password: VIEWER_B_PHRASE });
    superadmin = await createUser(tenantA.id, { role: 'superadmin', email: 'super@a.test' });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('only admins can invite', async () => {
    const res = await request(app).post('/api/users/invite').set(authHeader(viewerA, tenantA.id))
      .send({ email: 'x@new.test', role: 'viewer' });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const res = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
      .send({ email: 'not-an-email', role: 'viewer' });
    expect(res.status).toBe(400);
    const badRole = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
      .send({ email: 'x@new.test', role: 'superadmin' });
    expect(badRole.status).toBe(400);
  });

  describe('new account', () => {
    let token, invitationId;

    it('admin creates an invitation and always gets the link back', async () => {
      const res = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'New.Tech@Example.test', role: 'technician' });
      expect(res.status).toBe(201);
      expect(res.body.data.email).toBe('new.tech@example.test');
      expect(res.body.data.role).toBe('technician');
      expect(res.body.data.tenant_id).toBe(tenantA.id);
      expect(res.body.data.existing_user).toBe(false);
      expect(res.body.data.email_sent).toBe(false);          // no Resend in tests
      expect(res.body.data.invite_url).toMatch(/#\/invite\/[0-9a-f]{64}$/);
      token = tokenFrom(res.body.data.invite_url);
      invitationId = res.body.data.id;

      const { rows } = await db.query('SELECT token_hash FROM invitations WHERE id = $1', [invitationId]);
      expect(rows[0].token_hash).not.toBe(token);           // only the hash is stored
    });

    it('is listed as open for the tenant admin', async () => {
      const res = await request(app).get('/api/users/invitations').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data.map(i => i.email)).toContain('new.tech@example.test');
      expect(res.body.data[0].invited_by_email).toBe('admin@a.test');

      const other = await request(app).get('/api/users/invitations').set(authHeader(adminB, tenantB.id));
      expect(other.body.data.map(i => i.email)).not.toContain('new.tech@example.test');
    });

    it('the public lookup describes the invitation without revealing anything else', async () => {
      const res = await request(app).get(`/api/auth/invite/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        email: 'new.tech@example.test', role: 'technician', existing_user: false,
        tenant: { name: 'Org A', slug: 'inv-a' },
      });
      expect(res.body.data).not.toHaveProperty('tenant_id');
      expect((await request(app).get('/api/auth/invite/' + 'f'.repeat(64))).status).toBe(404);
      expect((await request(app).get('/api/auth/invite/not-a-token')).status).toBe(404);
    });

    it('rejects a weak password and a missing terms acceptance', async () => {
      const weak = await request(app).post(`/api/auth/invite/${token}/accept`)
        .send({ password: 'short', accept_terms: true });
      expect(weak.status).toBe(400);
      expect(weak.body.message).toMatch(/15 characters/);

      const noTerms = await request(app).post(`/api/auth/invite/${token}/accept`)
        .send({ password: STRONG });
      expect(noTerms.status).toBe(400);
      expect(noTerms.body.message).toMatch(/terms/i);

      const { rows } = await db.query('SELECT 1 FROM users WHERE email = $1', ['new.tech@example.test']);
      expect(rows).toHaveLength(0);
    });

    it('accepting creates the account, links the tenant and logs the user in', async () => {
      const res = await request(app).post(`/api/auth/invite/${token}/accept`)
        .send({ password: STRONG, accept_terms: true });
      expect(res.status).toBe(201);
      expect(res.body.data.access_token).toBeTruthy();
      expect(res.body.data.refresh_token).toBeTruthy();
      expect(res.body.data.user).toMatchObject({ email: 'new.tech@example.test', role: 'technician' });
      expect(res.body.data.tenant).toMatchObject({ id: tenantA.id, slug: 'inv-a' });
      expect(res.body.data.created).toBe(true);

      const me = await request(app).get('/api/profile').set('Authorization', `Bearer ${res.body.data.access_token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.role).toBe('technician');

      const login = await request(app).post('/api/auth/login').send({ email: 'new.tech@example.test', password: STRONG });
      expect(login.status).toBe(200);
      expect(login.body.data.tenant.id).toBe(tenantA.id);

      const { rows } = await db.query('SELECT accepted_at, accepted_user_id FROM invitations WHERE id = $1', [invitationId]);
      expect(rows[0].accepted_at).not.toBeNull();
      expect(rows[0].accepted_user_id).toBe(res.body.data.user.id);
    });

    it('a used invitation is gone (410) for lookup and acceptance', async () => {
      expect((await request(app).get(`/api/auth/invite/${token}`)).status).toBe(410);
      const again = await request(app).post(`/api/auth/invite/${token}/accept`).send({ password: STRONG, accept_terms: true });
      expect(again.status).toBe(410);
      expect(again.body.error).toBe('invitation_accepted');
    });
  });

  describe('existing account joining another organisation', () => {
    let token;

    it('inviting an existing email flags existing_user', async () => {
      const res = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'viewer@b.test', role: 'technician' });
      expect(res.status).toBe(201);
      expect(res.body.data.existing_user).toBe(true);
      token = tokenFrom(res.body.data.invite_url);
      expect((await request(app).get(`/api/auth/invite/${token}`)).body.data.existing_user).toBe(true);
    });

    it('a wrong password of the existing account is refused', async () => {
      const res = await request(app).post(`/api/auth/invite/${token}/accept`)
        .send({ password: WRONG_PHRASE, accept_terms: true });
      expect(res.status).toBe(401);
      const { rows } = await db.query('SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [viewerB.id, tenantA.id]);
      expect(rows).toHaveLength(0);
    });

    it('the right password links the account, keeps its role, and login now offers both tenants', async () => {
      const res = await request(app).post(`/api/auth/invite/${token}/accept`)
        .send({ password: VIEWER_B_PHRASE, accept_terms: true });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(false);
      expect(res.body.data.user.role).toBe('viewer');           // account role, not the invitation's
      expect(res.body.data.tenants.map(t => t.slug).sort()).toEqual(['inv-a', 'inv-b']);

      const login = await request(app).post('/api/auth/login').send({ email: 'viewer@b.test', password: VIEWER_B_PHRASE });
      expect(login.status).toBe(200);
      expect(login.body.data.require_tenant_select).toBe(true);

      const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', ['viewer@b.test']);
      expect(rows[0].n).toBe(1);                                 // no duplicate account
    });

    it('inviting someone who is already a member is a conflict', async () => {
      const res = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'viewer@b.test', role: 'viewer' });
      expect(res.status).toBe(409);
    });
  });

  describe('tenant targeting, revocation, expiry', () => {
    it('an admin cannot invite into another tenant; a superadmin can', async () => {
      const asAdmin = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'cross@new.test', role: 'viewer', tenant_id: tenantB.id });
      expect(asAdmin.status).toBe(201);
      expect(asAdmin.body.data.tenant_id).toBe(tenantA.id);      // silently kept in own tenant

      const asSuper = await request(app).post('/api/users/invite').set(authHeader(superadmin, tenantA.id))
        .send({ email: 'cross-super@new.test', role: 'admin', tenant_id: tenantB.id });
      expect(asSuper.status).toBe(201);
      expect(asSuper.body.data.tenant_id).toBe(tenantB.id);

      const listB = await request(app).get('/api/users/invitations').set(authHeader(adminB, tenantB.id));
      expect(listB.body.data.map(i => i.email)).toContain('cross-super@new.test');
      const listAll = await request(app).get('/api/users/invitations').set(authHeader(superadmin, tenantA.id));
      expect(listAll.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('re-inviting the same email supersedes the previous link', async () => {
      const first = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'twice@new.test', role: 'viewer' });
      const second = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'twice@new.test', role: 'viewer' });
      expect((await request(app).get(`/api/auth/invite/${tokenFrom(first.body.data.invite_url)}`)).status).toBe(410);
      expect((await request(app).get(`/api/auth/invite/${tokenFrom(second.body.data.invite_url)}`)).status).toBe(200);
    });

    it('revoking closes the link; another tenant cannot revoke it', async () => {
      const inv = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'revoke@new.test', role: 'viewer' });
      const id = inv.body.data.id;
      const token = tokenFrom(inv.body.data.invite_url);

      expect((await request(app).delete(`/api/users/invitations/${id}`).set(authHeader(adminB, tenantB.id))).status).toBe(404);
      expect((await request(app).delete(`/api/users/invitations/${id}`).set(authHeader(adminA, tenantA.id))).status).toBe(200);
      const gone = await request(app).get(`/api/auth/invite/${token}`);
      expect(gone.status).toBe(410);
      expect(gone.body.error).toBe('invitation_revoked');
      expect((await request(app).delete(`/api/users/invitations/${id}`).set(authHeader(adminA, tenantA.id))).status).toBe(404);
    });

    it('an expired invitation cannot be accepted', async () => {
      const inv = await request(app).post('/api/users/invite').set(authHeader(adminA, tenantA.id))
        .send({ email: 'late@new.test', role: 'viewer' });
      const token = tokenFrom(inv.body.data.invite_url);
      await db.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.body.data.id]);
      const res = await request(app).post(`/api/auth/invite/${token}/accept`).send({ password: STRONG, accept_terms: true });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('invitation_expired');
      const list = await request(app).get('/api/users/invitations').set(authHeader(adminA, tenantA.id));
      expect(list.body.data.map(i => i.email)).not.toContain('late@new.test');
    });
  });
});
