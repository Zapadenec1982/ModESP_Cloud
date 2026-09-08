'use strict';

// globals: true in vitest.config.js
//
// Sessions (plan epic 2.9): the refresh token lives in an httpOnly cookie on
// /api/auth and pairs with a CSRF token; tokens rotate inside a session
// family; a token seen twice closes the family; the Sessions endpoints list
// and revoke families.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();
const PW = 'SessionTestPassw0rd!';

const cookieOf = (res) => {
  const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith('modesp_rt='));
  return raw ? { raw, value: raw.split(';')[0].slice('modesp_rt='.length) } : null;
};
const login = (email, ua = 'vitest') => request(app).post('/api/auth/login').set('User-Agent', ua).send({ email, password: PW });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('sessions', () => {
  let tenant, other, user, admin, superadmin;

  beforeAll(async () => {
    await cleanDatabase();
    tenant = await createTenant({ slug: 'sess-a' });
    other  = await createTenant({ slug: 'sess-b' });
    user   = await createUser(tenant.id, { role: 'viewer', email: 'viewer@sess.test', password: PW });
    admin  = await createUser(tenant.id, { role: 'admin', email: 'admin@sess.test', password: PW });
    superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@sess.test', password: PW });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('login sets the httpOnly refresh cookie, returns a CSRF token and a session id in the JWT', async () => {
    const res = await login(user.email);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toBeTruthy();
    expect(cookie.raw).toMatch(/Path=\/api\/auth/);
    expect(cookie.raw).toMatch(/HttpOnly/);
    expect(cookie.raw).toMatch(/SameSite=Strict/);
    expect(cookie.raw).not.toMatch(/Secure/);           // NODE_ENV=test: plain http
    expect(cookie.value).toBe(res.body.data.refresh_token);
    expect(res.body.data.csrf_token).toMatch(/^[0-9a-f]{64}$/);
    const payload = jwt.decode(res.body.data.access_token);
    expect(payload.sid).toMatch(/^[0-9a-f-]{36}$/);
    const { rows } = await db.query('SELECT family_id, user_agent, ip, last_used_at FROM refresh_tokens WHERE user_id = $1', [user.id]);
    expect(rows[0].family_id).toBe(payload.sid);
    expect(rows[0].user_agent).toBe('vitest');
    expect(rows[0].ip).toBeTruthy();
    expect(rows[0].last_used_at).toBeTruthy();
  });

  it('a cookie-driven refresh needs the matching CSRF header; the body path does not', async () => {
    const l = await login(user.email);
    const cookie = cookieOf(l).value;
    const csrf = l.body.data.csrf_token;

    const noHeader = await request(app).post('/api/auth/refresh').set('Cookie', `modesp_rt=${cookie}`).send({});
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe('csrf_required');
    const wrong = await request(app).post('/api/auth/refresh').set('Cookie', `modesp_rt=${cookie}`).set('X-CSRF-Token', 'f'.repeat(64)).send({});
    expect(wrong.status).toBe(403);

    const ok = await request(app).post('/api/auth/refresh').set('Cookie', `modesp_rt=${cookie}`).set('X-CSRF-Token', csrf).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.access_token).toBeTruthy();
    expect(cookieOf(ok).value).toBe(ok.body.data.refresh_token);
    expect(ok.body.data.csrf_token).not.toBe(csrf);
    // Same session: the JWT keeps its sid
    expect(jwt.decode(ok.body.data.access_token).sid).toBe(jwt.decode(l.body.data.access_token).sid);

    // No cookie, no body → 400; body token alone (an API client) → fine without any header
    const none = await request(app).post('/api/auth/refresh').send({});
    expect(none.status).toBe(400);
    const body = await request(app).post('/api/auth/refresh').send({ refresh_token: ok.body.data.refresh_token });
    expect(body.status).toBe(200);
  });

  it('a refresh token is single-use — presenting it again closes the whole session', async () => {
    const l = await login(user.email);
    const t1 = l.body.data.refresh_token;
    const r = await request(app).post('/api/auth/refresh').send({ refresh_token: t1 });
    expect(r.status).toBe(200);
    const t2 = r.body.data.refresh_token;

    const reuse = await request(app).post('/api/auth/refresh').send({ refresh_token: t1 });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('token_reused');
    expect(cookieOf(reuse).raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    // The legitimate holder of the chain is signed out too
    const after = await request(app).post('/api/auth/refresh').send({ refresh_token: t2 });
    expect(after.status).toBe(401);
  });

  it('lists one session per device with the current one flagged', async () => {
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const phone  = await login(user.email, 'Phone/1.0');
    const laptop = await login(user.email, 'Laptop/2.0');
    // Rotate the laptop session once: still one row
    await request(app).post('/api/auth/refresh').send({ refresh_token: laptop.body.data.refresh_token });

    const res = await request(app).get('/api/auth/sessions').set(bearer(phone.body.data.access_token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const current = res.body.data.find(s => s.current);
    expect(current.id).toBe(jwt.decode(phone.body.data.access_token).sid);
    expect(current.user_agent).toBe('Phone/1.0');
    expect(current.tenant_name).toBe(tenant.name);
    expect(current.ip).toMatch(/^[0-9a-f.:]+$/);           // host only, no /32 mask
    const otherRow = res.body.data.find(s => !s.current);
    expect(otherRow.user_agent).toBe('Laptop/2.0');
    expect(otherRow.last_used_at).toBeTruthy();
  });

  it('revoking a session ends it; revoking the current one also clears the cookie', async () => {
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const a = await login(user.email, 'A');
    const b = await login(user.email, 'B');
    const sidB = jwt.decode(b.body.data.access_token).sid;

    const bad = await request(app).delete('/api/auth/sessions/not-a-uuid').set(bearer(a.body.data.access_token));
    expect(bad.status).toBe(400);
    const notMine = await request(app).delete(`/api/auth/sessions/${sidB}`).set(authHeader(admin, tenant.id));
    expect(notMine.status).toBe(404);

    const res = await request(app).delete(`/api/auth/sessions/${sidB}`).set(bearer(a.body.data.access_token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true, current: false });
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: b.body.data.refresh_token })).status).toBe(401);
    expect((await request(app).get('/api/auth/sessions').set(bearer(a.body.data.access_token))).body.data).toHaveLength(1);

    const sidA = jwt.decode(a.body.data.access_token).sid;
    const self = await request(app).delete(`/api/auth/sessions/${sidA}`).set(bearer(a.body.data.access_token));
    expect(self.status).toBe(200);
    expect(self.body.data.current).toBe(true);
    expect(cookieOf(self).raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: a.body.data.refresh_token })).status).toBe(401);
  });

  it('"sign out everywhere" keeps only the calling session', async () => {
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const keep = await login(user.email, 'keep');
    const x = await login(user.email, 'x');
    const y = await login(user.email, 'y');
    const res = await request(app).delete('/api/auth/sessions').set(bearer(keep.body.data.access_token));
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(2);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: x.body.data.refresh_token })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: y.body.data.refresh_token })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: keep.body.data.refresh_token })).status).toBe(200);
  });

  it('logout through the cookie ends the session and clears the cookie', async () => {
    const l = await login(user.email);
    const cookie = cookieOf(l).value;
    const csrf = l.body.data.csrf_token;
    const noCsrf = await request(app).post('/api/auth/logout').set('Cookie', `modesp_rt=${cookie}`).send({});
    expect(noCsrf.status).toBe(403);
    const res = await request(app).post('/api/auth/logout').set('Cookie', `modesp_rt=${cookie}`).set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(200);
    expect(cookieOf(res).raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: cookie })).status).toBe(401);
  });

  it('switching organisation stays inside the same session', async () => {
    await db.query('INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [user.id, other.id, 'technician']);
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const l = await login(user.email);
    expect(l.body.data.require_tenant_select).toBe(true);
    const sel = await request(app).post('/api/auth/select-tenant').send({ pending_token: l.body.data.pending_token, tenant_id: tenant.id });
    expect(sel.status).toBe(200);
    const sid = jwt.decode(sel.body.data.access_token).sid;
    expect(cookieOf(sel).value).toBe(sel.body.data.refresh_token);

    const sw = await request(app).post('/api/auth/switch-tenant').set(bearer(sel.body.data.access_token)).send({ tenant_id: other.id });
    expect(sw.status).toBe(200);
    expect(jwt.decode(sw.body.data.access_token).sid).toBe(sid);
    expect(sw.body.data.csrf_token).toBeTruthy();
    const list = await request(app).get('/api/auth/sessions').set(bearer(sw.body.data.access_token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ current: true, tenant_name: other.name });

    // Session restore in the other organisation: refresh, then the profile
    // (scoped to the token's organisation) must still find the caller there.
    const rf = await request(app).post('/api/auth/refresh').send({ refresh_token: sw.body.data.refresh_token });
    expect(rf.status).toBe(200);
    expect(rf.body.data.role).toBe('technician');
    const me = await request(app).get('/api/profile').set(bearer(rf.body.data.access_token));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(user.email);
    await db.query('DELETE FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [user.id, other.id]);
  });

  it('an administrator signs a user of the organisation out everywhere', async () => {
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const l = await login(user.email);
    const forbidden = await request(app).delete(`/api/users/${user.id}/sessions`).set(authHeader(user, tenant.id));
    expect(forbidden.status).toBe(403);
    // an admin of another organisation does not see this user
    const elsewhere = await createUser(other.id, { role: 'admin', email: 'admin@sess-b.test' });
    expect((await request(app).delete(`/api/users/${user.id}/sessions`).set(authHeader(elsewhere, other.id))).status).toBe(404);
    // an admin cannot touch a superadmin
    expect((await request(app).delete(`/api/users/${superadmin.id}/sessions`).set(authHeader(admin, tenant.id))).status).toBe(404);

    const res = await request(app).delete(`/api/users/${user.id}/sessions`).set(authHeader(admin, tenant.id));
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(1);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: l.body.data.refresh_token })).status).toBe(401);
  });
});
