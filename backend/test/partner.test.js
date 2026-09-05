'use strict';

// globals: true in vitest.config.js
//
// Partner plan (plan epic 2.5): a service company on the `partner` plan
// creates its clients' organisations, puts its own technicians into them with
// a role per membership, and sees their alarms, work orders and hints in one
// place. Partner A never sees partner B's clients; a client's admin is not a
// partner; a plan without the feature gets 402.

const request = require('supertest');
const crypto  = require('crypto');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const plan = require('../src/middleware/plan');

const app = createTestApp();
const H = (u, t) => authHeader(u, t.id);
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('partner plan', () => {
  let partnerA, partnerB, proTenant, adminA, techA, adminB, proAdmin, superadmin;
  let clientA1, clientA2, clientB1, clientAdmin;

  beforeAll(async () => {
    await cleanDatabase();
    partnerA  = await createTenant({ slug: 'partner-a', plan: 'partner', name: 'Холод-Сервіс' });
    partnerB  = await createTenant({ slug: 'partner-b', plan: 'partner', name: 'Інший партнер' });
    proTenant = await createTenant({ slug: 'plain-pro', plan: 'pro' });
    adminA     = await createUser(partnerA.id,  { role: 'admin',      email: 'admin@partner-a.test' });
    techA      = await createUser(partnerA.id,  { role: 'technician', email: 'tech@partner-a.test' });
    adminB     = await createUser(partnerB.id,  { role: 'admin',      email: 'admin@partner-b.test' });
    proAdmin   = await createUser(proTenant.id, { role: 'admin',      email: 'admin@plain-pro.test' });
    superadmin = await createUser(partnerA.id,  { role: 'superadmin', email: 'sa@partner.test' });
    await db.query(`UPDATE tenants SET legal_name = 'ТОВ Холод-Сервіс', tax_id = '12345678', billing_email = 'bill@partner-a.test' WHERE id = $1`, [partnerA.id]);
    await db.query(`INSERT INTO tenant_settings (tenant_id, timezone, locale, brand_name, brand_url) VALUES ($1, 'Europe/Warsaw', 'pl', 'Холод-Сервіс', 'https://holod.example')`, [partnerA.id]);
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('a partner admin creates a client; a plain admin and a technician cannot', async () => {
    expect((await request(app).get('/api/partner/clients').set(H(proAdmin, proTenant))).status).toBe(402);
    expect((await request(app).post('/api/partner/clients').set(H(techA, partnerA)).send({ name: 'x', slug: 'x-x' })).status).toBe(403);

    const res = await request(app).post('/api/partner/clients').set(H(adminA, partnerA)).send({ name: 'Магазин «Ромашка»', slug: 'romashka', plan: 'basic' });
    expect(res.status).toBe(201);
    clientA1 = res.body.data;
    expect(clientA1).toMatchObject({ slug: 'romashka', plan: 'basic', status: 'active', my_role: 'admin', device_count: 0 });

    const { rows } = await db.query('SELECT parent_tenant_id, billing_account_id FROM tenants WHERE id = $1', [clientA1.id]);
    expect(rows[0].parent_tenant_id).toBe(partnerA.id);
    // the partner got a billing account from its billing identity, and the client shares it
    const { rows: acc } = await db.query('SELECT b.legal_name, b.tax_id, b.is_partner, t.billing_account_id FROM tenants t JOIN billing_accounts b ON b.id = t.billing_account_id WHERE t.id = $1', [partnerA.id]);
    expect(acc[0]).toMatchObject({ legal_name: 'ТОВ Холод-Сервіс', tax_id: '12345678', is_partner: true });
    expect(rows[0].billing_account_id).toBe(acc[0].billing_account_id);
    // the client inherited the partner's language and time zone
    const { rows: st } = await db.query('SELECT timezone, locale FROM tenant_settings WHERE tenant_id = $1', [clientA1.id]);
    expect(st[0]).toMatchObject({ timezone: 'Europe/Warsaw', locale: 'pl' });

    expect((await request(app).post('/api/partner/clients').set(H(adminA, partnerA)).send({ name: 'dup', slug: 'romashka' })).status).toBe(409);
    expect((await request(app).post('/api/partner/clients').set(H(adminA, partnerA)).send({ name: 'nope', slug: 'nope-nope', plan: 'partner' })).status).toBe(400);

    clientA2 = (await request(app).post('/api/partner/clients').set(H(adminA, partnerA)).send({ name: 'Аптека №3', slug: 'apteka-3', plan: 'pro' })).body.data;
    clientB1 = (await request(app).post('/api/partner/clients').set(H(adminB, partnerB)).send({ name: 'Клієнт Б', slug: 'client-b1' })).body.data;
    expect(clientA2.id).toBeTruthy();
    expect(clientB1.id).toBeTruthy();
  });

  it('partner A sees only its own clients and cannot touch partner B\'s', async () => {
    const list = await request(app).get('/api/partner/clients').set(H(adminA, partnerA));
    expect(list.status).toBe(200);
    expect(list.body.data.map(c => c.slug).sort()).toEqual(['apteka-3', 'romashka']);

    expect((await request(app).patch(`/api/partner/clients/${clientB1.id}`).set(H(adminA, partnerA)).send({ name: 'hijack' })).status).toBe(404);
    expect((await request(app).get(`/api/partner/clients/${clientB1.id}/members`).set(H(adminA, partnerA))).status).toBe(404);
    expect((await request(app).post(`/api/partner/clients/${clientB1.id}/members`).set(H(adminA, partnerA)).send({ user_id: techA.id })).status).toBe(404);

    // partner A's admin can enter its client, not partner B's
    expect((await request(app).post('/api/auth/switch-tenant').set(H(adminA, partnerA)).send({ tenant_id: clientA1.id })).status).toBe(200);
    expect((await request(app).post('/api/auth/switch-tenant').set(H(adminA, partnerA)).send({ tenant_id: clientB1.id })).status).toBe(403);

    // the client's own admin has no partner feature
    clientAdmin = await createUser(clientA1.id, { role: 'admin', email: 'admin@romashka.test' });
    expect((await request(app).get('/api/partner/clients').set(H(clientAdmin, clientA1))).status).toBe(402);

    const ren = await request(app).patch(`/api/partner/clients/${clientA1.id}`).set(H(adminA, partnerA)).send({ name: 'Ромашка (Львів)' });
    expect(ren.status).toBe(200);
    expect(ren.body.data.name).toBe('Ромашка (Львів)');
    plan.invalidate();
  });

  it('a role per membership: partner staff is admin at home and technician at the client', async () => {
    const add = await request(app).post(`/api/partner/clients/${clientA1.id}/members`).set(H(adminA, partnerA)).send({ user_id: techA.id, role: 'technician' });
    expect(add.status).toBe(201);
    // someone from another organisation cannot be placed
    expect((await request(app).post(`/api/partner/clients/${clientA1.id}/members`).set(H(adminA, partnerA)).send({ user_id: adminB.id })).status).toBe(400);

    const members = await request(app).get(`/api/partner/clients/${clientA1.id}/members`).set(H(adminA, partnerA));
    expect(members.status).toBe(200);
    expect(members.body.data.find(m => m.id === techA.id)).toMatchObject({ role: 'technician', partner_staff: true });
    expect(members.body.data.find(m => m.email === 'admin@romashka.test')).toMatchObject({ role: 'admin', partner_staff: false });

    // the access token carries the role held in the organisation entered
    const login = await request(app).post('/api/auth/login').send({ email: 'tech@partner-a.test', password: techA._password });
    expect(login.status).toBe(200);
    expect(login.body.data.require_tenant_select).toBe(true);   // two organisations → tenant selection
    const sel = await request(app).post('/api/auth/select-tenant').send({ pending_token: login.body.data.pending_token, tenant_id: clientA1.id });
    expect(sel.status).toBe(200);
    expect(sel.body.data.user.role).toBe('technician');
    expect(sel.body.data.tenant).toMatchObject({ id: clientA1.id, plan: 'basic', parent_tenant_id: partnerA.id });
    expect(sel.body.data.tenants.find(t => t.id === clientA1.id)).toMatchObject({ role: 'technician' });
    expect(sel.body.data.tenants.find(t => t.id === partnerA.id)).toMatchObject({ role: 'technician', plan: 'partner' });

    // a viewer at the second client cannot create users there, whatever they are elsewhere
    await request(app).post(`/api/partner/clients/${clientA2.id}/members`).set(H(adminA, partnerA)).send({ user_id: techA.id, role: 'viewer' });
    const sw = await request(app).post('/api/auth/switch-tenant').set(bearer(sel.body.data.access_token)).send({ tenant_id: clientA2.id });
    expect(sw.status).toBe(200);
    expect(sw.body.data.role).toBe('viewer');
    expect((await request(app).post('/api/users').set(bearer(sw.body.data.access_token)).send({ email: 'x@y.test', password: 'Test1234!Secure' })).status).toBe(403);
    // and a refreshed token keeps the role of the organisation it was issued for
    const rf = await request(app).post('/api/auth/refresh').send({ refresh_token: sw.body.data.refresh_token });
    expect(rf.status).toBe(200);
    expect(rf.body.data.role).toBe('viewer');

    // the client's user list shows the role held there; a client admin changes it, but nothing else about partner staff
    const list = await request(app).get('/api/users').set(H(clientAdmin, clientA1));
    expect(list.body.data.find(u => u.id === techA.id)).toMatchObject({ role: 'technician', is_home: false, home_role: 'technician' });
    expect((await request(app).put(`/api/users/${techA.id}`).set(H(clientAdmin, clientA1)).send({ email: 'steal@romashka.test' })).status).toBe(403);
    const promote = await request(app).put(`/api/users/${techA.id}`).set(H(clientAdmin, clientA1)).send({ role: 'admin' });
    expect(promote.status).toBe(200);
    expect((await db.query('SELECT role FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [techA.id, clientA1.id])).rows[0].role).toBe('admin');
    expect((await db.query('SELECT role FROM users WHERE id = $1', [techA.id])).rows[0].role).toBe('technician');   // home role untouched

    // removal: partner staff only, and site grants go with the membership
    expect((await request(app).delete(`/api/partner/clients/${clientA1.id}/members/${clientAdmin.id}`).set(H(adminA, partnerA))).status).toBe(404);
    expect((await request(app).delete(`/api/partner/clients/${clientA1.id}/members/${techA.id}`).set(H(adminA, partnerA))).status).toBe(200);
    expect((await db.query('SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [techA.id, clientA1.id])).rows.length).toBe(0);
  });

  it('the overview aggregates devices, alarms, work orders and hints across the clients', async () => {
    const d1 = await createDevice(clientA1.id, { mqttId: 'PRT001', name: 'Камера 1' });
    await createDevice(clientA2.id, { mqttId: 'PRT002', name: 'Вітрина' });
    await createDevice(clientB1.id, { mqttId: 'PRTB01' });
    await db.query('UPDATE devices SET online = true WHERE id = $1', [d1.id]);
    await db.query(`INSERT INTO alarms (tenant_id, device_id, alarm_code, severity, active) VALUES ($1, 'PRT001', 'high_temp_alarm', 'critical', true), ($2, 'PRT002', 'door_alarm', 'warning', true), ($3, 'PRTB01', 'door_alarm', 'warning', true)`, [clientA1.id, clientA2.id, clientB1.id]);
    await db.query(`INSERT INTO work_orders (tenant_id, device_id, device_mqtt_id, title, priority, status, created_by) VALUES ($1, $2, 'PRT001', 'Замінити реле', 'urgent', 'new', $3)`, [clientA1.id, d1.id, adminA.id]);
    await db.query(`INSERT INTO maintenance_hints (tenant_id, device_id, rule_key, alarm_code, value, threshold, window_hours) VALUES ($1, 'PRT002', 'alarm_repeat', 'door_alarm', 4, 3, 168)`, [clientA2.id]);

    const ov = await request(app).get('/api/partner/overview').set(H(adminA, partnerA));
    expect(ov.status).toBe(200);
    expect(ov.body.data.totals).toEqual({ clients: 2, devices: 2, online: 1, active_alarms: 2, open_orders: 1, open_hints: 1 });
    expect(ov.body.data.alarms.map(a => a.tenant_name).sort()).toEqual(['Аптека №3', 'Ромашка (Львів)']);
    expect(ov.body.data.alarms[0]).toMatchObject({ alarm_code: 'high_temp_alarm', device_name: 'Камера 1', tenant_id: clientA1.id });
    expect(ov.body.data.work_orders[0]).toMatchObject({ title: 'Замінити реле', tenant_name: 'Ромашка (Львів)' });
    expect(ov.body.data.hints[0]).toMatchObject({ alarm_code: 'door_alarm', tenant_id: clientA2.id, value: 4 });

    const clients = (await request(app).get('/api/partner/clients').set(H(adminA, partnerA))).body.data;
    expect(clients.find(c => c.id === clientA1.id)).toMatchObject({ device_count: 1, online_count: 1, active_alarms: 1, critical_alarms: 1, open_orders: 1, open_hints: 0 });
    expect(clients.find(c => c.id === clientA2.id)).toMatchObject({ device_count: 1, online_count: 0, active_alarms: 1, open_hints: 1 });

    // partner B sees only its own
    const ovB = await request(app).get('/api/partner/overview').set(H(adminB, partnerB));
    expect(ovB.body.data.totals).toMatchObject({ clients: 1, devices: 1, active_alarms: 1 });

    // the cross-tenant map: sites with coordinates of the clients only
    await db.query(`INSERT INTO sites (tenant_id, name, latitude, longitude) VALUES ($1, 'Точка А', 49.84, 24.03), ($2, 'Точка Б', 50.45, 30.52)`, [clientA1.id, clientB1.id]);
    const sites = await request(app).get('/api/partner/sites').set(H(adminA, partnerA));
    expect(sites.status).toBe(200);
    expect(sites.body.data.map(s => s.name)).toEqual(['Точка А']);
    expect(sites.body.data[0]).toMatchObject({ tenant_name: 'Ромашка (Львів)', device_count: 0 });
  });

  it('branding follows the partner onto the client\'s public status page; the parent link is superadmin-validated', async () => {
    const { rows: site } = await db.query(`SELECT id FROM sites WHERE tenant_id = $1`, [clientA1.id]);
    const token = crypto.randomBytes(24).toString('hex');
    await db.query(
      `INSERT INTO site_public_links (tenant_id, site_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, now() + interval '30 days', $4)`,
      [clientA1.id, site[0].id, crypto.createHash('sha256').update(token).digest('hex'), adminA.id]);
    const pub = await request(app).get('/api/public/site').set('X-Site-Token', token);
    expect(pub.status).toBe(200);
    expect(pub.body.data.brand).toEqual({ name: 'Холод-Сервіс', logo_url: null, url: 'https://holod.example' });

    // the client's own brand would win once set — but only with the feature; basic has none
    expect((await request(app).patch(`/api/tenants/${clientA1.id}/settings`).set(H(clientAdmin, clientA1)).send({ brand_name: 'Ромашка' })).status).toBe(402);
    const own = await request(app).patch(`/api/tenants/${partnerA.id}/settings`).set(H(adminA, partnerA)).send({ brand_name: 'Холод-Сервіс Плюс', brand_logo_url: 'https://holod.example/logo.png' });
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ brand_name: 'Холод-Сервіс Плюс', brand_logo_url: 'https://holod.example/logo.png' });
    expect((await request(app).get('/api/public/site').set('X-Site-Token', token)).body.data.brand.name).toBe('Холод-Сервіс Плюс');

    // superadmin may attach an existing organisation to a partner, with the one-level rule
    expect((await request(app).patch(`/api/tenants/${proTenant.id}`).set(H(superadmin, partnerA)).send({ parent_tenant_id: partnerA.id })).status).toBe(200);
    expect((await request(app).patch(`/api/tenants/${proTenant.id}`).set(H(superadmin, partnerA)).send({ parent_tenant_id: clientA1.id })).status).toBe(400);   // a client is not a partner
    expect((await request(app).patch(`/api/tenants/${partnerA.id}`).set(H(superadmin, partnerA)).send({ parent_tenant_id: partnerB.id })).status).toBe(400);   // has clients
    expect((await request(app).patch(`/api/tenants/${clientA2.id}`).set(H(superadmin, partnerA)).send({ parent_tenant_id: proTenant.id })).status).toBe(400);  // pro is not a partner plan
    const list = await request(app).get('/api/tenants').set(H(superadmin, partnerA));
    expect(list.body.data.find(t => t.id === partnerA.id)).toMatchObject({ client_count: 3 });
    expect(list.body.data.find(t => t.id === proTenant.id)).toMatchObject({ parent_name: 'Холод-Сервіс' });
    expect((await request(app).patch(`/api/tenants/${proTenant.id}`).set(H(superadmin, partnerA)).send({ parent_tenant_id: null })).status).toBe(200);
  });
});
