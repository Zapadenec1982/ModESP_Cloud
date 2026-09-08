'use strict';

// globals: true in vitest.config.js
//
// Support tools (plan epic 2.13): a superadmin signs in as a user (audited,
// bounded, without secrets), an organisation's admin reads and exports their
// own audit log, the superadmin's tenant card, and the Support form.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const emailSvc = require('../src/services/email');

const app = createTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const settle = () => new Promise(r => setTimeout(r, 150));   // the audit insert is fire-and-forget

function fakeMailer() {
  const sent = [];
  return { sent, client: { emails: { send: async (msg) => { sent.push(msg); return { data: { id: 'x' } }; } } } };
}

describe('support tools', () => {
  let tenantA, tenantB, closedTenant, superadmin, adminA, techA, adminB, viewerClosed;

  beforeAll(async () => {
    await cleanDatabase();
    tenantA = await createTenant({ slug: 'support-a', name: 'Морозко' });
    tenantB = await createTenant({ slug: 'support-b', name: 'Інша' });
    closedTenant = await createTenant({ slug: 'support-closed' });
    await db.query(`UPDATE tenants SET status = 'closed', closed_at = now() WHERE id = $1`, [closedTenant.id]);
    superadmin = await createUser(tenantB.id, { role: 'superadmin', email: 'super@support.test' });
    adminA = await createUser(tenantA.id, { role: 'admin', email: 'admin@support.test' });
    techA  = await createUser(tenantA.id, { role: 'technician', email: 'tech@support.test' });
    adminB = await createUser(tenantB.id, { role: 'admin', email: 'admin-b@support.test' });
    viewerClosed = await createUser(closedTenant.id, { role: 'viewer', email: 'viewer@closed.test' });
    await createDevice(tenantA.id, { mqttId: 'AA0000000001' });
  });

  afterAll(async () => {
    emailSvc.__test.setClient(null);
    await cleanDatabase();
    await shutdownDb();
  });

  // ── Impersonation ─────────────────────────────────────

  describe('sign in as user', () => {
    let impToken;

    it('a superadmin gets a bounded token for the user with the role held in the organisation; the organisation logs it', async () => {
      const res = await request(app).post(`/api/users/${techA.id}/impersonate`)
        .set(authHeader(superadmin, tenantB.id)).send({ reason: 'Ticket #12: technician cannot see the map' });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d.user).toMatchObject({ id: techA.id, email: techA.email, role: 'technician' });
      expect(d.tenant).toMatchObject({ id: tenantA.id, name: 'Морозко' });
      expect(d.impersonator).toEqual({ id: superadmin.id, email: superadmin.email });
      expect(d.refresh_token).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();

      const claims = jwt.decode(d.access_token);
      expect(claims).toMatchObject({ sub: techA.id, role: 'technician', tenantId: tenantA.id, imp: { id: superadmin.id, email: superadmin.email } });
      expect(claims.sid).toBeUndefined();
      const ttl = claims.exp - claims.iat;
      expect(ttl).toBe(60 * 60);
      expect(Math.abs(new Date(d.expires_at).getTime() - claims.exp * 1000)).toBeLessThan(2000);

      // The token works as the user
      const me = await request(app).get('/api/profile').set(bearer(d.access_token));
      expect(me.status).toBe(200);
      expect(me.body.data.email).toBe(techA.email);
      const devices = await request(app).get('/api/devices').set(bearer(d.access_token));
      expect(devices.status).toBe(200);

      await settle();
      const { rows } = await db.query(`SELECT * FROM audit_log WHERE action = 'user.impersonate' ORDER BY id DESC LIMIT 1`);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantA.id);            // filed in the TARGET organisation
      expect(rows[0].user_email).toBe(superadmin.email);
      expect(rows[0].entity_id).toBe(techA.id);
      expect(rows[0].changes).toMatchObject({ email: techA.email, role: 'technician', tenant_id: tenantA.id, reason: 'Ticket #12: technician cannot see the map' });
      expect(rows[0].status_code).toBe(201);
    });

    it('every action taken as the user names the support engineer in the audit log', async () => {
      const res = await request(app).post(`/api/users/${adminA.id}/impersonate`)
        .set(authHeader(superadmin, tenantB.id)).send({ reason: 'Time zone fix' });
      expect(res.status).toBe(201);
      impToken = res.body.data.access_token;
      expect(res.body.data.user.role).toBe('admin');

      const patch = await request(app).patch(`/api/tenants/${tenantA.id}/settings`).set(bearer(impToken)).send({ timezone: 'Europe/Warsaw' });
      expect(patch.status).toBe(200);

      await settle();
      const { rows } = await db.query(
        `SELECT user_email, user_role, impersonator_id, impersonator_email, tenant_id FROM audit_log
          WHERE endpoint = $1 AND method = 'PATCH' ORDER BY id DESC LIMIT 1`, [`/api/tenants/${tenantA.id}/settings`]);
      expect(rows[0]).toEqual({
        user_email: adminA.email, user_role: 'admin', impersonator_id: superadmin.id, impersonator_email: superadmin.email, tenant_id: tenantA.id,
      });
    });

    it('sees and fixes, but never obtains secrets, changes the account security or takes data out', async () => {
      const denied = [
        ['post',   '/api/api-keys', { name: 'x', role: 'viewer' }],
        ['post',   '/api/webhooks', { name: 'x', url: 'https://example.com', events: ['alarm.raised'] }],
        ['post',   '/api/auth/switch-tenant', { tenant_id: tenantB.id }],
        ['put',    '/api/profile/password', { current_password: 'a', new_password: 'b' }],
        ['post',   '/api/auth/mfa/setup', {}],
        ['delete', '/api/auth/sessions', {}],
        ['post',   `/api/users/${techA.id}/impersonate`, { reason: 'nested' }],
        ['post',   `/api/users/${techA.id}/password-reset`, {}],
        ['delete', `/api/users/${techA.id}/sessions`, {}],
        ['post',   `/api/tenants/${tenantA.id}/export`, {}],
        ['get',    `/api/tenants/${tenantA.id}/exports`, null],
      ];
      for (const [method, path, body] of denied) {
        const r = body === null ? await request(app)[method](path).set(bearer(impToken)) : await request(app)[method](path).set(bearer(impToken)).send(body);
        expect(r.status, `${method.toUpperCase()} ${path}`).toBe(403);
        expect(r.body.error, `${method.toUpperCase()} ${path}`).toBe('impersonation_scope');
      }
      // Reads of the same surfaces stay open
      for (const path of ['/api/api-keys', '/api/webhooks', '/api/auth/sessions', '/api/auth/mfa', '/api/users']) {
        const r = await request(app).get(path).set(bearer(impToken));
        expect(r.status, `GET ${path}`).toBe(200);
      }
    });

    it('is refused to an admin, for a superadmin, a disabled account and an organisation the user is not in', async () => {
      const asAdmin = await request(app).post(`/api/users/${techA.id}/impersonate`).set(authHeader(adminA, tenantA.id)).send({ reason: 'not allowed' });
      expect(asAdmin.status).toBe(403);

      const sa = await request(app).post(`/api/users/${superadmin.id}/impersonate`).set(authHeader(superadmin, tenantB.id)).send({ reason: 'not allowed' });
      expect(sa.status).toBe(400);
      expect(sa.body.error).toBe('cannot_impersonate_superadmin');

      const noReason = await request(app).post(`/api/users/${techA.id}/impersonate`).set(authHeader(superadmin, tenantB.id)).send({});
      expect(noReason.status).toBe(400);

      const elsewhere = await request(app).post(`/api/users/${techA.id}/impersonate`)
        .set(authHeader(superadmin, tenantB.id)).send({ reason: 'wrong organisation', tenant_id: tenantB.id });
      expect(elsewhere.status).toBe(404);
      expect(elsewhere.body.error).toBe('not_a_member');

      await db.query('UPDATE users SET active = false WHERE id = $1', [techA.id]);
      const inactive = await request(app).post(`/api/users/${techA.id}/impersonate`).set(authHeader(superadmin, tenantB.id)).send({ reason: 'guard check' });
      expect(inactive.status).toBe(400);
      expect(inactive.body.error).toBe('user_inactive');
      await db.query('UPDATE users SET active = true WHERE id = $1', [techA.id]);

      const suspendedRes = await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantA.id]);
      expect(suspendedRes.rowCount).toBe(1);
      const suspended = await request(app).post(`/api/users/${techA.id}/impersonate`).set(authHeader(superadmin, tenantB.id)).send({ reason: 'guard check' });
      expect(suspended.status).toBe(409);
      await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantA.id]);
    });
  });

  // ── Audit log of the organisation ─────────────────────

  describe('audit log', () => {
    beforeAll(async () => {
      // A few records in tenant B so the scope is visible
      await request(app).patch(`/api/tenants/${tenantB.id}/settings`).set(authHeader(adminB, tenantB.id)).send({ timezone: 'Europe/Berlin' });
      await settle();
    });

    it('an admin reads their own organisation only; the tenant_id filter is not theirs to set', async () => {
      const res = await request(app).get('/api/audit-log').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.meta.scope).toBe('tenant');
      expect(res.body.meta.total).toBeGreaterThan(0);
      for (const row of res.body.data) expect(row.tenant_id).toBe(tenantA.id);
      const actions = res.body.data.map(r => r.action);
      expect(actions).toContain('user.impersonate');
      expect(actions).toContain('tenant.settings');

      const foreign = await request(app).get(`/api/audit-log?tenant_id=${tenantB.id}`).set(authHeader(adminA, tenantA.id));
      expect(foreign.status).toBe(200);
      for (const row of foreign.body.data) expect(row.tenant_id).toBe(tenantA.id);

      const tech = await request(app).get('/api/audit-log').set(authHeader(techA, tenantA.id));
      expect(tech.status).toBe(403);
    });

    it('a superadmin reads every organisation and may narrow to one', async () => {
      const all = await request(app).get('/api/audit-log?limit=200').set(authHeader(superadmin, tenantB.id));
      expect(all.status).toBe(200);
      expect(all.body.meta.scope).toBe('platform');
      const tenantIds = new Set(all.body.data.map(r => r.tenant_id));
      expect(tenantIds.has(tenantA.id)).toBe(true);
      expect(tenantIds.has(tenantB.id)).toBe(true);

      const one = await request(app).get(`/api/audit-log?tenant_id=${tenantB.id}`).set(authHeader(superadmin, tenantB.id));
      for (const row of one.body.data) expect(row.tenant_id).toBe(tenantB.id);
    });

    it('filters: done by support, by e-mail, by outcome; facets list what the scope has seen', async () => {
      const viaSupport = await request(app).get('/api/audit-log?impersonated=true').set(authHeader(adminA, tenantA.id));
      expect(viaSupport.body.meta.total).toBeGreaterThan(0);
      for (const row of viaSupport.body.data) {
        expect(row.impersonator_email).toBeTruthy();
        expect(row.user_email).toBe(adminA.email);
      }
      const notSupport = await request(app).get('/api/audit-log?impersonated=false').set(authHeader(adminA, tenantA.id));
      for (const row of notSupport.body.data) expect(row.impersonator_email).toBeNull();

      const byEmail = await request(app).get('/api/audit-log?user_email=SUPER@').set(authHeader(adminA, tenantA.id));
      expect(byEmail.body.meta.total).toBeGreaterThan(0);
      for (const row of byEmail.body.data) expect(row.user_email).toBe(superadmin.email);

      const errors = await request(app).get('/api/audit-log?status=error').set(authHeader(adminA, tenantA.id));
      for (const row of errors.body.data) expect(row.status_code).toBeGreaterThanOrEqual(400);

      const facets = await request(app).get('/api/audit-log/facets').set(authHeader(adminA, tenantA.id));
      expect(facets.status).toBe(200);
      expect(facets.body.data.actions).toContain('user.impersonate');
      expect(facets.body.data.entity_types).toContain('tenant');
    });

    it('exports the same scope as CSV, and the export is itself audited', async () => {
      const res = await request(app).get('/api/audit-log/export.csv?impersonated=true').set(authHeader(adminA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/audit_\d{4}-\d{2}-\d{2}\.csv/);
      const text = res.text;
      expect(text.charCodeAt(0)).toBe(0xFEFF);
      const lines = text.slice(1).trim().split('\n');
      expect(lines[0]).toBe('created_at,user_email,user_role,impersonator_email,action,entity_type,entity_id,method,endpoint,status_code,ip,changes,error,duration_ms');
      expect(lines.length).toBe(1 + parseInt(res.headers['x-row-count'], 10));
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines.slice(1)) expect(line).toContain(adminA.email);

      await settle();
      const { rows } = await db.query(`SELECT tenant_id, user_email, changes FROM audit_log WHERE action = 'export.audit_csv' ORDER BY id DESC LIMIT 1`);
      expect(rows[0].tenant_id).toBe(tenantA.id);
      expect(rows[0].user_email).toBe(adminA.email);
      expect(rows[0].changes.filters).toEqual({ impersonated: 'true' });

      const tech = await request(app).get('/api/audit-log/export.csv').set(authHeader(techA, tenantA.id));
      expect(tech.status).toBe(403);
    });
  });

  // ── Tenant card ───────────────────────────────────────

  describe('tenant card', () => {
    it('gives the superadmin the organisation, usage, latest signs of life, channels, members and recent records', async () => {
      await db.query(
        `INSERT INTO usage_snapshots (tenant_id, day, active_devices, sites, users, telemetry_rows, notifications_sent)
         VALUES ($1, current_date - 1, 1, 0, 2, 1440, 3), ($1, current_date, 1, 0, 2, 700, 1)`, [tenantA.id]);
      const res = await request(app).get(`/api/tenants/${tenantA.id}/card`).set(authHeader(superadmin, tenantB.id));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.tenant).toMatchObject({ id: tenantA.id, slug: 'support-a', plan: 'pro', device_count: 1 });
      expect(d.usage).toHaveLength(2);
      expect(d.usage[1]).toMatchObject({ active_devices: 1, telemetry_rows: 700, notifications_sent: 1 });
      expect(d.latest).toMatchObject({ devices_active: 1, devices_online: 0, alarms_active: 0, members: 2, work_orders_open: 0, hints_open: 0 });
      expect(d.latest.last_activity_at).toBeTruthy();
      expect(d.latest.last_support_at).toBeTruthy();
      expect(d.channels).toMatchObject({ telegram_subscribers: 0, push_subscriptions: 0, webhooks_enabled: 0, api_keys: 0, notifications_7d: 0 });
      expect(d.users.map(u => u.email).sort()).toEqual([adminA.email, techA.email].sort());
      expect(d.users.find(u => u.id === techA.id)).toMatchObject({ role: 'technician', active: true, mfa: false, is_home: true });
      expect(d.recent_audit.length).toBeGreaterThan(0);
      expect(d.recent_audit[0]).toHaveProperty('impersonator_email');
      expect(d.billing).toMatchObject({ open_invoices: 0, overdue_invoices: 0 });
      expect(Array.isArray(d.support_requests)).toBe(true);
    });

    it('is superadmin-only and 404s an unknown organisation', async () => {
      const admin = await request(app).get(`/api/tenants/${tenantA.id}/card`).set(authHeader(adminA, tenantA.id));
      expect(admin.status).toBe(403);
      const missing = await request(app).get('/api/tenants/00000000-0000-4000-8000-00000000abcd/card').set(authHeader(superadmin, tenantB.id));
      expect(missing.status).toBe(404);
      const junk = await request(app).get('/api/tenants/not-a-uuid/card').set(authHeader(superadmin, tenantB.id));
      expect(junk.status).toBe(404);
    });
  });

  // ── Support form ──────────────────────────────────────

  describe('support requests', () => {
    let mailer;
    let requestId;

    beforeAll(() => {
      process.env.SUPPORT_EMAIL = 'support@test.local';
      mailer = fakeMailer();
      emailSvc.__test.setClient(mailer.client, { from: 'ModESP Cloud <alerts@test.local>', replyTo: 'noreply@test.local' });
    });

    afterAll(() => { delete process.env.SUPPORT_EMAIL; });

    it('tells where support is', async () => {
      const res = await request(app).get('/api/support/info').set(authHeader(techA, tenantA.id));
      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe('support@test.local');
    });

    it('stores the request, mails it with Reply-To the person who wrote, and audits it', async () => {
      const res = await request(app).post('/api/support/requests').set(authHeader(techA, tenantA.id)).send({
        category: 'problem', subject: 'Map shows no devices',
        message: 'Since yesterday the map is empty although the dashboard lists 12 cabinets.',
        context: { page: '#/map', user_agent: 'vitest/1.0', app_version: '1.2.3', locale: 'uk' },
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'new', category: 'problem', emailed: true });
      requestId = res.body.data.id;

      expect(mailer.sent).toHaveLength(1);
      const m = mailer.sent[0];
      expect(m.to).toBe('support@test.local');
      expect(m.replyTo).toBe(techA.email);
      expect(m.subject).toContain('Map shows no devices');
      expect(m.subject).toContain('Морозко');
      expect(m.html).toContain('#/map');
      expect(m.html).toContain('vitest/1.0');
      expect(m.html).toContain(`#/tenants/${tenantA.id}`);

      const { rows } = await db.query('SELECT * FROM support_requests WHERE id = $1', [requestId]);
      expect(rows[0]).toMatchObject({ tenant_id: tenantA.id, user_id: techA.id, user_email: techA.email, user_role: 'technician', status: 'new' });
      expect(rows[0].emailed_at).toBeTruthy();
      expect(rows[0].context).toMatchObject({ page: '#/map', app_version: '1.2.3' });

      await settle();
      const audit = await db.query(`SELECT action, entity_id, tenant_id FROM audit_log WHERE action = 'support.request' ORDER BY id DESC LIMIT 1`);
      expect(audit.rows[0]).toMatchObject({ entity_id: requestId, tenant_id: tenantA.id });
    });

    it('validates, and survives an unconfigured mailer', async () => {
      const short = await request(app).post('/api/support/requests').set(authHeader(techA, tenantA.id)).send({ subject: 'x', message: 'too short' });
      expect(short.status).toBe(400);
      const badCtx = await request(app).post('/api/support/requests').set(authHeader(techA, tenantA.id))
        .send({ subject: 'Valid subject', message: 'A long enough message here.', context: { secret: 'x' } });
      expect(badCtx.status).toBe(400);

      emailSvc.__test.setClient(null);
      const res = await request(app).post('/api/support/requests').set(authHeader(adminA, tenantA.id))
        .send({ category: 'billing', subject: 'Invoice for August', message: 'Please resend the August invoice as PDF.' });
      expect(res.status).toBe(201);
      expect(res.body.data.emailed).toBe(false);
      const { rows } = await db.query('SELECT emailed_at FROM support_requests WHERE id = $1', [res.body.data.id]);
      expect(rows[0].emailed_at).toBeNull();
      emailSvc.__test.setClient(mailer.client, { from: 'ModESP Cloud <alerts@test.local>', replyTo: 'noreply@test.local' });
    });

    it('a closed organisation can still write to support', async () => {
      const res = await request(app).post('/api/support/requests').set(authHeader(viewerClosed, closedTenant.id))
        .send({ subject: 'Reopen us', message: 'We closed by mistake, please reopen the organisation.' });
      expect(res.status).toBe(201);
      // …while everything else stays read-only there
      const write = await request(app).patch('/api/profile').set(authHeader(viewerClosed, closedTenant.id)).send({ base_address: 'x' });
      expect([200, 400, 423]).toContain(write.status);
      const settings = await request(app).patch(`/api/tenants/${closedTenant.id}/settings`).set(authHeader(viewerClosed, closedTenant.id)).send({ timezone: 'UTC' });
      expect([403, 423]).toContain(settings.status);
    });

    it('lists own requests for a member, the organisation for its admin, everything for a superadmin who may change the status', async () => {
      const tech = await request(app).get('/api/support/requests').set(authHeader(techA, tenantA.id));
      expect(tech.status).toBe(200);
      expect(tech.body.data.map(r => r.user_email)).toEqual([techA.email]);

      const admin = await request(app).get('/api/support/requests').set(authHeader(adminA, tenantA.id));
      expect(admin.body.data).toHaveLength(2);
      for (const r of admin.body.data) expect(r.tenant_id).toBe(tenantA.id);

      const all = await request(app).get('/api/support/requests').set(authHeader(superadmin, tenantB.id));
      expect(all.body.data).toHaveLength(3);
      expect(all.body.data.map(r => r.tenant_slug)).toContain('support-closed');
      expect(all.body.meta.open).toBe(3);

      const forbidden = await request(app).patch(`/api/support/requests/${requestId}`).set(authHeader(adminA, tenantA.id)).send({ status: 'closed' });
      expect(forbidden.status).toBe(403);

      const closed = await request(app).patch(`/api/support/requests/${requestId}`).set(authHeader(superadmin, tenantB.id)).send({ status: 'closed' });
      expect(closed.status).toBe(200);
      expect(closed.body.data.status).toBe('closed');
      expect(closed.body.data.closed_at).toBeTruthy();

      const open = await request(app).get('/api/support/requests?status=closed').set(authHeader(superadmin, tenantB.id));
      expect(open.body.data.map(r => r.id)).toEqual([requestId]);
      const count = await request(app).get('/api/support/requests').set(authHeader(superadmin, tenantB.id));
      expect(count.body.meta.open).toBe(2);

      const reopened = await request(app).patch(`/api/support/requests/${requestId}`).set(authHeader(superadmin, tenantB.id)).send({ status: 'open' });
      expect(reopened.body.data.closed_at).toBeNull();
    });
  });

  // ── Pseudonymisation (runs last: it takes the engineer out of every row above) ──

  describe('scrub', () => {
    it('a deleted support engineer is pseudonymised in the rows they impersonated too', async () => {
      const before = await db.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE impersonator_id = $1`, [superadmin.id]);
      expect(before.rows[0].n).toBeGreaterThan(0);
      await db.query('SELECT audit_log_scrub_user($1)', [superadmin.id]);
      const after = await db.query(
        `SELECT COUNT(*)::int AS n, MIN(impersonator_email) AS email FROM audit_log WHERE impersonator_email LIKE 'deleted-%@removed'`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      const left = await db.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE impersonator_id = $1`, [superadmin.id]);
      expect(left.rows[0].n).toBe(0);
      // …and the trail stays immutable otherwise
      await expect(db.query(`UPDATE audit_log SET impersonator_email = 'x' WHERE impersonator_email LIKE 'deleted-%'`)).rejects.toThrow(/immutable/);
    });
  });
});
