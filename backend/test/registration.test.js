'use strict';

// globals: true in vitest.config.js
//
// Self-registration (plan epic 2.1): an organisation and its first
// administrator through POST /auth/register, with e-mail verification when
// there is a channel, superadmin approval when REGISTRATION_MODE=approve, and
// the trial sweep that turns an ended trial into past_due.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const emailSvc  = require('../src/services/email');
const lifecycle = require('../src/services/tenant-lifecycle');

const app = createTestApp();
// Test fixtures only — named constants so secret scanners do not read a
// literal `password: '…'` pair as a leaked credential.
const PASSWORD = 'RegisteredAdminPassw0rd!';

let mails = [];
function stubEmail(configured) {
  // The real functions resolve false without a channel; the stubs do the same.
  const record = (kind) => async (m) => { if (!configured) return false; mails.push({ kind, ...m }); return true; };
  emailSvc.isConfigured = () => configured;
  emailSvc.sendEmailVerification    = record('verify');
  emailSvc.sendRegistrationApproved = record('approved');
  emailSvc.sendTrialEnded           = record('trial');
  emailSvc.sendRegistrationNotice   = record('notice');
}
const codeFrom = (link) => new URL(link).hash.split('code=')[1];

const register = (body) => request(app).post('/api/auth/register').send(body);
const login = (email, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });

describe('self-registration', () => {
  let superTenant, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    superTenant = await createTenant({ slug: 'reg-platform' });
    superadmin  = await createUser(superTenant.id, { role: 'superadmin', email: 'super@reg.test' });
  });

  afterAll(async () => {
    delete process.env.REGISTRATION_MODE;
    delete process.env.REGISTRATION_NOTIFY_EMAIL;
    await cleanDatabase();
    await shutdownDb();
  });

  beforeEach(() => {
    process.env.REGISTRATION_MODE = 'open';
    process.env.REGISTRATION_NOTIFY_EMAIL = 'founder@reg.test';
  });
  beforeAll(() => stubEmail(false));

  it('GET /auth/registration tells the page what to expect', async () => {
    const res = await request(app).get('/api/auth/registration');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mode: 'open', email_verification: false, trial_days: 14 });

    process.env.REGISTRATION_MODE = 'off';
    expect((await request(app).get('/api/auth/registration')).body.data.mode).toBe('off');
    process.env.REGISTRATION_MODE = 'nonsense';
    expect((await request(app).get('/api/auth/registration')).body.data.mode).toBe('approve');   // the safe default
  });

  it('is closed with REGISTRATION_MODE=off', async () => {
    process.env.REGISTRATION_MODE = 'off';
    const res = await register({ organisation: 'Closed Org', email: 'closed@reg.test', password: PASSWORD, accept_terms: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('registration_closed');
  });

  it('validates the body', async () => {
    const base = { organisation: 'Fresh Market', email: 'v@reg.test', password: PASSWORD, accept_terms: true };
    expect((await register({ ...base, password: 'short' })).status).toBe(400);
    expect((await register({ ...base, accept_terms: false })).status).toBe(400);
    expect((await register({ ...base, organisation: 'X' })).status).toBe(400);
    expect((await register({ ...base, email: 'not-an-email' })).status).toBe(400);
  });

  it('a filled honeypot answers 201 and creates nothing', async () => {
    const res = await register({ organisation: 'Bot Org', email: 'bot@reg.test', password: PASSWORD, accept_terms: true, website: 'http://spam' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ received: true });
    const { rows } = await db.query("SELECT 1 FROM tenants WHERE name = 'Bot Org'");
    expect(rows).toHaveLength(0);
  });

  describe('open mode without an e-mail channel', () => {
    let reg;

    it('creates the organisation on a 14-day trial and signs the administrator in', async () => {
      stubEmail(false);
      mails = [];
      const res = await register({ organisation: 'Кафе «Полярний» №2', email: 'Owner@Polar.test', password: PASSWORD, accept_terms: true, lang: 'pl' });
      expect(res.status).toBe(201);
      reg = res.body.data;
      expect(reg.verification_required).toBe(false);
      expect(reg.approval_required).toBe(false);
      expect(reg.email_sent).toBe(false);
      expect(reg.tenant).toMatchObject({ name: 'Кафе «Полярний» №2', slug: 'kafe-poliarnyi-2', status: 'trial' });
      expect(reg.access_token).toBeTruthy();
      expect(reg.refresh_token).toBeTruthy();
      expect(reg.user).toMatchObject({ email: 'owner@polar.test', role: 'admin', locale: 'pl' });
      expect(reg.tenants.map(t => t.slug)).toEqual(['kafe-poliarnyi-2']);

      const days = (new Date(reg.tenant.trial_expires_at) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);

      const { rows: t } = await db.query('SELECT plan, status, active, registered_at, approved_at, registered_ip FROM tenants WHERE id = $1', [reg.tenant.id]);
      expect(t[0]).toMatchObject({ plan: 'free', status: 'trial', active: true });
      expect(t[0].registered_at).toBeTruthy();
      expect(t[0].approved_at).toBeTruthy();
      expect(t[0].registered_ip).toBeTruthy();

      const { rows: u } = await db.query('SELECT role, tenant_id, email_verified_at, terms_accepted_at, locale FROM users WHERE id = $1', [reg.user.id]);
      expect(u[0]).toMatchObject({ role: 'admin', tenant_id: reg.tenant.id, locale: 'pl' });
      expect(u[0].email_verified_at).toBeTruthy();
      expect(u[0].terms_accepted_at).toBeTruthy();
      const { rows: m } = await db.query('SELECT role FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [reg.user.id, reg.tenant.id]);
      expect(m[0].role).toBe('admin');
      const { rows: s } = await db.query('SELECT locale FROM tenant_settings WHERE tenant_id = $1', [reg.tenant.id]);
      expect(s[0].locale).toBe('pl');

      // The founder heard about it
      expect(mails.filter(x => x.kind === 'notice')).toHaveLength(0);   // no channel → nothing sent
    });

    it('the administrator can sign in and is an admin of the organisation', async () => {
      const res = await login('owner@polar.test');
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('admin');
      expect(res.body.data.tenant.slug).toBe('kafe-poliarnyi-2');
      expect(res.body.data.tenant.trial_expires_at).toBeTruthy();

      const me = await request(app).get('/api/tenants').set('Authorization', `Bearer ${res.body.data.access_token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.map(t => t.slug)).toEqual(['kafe-poliarnyi-2']);
    });

    it('the same organisation name gets a distinct slug; a reserved name is skipped', async () => {
      const a = await register({ organisation: 'Fresh Market', email: 'a@fresh.test', password: PASSWORD, accept_terms: true });
      const b = await register({ organisation: 'Fresh Market', email: 'b@fresh.test', password: PASSWORD, accept_terms: true });
      expect(a.body.data.tenant.slug).toBe('fresh-market');
      expect(b.body.data.tenant.slug).toBe('fresh-market-2');
      const c = await register({ organisation: 'Admin', email: 'c@fresh.test', password: PASSWORD, accept_terms: true });
      expect(c.body.data.tenant.slug).toBe('admin-2');
    });

    it('an e-mail that already has an account is refused, whatever its case', async () => {
      const res = await register({ organisation: 'Another', email: 'OWNER@polar.test', password: PASSWORD, accept_terms: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('email_taken');
      const invited = await register({ organisation: 'Another', email: 'super@reg.test', password: PASSWORD, accept_terms: true });
      expect(invited.status).toBe(409);
    });
  });

  describe('with an e-mail channel: the address is verified before the first login', () => {
    let link, user;

    it('registers without signing in and sends the link', async () => {
      stubEmail(true);
      mails = [];
      const res = await register({ organisation: 'Verified Org', email: 'admin@verified.test', password: PASSWORD, accept_terms: true, lang: 'en' });
      expect(res.status).toBe(201);
      expect(res.body.data.verification_required).toBe(true);
      expect(res.body.data.email_sent).toBe(true);
      expect(res.body.data.access_token).toBeUndefined();
      user = res.body.data;

      const verify = mails.find(m => m.kind === 'verify');
      expect(verify.to).toBe('admin@verified.test');
      expect(verify.lang).toBe('en');
      expect(verify.tenantName).toBe('Verified Org');
      expect(verify.link).toMatch(/#\/verify\?email=admin%40verified\.test&code=[0-9a-f]{64}$/);
      link = verify.link;

      const notice = mails.find(m => m.kind === 'notice');
      expect(notice.to).toBe('founder@reg.test');
      expect(notice.tenant.slug).toBe('verified-org');
      expect(notice.mode).toBe('open');

      const { rows } = await db.query('SELECT email_verified_at, email_verify_hash FROM users WHERE email = $1', ['admin@verified.test']);
      expect(rows[0].email_verified_at).toBeNull();
      expect(rows[0].email_verify_hash).not.toBe(codeFrom(link));   // only the hash is stored
    });

    it('login is refused until then', async () => {
      const res = await login('admin@verified.test');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('email_not_verified');
    });

    it('a wrong or expired code is refused', async () => {
      const wrong = await request(app).post('/api/auth/verify-email').send({ email: 'admin@verified.test', code: 'f'.repeat(64) });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_code');
      const bad = await request(app).post('/api/auth/verify-email').send({ email: 'admin@verified.test', code: 'xyz' });
      expect(bad.status).toBe(400);

      await db.query("UPDATE users SET email_verify_expires = now() - interval '1 minute' WHERE email = $1", ['admin@verified.test']);
      const expired = await request(app).post('/api/auth/verify-email').send({ email: 'admin@verified.test', code: codeFrom(link) });
      expect(expired.status).toBe(400);
      expect(expired.body.error).toBe('code_expired');
    });

    it('resend issues a fresh link (and says the same for any address)', async () => {
      mails = [];
      const res = await request(app).post('/api/auth/resend-verification').send({ email: 'admin@verified.test', lang: 'de' });
      expect(res.status).toBe(200);
      const verify = mails.find(m => m.kind === 'verify');
      expect(verify.lang).toBe('de');
      expect(codeFrom(verify.link)).not.toBe(codeFrom(link));
      link = verify.link;

      mails = [];
      const nobody = await request(app).post('/api/auth/resend-verification').send({ email: 'nobody@verified.test' });
      expect(nobody.status).toBe(200);
      expect(nobody.body).toEqual(res.body);
      expect(mails).toHaveLength(0);
    });

    it('the link verifies the address and signs the administrator in', async () => {
      const res = await request(app).post('/api/auth/verify-email').send({ email: 'admin@verified.test', code: codeFrom(link) });
      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);
      expect(res.body.data.approval_required).toBe(false);
      expect(res.body.data.access_token).toBeTruthy();
      expect(res.body.data.tenant.slug).toBe('verified-org');

      expect((await login('admin@verified.test')).status).toBe(200);

      // The same link a second time: verified already, nothing to do
      const again = await request(app).post('/api/auth/verify-email').send({ email: 'admin@verified.test', code: codeFrom(link) });
      expect(again.status).toBe(200);
      expect(again.body.data.verified).toBe(true);

      // A verified address never gets another link
      mails = [];
      await request(app).post('/api/auth/resend-verification').send({ email: 'admin@verified.test' });
      expect(mails).toHaveLength(0);
    });
  });

  describe('REGISTRATION_MODE=approve', () => {
    let pending;

    it('keeps the organisation suspended until a superadmin approves it', async () => {
      process.env.REGISTRATION_MODE = 'approve';
      stubEmail(true);
      mails = [];
      const res = await register({ organisation: 'Awaiting Org', email: 'admin@awaiting.test', password: PASSWORD, accept_terms: true, lang: 'uk' });
      expect(res.status).toBe(201);
      pending = res.body.data;
      expect(pending.approval_required).toBe(true);
      expect(pending.verification_required).toBe(true);
      expect(pending.tenant.status).toBe('suspended');
      expect(pending.access_token).toBeUndefined();
      expect(mails.find(m => m.kind === 'notice').mode).toBe('approve');

      const { rows } = await db.query('SELECT status, active, registered_at, approved_at, trial_expires_at FROM tenants WHERE id = $1', [pending.tenant.id]);
      expect(rows[0]).toMatchObject({ status: 'suspended', active: false, approved_at: null, trial_expires_at: null });
      expect(rows[0].registered_at).toBeTruthy();
    });

    it('verifying the address does not open the organisation, and login says why', async () => {
      const link = mails.find(m => m.kind === 'verify').link;
      const res = await request(app).post('/api/auth/verify-email').send({ email: 'admin@awaiting.test', code: codeFrom(link) });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ verified: true, approval_required: true });

      const l = await login('admin@awaiting.test');
      expect(l.status).toBe(401);
      expect(l.body.error).toBe('pending_approval');
    });

    it('the superadmin sees it flagged and only a superadmin can approve', async () => {
      const list = await request(app).get('/api/tenants').set(authHeader(superadmin, superTenant.id));
      const row = list.body.data.find(t => t.id === pending.tenant.id);
      expect(row.awaiting_approval).toBe(true);
      expect(row.registered_at).toBeTruthy();
      expect(list.body.data.find(t => t.slug === 'fresh-market').awaiting_approval).toBe(false);

      const admin = await createUser(superTenant.id, { role: 'admin', email: 'admin@reg-platform.test' });
      const forbidden = await request(app).post(`/api/tenants/${pending.tenant.id}/approve`).set(authHeader(admin, superTenant.id));
      expect(forbidden.status).toBe(403);
    });

    it('approval starts the trial, e-mails the administrator and opens login', async () => {
      mails = [];
      const res = await request(app).post(`/api/tenants/${pending.tenant.id}/approve`).set(authHeader(superadmin, superTenant.id));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'trial', active: true, awaiting_approval: false });
      const days = (new Date(res.body.data.trial_expires_at) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      const { rows } = await db.query('SELECT approved_by FROM tenants WHERE id = $1', [pending.tenant.id]);
      expect(rows[0].approved_by).toBe(superadmin.id);

      const approved = mails.find(m => m.kind === 'approved');
      expect(approved).toMatchObject({ to: 'admin@awaiting.test', lang: 'uk', tenantName: 'Awaiting Org', trialDays: 14 });

      expect((await login('admin@awaiting.test')).status).toBe(200);

      const twice = await request(app).post(`/api/tenants/${pending.tenant.id}/approve`).set(authHeader(superadmin, superTenant.id));
      expect(twice.status).toBe(409);
      const notRegistered = await request(app).post(`/api/tenants/${superTenant.id}/approve`).set(authHeader(superadmin, superTenant.id));
      expect(notRegistered.status).toBe(409);
    });

    it('rejection removes the organisation and its administrator', async () => {
      process.env.REGISTRATION_MODE = 'approve';
      stubEmail(false);
      const res = await register({ organisation: 'Spam Org', email: 'admin@spam.test', password: PASSWORD, accept_terms: true });
      expect(res.status).toBe(201);
      const id = res.body.data.tenant.id;

      const rejected = await request(app).post(`/api/tenants/${id}/reject`).set(authHeader(superadmin, superTenant.id));
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.rejected).toBe(true);
      expect((await db.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rows).toHaveLength(0);
      expect((await db.query('SELECT 1 FROM users WHERE email = $1', ['admin@spam.test'])).rows).toHaveLength(0);
      expect((await login('admin@spam.test')).body.error).toBe('invalid_credentials');

      const again = await request(app).post(`/api/tenants/${id}/reject`).set(authHeader(superadmin, superTenant.id));
      expect(again.status).toBe(409);
    });
  });

  describe('trial sweep', () => {
    it('an ended trial becomes past_due, the administrators hear about it, login still works', async () => {
      stubEmail(true);
      mails = [];
      const { rows: before } = await db.query("SELECT id FROM tenants WHERE slug = 'kafe-poliarnyi-2'");
      const id = before[0].id;
      await db.query("UPDATE tenants SET trial_expires_at = now() - interval '1 hour' WHERE id = $1", [id]);
      // A trial still running and a superadmin-created trial without a date stay as they are
      const open  = await createTenant({ slug: 'trial-open' });
      const noEnd = await createTenant({ slug: 'trial-noend' });
      await db.query("UPDATE tenants SET status = 'trial', trial_expires_at = now() + interval '3 days' WHERE id = $1", [open.id]);
      await db.query("UPDATE tenants SET status = 'trial', trial_expires_at = NULL WHERE id = $1", [noEnd.id]);

      const moved = await lifecycle.expireTrials();
      expect(moved.map(t => t.slug)).toEqual(['kafe-poliarnyi-2']);

      const { rows } = await db.query('SELECT status, active FROM tenants WHERE id = $1', [id]);
      expect(rows[0]).toEqual({ status: 'past_due', active: true });
      expect((await db.query('SELECT status FROM tenants WHERE id = $1', [open.id])).rows[0].status).toBe('trial');
      expect((await db.query('SELECT status FROM tenants WHERE id = $1', [noEnd.id])).rows[0].status).toBe('trial');

      const mail = mails.find(m => m.kind === 'trial');
      expect(mail).toMatchObject({ to: 'owner@polar.test', lang: 'pl', tenantName: 'Кафе «Полярний» №2' });
      expect(mail.link).toMatch(/#\/billing$/);

      const l = await login('owner@polar.test');
      expect(l.status).toBe(200);
      expect(l.body.data.tenant.status).toBe('past_due');

      // Idempotent: nothing left to move
      expect(await lifecycle.expireTrials()).toEqual([]);
    });
  });
});
