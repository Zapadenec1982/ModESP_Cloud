'use strict';

// globals: true in vitest.config.js
//
// Second factor (plan epic 2.9): TOTP setup in two steps, backup codes, the
// mfa_token round trip at login, replay protection, disable and the
// superadmin reset.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');
const mfaSvc = require('../src/services/mfa');

const app = createTestApp();
const PW = 'MfaTestPassw0rd!!';
const { authenticator, setEpoch } = mfaSvc.__test;

const login = (email) => request(app).post('/api/auth/login').send({ email, password: PW });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
/** A code for `secret` at the pinned clock (the server checks against the same clock). */
const codeAt = (secret, ms) => { setEpoch(ms); return authenticator.generate(secret); };

describe('MFA', () => {
  let tenant, other, user, admin, superadmin;
  let session;           // the session that sets MFA up
  let secret, backupCodes;
  let clock;             // ms, advanced by a step whenever a fresh TOTP code is needed

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'mfa-a' });
    other  = await createTenant({ slug: 'mfa-b' });
    user   = await createUser(tenant.id, { role: 'admin', email: 'admin@mfa.test', password: PW });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin2@mfa.test', password: PW });
    superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@mfa.test', password: PW });
    clock = Date.now();
    setEpoch(clock);
  });

  afterAll(async () => {
    setEpoch(null);
    await cleanDatabase();
    await shutdownDb();
  });

  it('is off by default', async () => {
    session = (await login(user.email)).body.data;
    expect(session.access_token).toBeTruthy();
    const res = await request(app).get('/api/auth/mfa').set(bearer(session.access_token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false, enabled_at: null, pending: false, backup_codes_left: 0 });
  });

  it('setup hands out the secret and a QR; enabling needs a code from the app', async () => {
    const res = await request(app).post('/api/auth/mfa/setup').set(bearer(session.access_token));
    expect(res.status).toBe(200);
    expect(res.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.data.otpauth_url).toContain('otpauth://totp/ModESP%20Cloud:admin%40mfa.test');
    expect(res.body.data.qr).toMatch(/^data:image\/png;base64,/);
    secret = res.body.data.secret;

    const { rows } = await db.query('SELECT mfa_secret, mfa_pending_secret, mfa_enabled_at FROM users WHERE id = $1', [user.id]);
    expect(rows[0].mfa_pending_secret).toMatch(/^v1:/);          // encrypted, not the secret itself
    expect(rows[0].mfa_pending_secret).not.toContain(secret);
    expect(rows[0].mfa_secret).toBeNull();
    expect((await request(app).get('/api/auth/mfa').set(bearer(session.access_token))).body.data.pending).toBe(true);

    // Login still needs no code while the setup is pending
    const meanwhile = await login(user.email);
    expect(meanwhile.body.data.require_mfa).toBeUndefined();
    await request(app).post('/api/auth/logout').send({ refresh_token: meanwhile.body.data.refresh_token });

    const wrong = await request(app).post('/api/auth/mfa/enable').set(bearer(session.access_token)).send({ code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_mfa_code');
  });

  it('the first valid code enables MFA, returns ten backup codes once and signs the other sessions out', async () => {
    const otherSession = (await login(user.email)).body.data;
    const res = await request(app).post('/api/auth/mfa/enable').set(bearer(session.access_token)).send({ code: codeAt(secret, clock) });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.backup_codes).toHaveLength(10);
    for (const c of res.body.data.backup_codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(res.body.data.sessions_closed).toBe(1);
    backupCodes = res.body.data.backup_codes;

    const status = await request(app).get('/api/auth/mfa').set(bearer(session.access_token));
    expect(status.body.data).toMatchObject({ enabled: true, pending: false, backup_codes_left: 10 });
    const { rows } = await db.query('SELECT mfa_secret, mfa_pending_secret, mfa_backup_codes FROM users WHERE id = $1', [user.id]);
    expect(rows[0].mfa_secret).toMatch(/^v1:/);
    expect(rows[0].mfa_pending_secret).toBeNull();
    expect(rows[0].mfa_backup_codes).not.toContain(backupCodes[0]);   // hashes only

    // The other session was closed; the enabling one lives on
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: otherSession.refresh_token })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: session.refresh_token })).status).toBe(200);
    // Setup cannot be restarted while enabled
    expect((await request(app).post('/api/auth/mfa/setup').set(bearer(session.access_token))).status).toBe(409);
  });

  it('login now stops at the second factor; the mfa_token opens nothing by itself', async () => {
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ require_mfa: true, user: { email: user.email } });
    expect(res.body.data.access_token).toBeUndefined();
    expect(res.body.data.refresh_token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    const asBearer = await request(app).get('/api/profile').set(bearer(res.body.data.mfa_token));
    expect(asBearer.status).toBe(401);
    const garbage = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: 'nope', code: '123456' });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error).toBe('invalid_token');
    // A normal access token is not an mfa_token either
    const swapped = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: session.access_token, code: '123456' });
    expect(swapped.status).toBe(401);
  });

  it('a fresh code completes the login; the same code is refused a second time', async () => {
    const first = (await login(user.email)).body.data;
    const wrong = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: first.mfa_token, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_mfa_code');

    clock += 30_000;                                   // next step: the enable code's step was consumed
    const code = codeAt(secret, clock);
    const ok = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: first.mfa_token, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.access_token).toBeTruthy();
    expect(ok.body.data.user).toMatchObject({ email: user.email, role: 'admin' });
    expect(ok.body.data.tenant.id).toBe(tenant.id);
    expect((ok.headers['set-cookie'] || []).some(c => c.startsWith('modesp_rt='))).toBe(true);

    const second = (await login(user.email)).body.data;
    const replay = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: second.mfa_token, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_mfa_code');

    // The previous step is inside the window but older than the last accepted one
    const stale = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: second.mfa_token, code: codeAt(secret, clock - 30_000) });
    expect(stale.status).toBe(401);
    setEpoch(clock);
  });

  it('a backup code works once', async () => {
    const l = (await login(user.email)).body.data;
    const res = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: l.mfa_token, code: backupCodes[0].toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeTruthy();
    const again = (await login(user.email)).body.data;
    const reuse = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: again.mfa_token, code: backupCodes[0] });
    expect(reuse.status).toBe(401);
    const status = await request(app).get('/api/auth/mfa').set(bearer(res.body.data.access_token));
    expect(status.body.data.backup_codes_left).toBe(9);
    session = res.body.data;
  });

  it('backup codes regenerate against a code; the old ones die', async () => {
    const wrong = await request(app).post('/api/auth/mfa/backup-codes').set(bearer(session.access_token)).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    const res = await request(app).post('/api/auth/mfa/backup-codes').set(bearer(session.access_token)).send({ code: backupCodes[1] });
    expect(res.status).toBe(200);
    expect(res.body.data.backup_codes).toHaveLength(10);
    const old = backupCodes[2];
    backupCodes = res.body.data.backup_codes;
    const l = (await login(user.email)).body.data;
    expect((await request(app).post('/api/auth/mfa/verify').send({ mfa_token: l.mfa_token, code: old })).status).toBe(401);
  });

  it('disabling needs the password and a code', async () => {
    const badPw = await request(app).post('/api/auth/mfa/disable').set(bearer(session.access_token)).send({ password: 'wrong-password-123', code: backupCodes[0] });
    expect(badPw.status).toBe(401);
    expect(badPw.body.error).toBe('invalid_credentials');
    const badCode = await request(app).post('/api/auth/mfa/disable').set(bearer(session.access_token)).send({ password: PW, code: '000000' });
    expect(badCode.status).toBe(401);
    expect(badCode.body.error).toBe('invalid_mfa_code');

    const res = await request(app).post('/api/auth/mfa/disable').set(bearer(session.access_token)).send({ password: PW, code: backupCodes[0] });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect((await login(user.email)).body.data.access_token).toBeTruthy();
    expect((await request(app).post('/api/auth/mfa/disable').set(bearer(session.access_token)).send({ password: PW, code: backupCodes[1] })).status).toBe(409);
  });

  it('only a superadmin resets a locked-out user; an organisation admin cannot', async () => {
    // Enable again
    const s = (await login(user.email)).body.data;
    const setup = await request(app).post('/api/auth/mfa/setup').set(bearer(s.access_token));
    clock += 30_000;
    const en = await request(app).post('/api/auth/mfa/enable').set(bearer(s.access_token)).send({ code: codeAt(setup.body.data.secret, clock) });
    expect(en.status).toBe(200);
    expect((await login(user.email)).body.data.require_mfa).toBe(true);

    const forbidden = await request(app).delete(`/api/users/${user.id}/mfa`).set(authHeader(admin, tenant.id));
    expect(forbidden.status).toBe(403);
    const res = await request(app).delete(`/api/users/${user.id}/mfa`).set(authHeader(superadmin, other.id));
    expect(res.status).toBe(200);
    expect(res.body.data.mfa_enabled).toBe(false);
    expect((await login(user.email)).body.data.access_token).toBeTruthy();
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: s.refresh_token })).status).toBe(401);
  });
});
