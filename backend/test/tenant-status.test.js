'use strict';

// globals: true in vitest.config.js
//
// Organisation status (plan epic 1.8): suspended/closed organisations lose
// login, token refresh, tenant switch and broker topics; reactivation restores
// everything without touching device credentials.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, authHeader } = require('./helpers/factories');

const app = createTestApp();
const CONF = fs.readFileSync(path.join(__dirname, '../../infra/mosquitto/mosquitto.conf'), 'utf8');
const ACL_SQL = CONF.split(/\r?\n/).find(l => l.startsWith('auth_opt_pg_aclquery')).replace(/^auth_opt_pg_aclquery\s+/, '');

async function aclTopics(username, access) {
  const { rows } = await db.query(ACL_SQL, [username, access]);
  return rows.map(r => Object.values(r)[0]);
}

describe('organisation status', () => {
  let tenant, other, admin, superadmin, dual;
  const PW = 'StatusTestPassw0rd!';

  beforeAll(async () => {
    await cleanDatabase();
    tenant     = await createTenant({ slug: 'status-a' });
    other      = await createTenant({ slug: 'status-b' });
    admin      = await createUser(tenant.id, { role: 'admin', email: 'admin@status.test', password: PW });
    superadmin = await createUser(other.id, { role: 'superadmin', email: 'super@status.test' });
    dual       = await createUser(other.id, { role: 'technician', email: 'dual@status.test', password: PW });
    await db.query('INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)', [dual.id, tenant.id]);
    await db.query(
      `INSERT INTO devices (tenant_id, mqtt_device_id, mqtt_username, mqtt_password_hash, status, online, assigned_at, last_seen)
       VALUES ($1, 'ST0001', 'device_ST0001', 'x', 'active', true, now() - interval '1 day', now())`, [tenant.id]);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('a new organisation is active and the boolean mirror agrees', async () => {
    const { rows } = await db.query('SELECT status, active FROM tenants WHERE id = $1', [tenant.id]);
    expect(rows[0]).toEqual({ status: 'active', active: true });
    expect(await aclTopics('device_ST0001', 2)).toContain('modesp/v1/status-a/ST0001/status');
  });

  it('suspending stops login, refresh, switch-tenant and broker topics', async () => {
    const login0 = await request(app).post('/api/auth/login').send({ email: 'admin@status.test', password: PW });
    expect(login0.status).toBe(200);
    const refreshToken = login0.body.data.refresh_token;

    const res = await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'suspended', active: false });
    expect(res.body.data.suspended_at).toBeTruthy();

    const login = await request(app).post('/api/auth/login').send({ email: 'admin@status.test', password: PW });
    expect(login.status).toBe(401);
    expect(login.body.error).toBe('tenant_suspended');

    const refresh = await request(app).post('/api/auth/refresh').send({ refresh_token: refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('tenant_suspended');

    // A user of two organisations still logs into the open one, cannot switch to the suspended one
    const dualLogin = await request(app).post('/api/auth/login').send({ email: 'dual@status.test', password: PW });
    expect(dualLogin.status).toBe(200);
    expect(dualLogin.body.data.tenant.id).toBe(other.id);
    expect(dualLogin.body.data.tenants.map(t => t.id)).not.toContain(tenant.id);
    const sw = await request(app).post('/api/auth/switch-tenant').set('Authorization', `Bearer ${dualLogin.body.data.access_token}`)
      .send({ tenant_id: tenant.id });
    expect(sw.status).toBe(401);

    // Broker: the device keeps its credentials but gets no topics
    expect(await aclTopics('device_ST0001', 2)).toEqual([]);
    expect(await aclTopics('device_ST0001', 1)).toEqual([]);
    const { rows } = await db.query(`SELECT mqtt_password_hash FROM devices WHERE mqtt_device_id = 'ST0001'`);
    expect(rows[0].mqtt_password_hash).toBe('x');
  });

  it('the legacy active flag still works both ways through the trigger', async () => {
    await db.query('UPDATE tenants SET active = true WHERE id = $1', [tenant.id]);
    let { rows } = await db.query('SELECT status, active, suspended_at FROM tenants WHERE id = $1', [tenant.id]);
    expect(rows[0]).toMatchObject({ status: 'active', active: true, suspended_at: null });
    await db.query('UPDATE tenants SET active = false WHERE id = $1', [tenant.id]);
    ({ rows } = await db.query('SELECT status, active FROM tenants WHERE id = $1', [tenant.id]));
    expect(rows[0]).toMatchObject({ status: 'suspended', active: false });
  });

  it('reactivation restores login and topics; closed behaves like suspended', async () => {
    const res = await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'active' });
    expect(res.body.data).toMatchObject({ status: 'active', active: true, suspended_at: null });
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@status.test', password: PW })).status).toBe(200);
    expect(await aclTopics('device_ST0001', 2)).toContain('modesp/v1/status-a/ST0001/status');

    await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'closed' });
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@status.test', password: PW })).body.error).toBe('tenant_suspended');
    await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'active' });
  });

  it('past_due and trial keep the organisation open; billing fields are stored', async () => {
    const res = await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id))
      .send({ status: 'past_due', billing_email: 'billing@status.test', legal_name: 'ТОВ Статус', tax_id: '12345678', contract_started_at: '2026-09-01' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'past_due', active: true, billing_email: 'billing@status.test', legal_name: 'ТОВ Статус', tax_id: '12345678' });
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@status.test', password: PW })).status).toBe(200);
    expect((await request(app).patch(`/api/tenants/${tenant.id}`).set(authHeader(superadmin, other.id)).send({ status: 'bogus' })).status).toBe(400);
  });

  it('bulk delete is reachable (was shadowed by DELETE /:id)', async () => {
    const victim = await createTenant({ slug: 'status-victim' });
    const res = await request(app).delete('/api/tenants/bulk').set(authHeader(superadmin, other.id)).send({ ids: [victim.id] });
    expect(res.status).toBe(200);
    const { rows } = await db.query('SELECT 1 FROM tenants WHERE id = $1', [victim.id]);
    expect(rows).toHaveLength(0);
  });
});
