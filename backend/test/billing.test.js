'use strict';

// globals: true in vitest.config.js
//
// Billing without card payments (plan epic 2.2): usage snapshots, invoices
// from snapshots × plan prices (a partner gets one consolidated invoice),
// dunning past_due → reminder → suspended, payment restores the organisation,
// plan-change requests, seller requisites, and who may see what.

const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { cleanDatabase, shutdownDb, db } = require('./helpers/setup');
const { createTenant, createUser, createDevice, authHeader } = require('./helpers/factories');
const billing = require('../src/services/billing');

const app = createTestApp();
const H = (u, t) => authHeader(u, t.id);
const NOW = new Date('2026-09-06T10:00:00Z');
const AUG = billing.periodFromString('2026-08');

async function fillSnapshots(tenantId, period, { devices, sites }) {
  await db.query(
    `INSERT INTO usage_snapshots (tenant_id, day, active_devices, sites, users)
     SELECT $1, d::date, $4, $5, 1 FROM generate_series($2::date, $3::date - 1, interval '1 day') d
     ON CONFLICT (tenant_id, day) DO UPDATE SET active_devices = EXCLUDED.active_devices, sites = EXCLUDED.sites`,
    [tenantId, period.start, period.end, devices, sites]);
}

async function tenantStatus(id) {
  const { rows } = await db.query('SELECT status FROM tenants WHERE id = $1', [id]);
  return rows[0].status;
}

describe('billing', () => {
  let proT, freeT, entT, partnerT, client1, client2, otherT;
  let proAdmin, proViewer, clientAdmin, partnerAdmin, superadmin;
  let proInvoice, partnerInvoice;

  beforeAll(async () => {
    await cleanDatabase();
    billing.__test.setLogger(require('pino')({ level: 'silent' }));

    proT     = await createTenant({ slug: 'bill-pro',     plan: 'pro',        name: 'Мережа Про' });
    freeT    = await createTenant({ slug: 'bill-free',    plan: 'free',       name: 'Старт' });
    entT     = await createTenant({ slug: 'bill-ent',     plan: 'enterprise', name: 'Корпорація' });
    partnerT = await createTenant({ slug: 'bill-partner', plan: 'partner',    name: 'Холод-Сервіс' });
    client1  = await createTenant({ slug: 'bill-c1',      plan: 'basic',      name: 'Аптека' });
    client2  = await createTenant({ slug: 'bill-c2',      plan: 'pro',        name: 'Кафе' });
    otherT   = await createTenant({ slug: 'bill-other',   plan: 'pro' });

    proAdmin     = await createUser(proT.id,     { role: 'admin',  email: 'admin@bill-pro.test' });
    proViewer    = await createUser(proT.id,     { role: 'viewer', email: 'viewer@bill-pro.test' });
    clientAdmin  = await createUser(client1.id,  { role: 'admin',  email: 'admin@bill-c1.test' });
    partnerAdmin = await createUser(partnerT.id, { role: 'admin',  email: 'admin@bill-partner.test' });
    superadmin   = await createUser(otherT.id,   { role: 'superadmin', email: 'sa@bill.test' });

    // Everyone existed before August (the base fee is prorated by creation date)
    await db.query(`UPDATE tenants SET created_at = '2026-06-01T00:00:00Z' WHERE slug LIKE 'bill-%'`);
    await db.query(`UPDATE tenants SET legal_name = 'ТОВ Мережа Про', tax_id = '11112222', billing_email = 'money@bill-pro.test' WHERE id = $1`, [proT.id]);

    // Partner account: partner + two clients pay through one billing account
    const { rows: acc } = await db.query(
      `INSERT INTO billing_accounts (legal_name, tax_id, email, is_partner) VALUES ('ТОВ Холод-Сервіс', '33334444', 'bill@partner.test', true) RETURNING id`);
    // client2 never got the account (linked by the superadmin through parent_tenant_id only) — still the partner's to pay
    await db.query(`UPDATE tenants SET billing_account_id = $1 WHERE id = ANY($2::uuid[])`, [acc[0].id, [partnerT.id, client1.id]]);
    await db.query(`UPDATE tenants SET parent_tenant_id = $1 WHERE id = ANY($2::uuid[])`, [partnerT.id, [client1.id, client2.id]]);

    // Live fleet: pro has 3 controllers and 2 sites; clients 2 + 1; free 1; enterprise 5
    for (let i = 0; i < 3; i++) await createDevice(proT.id, { mqttId: `PRO00${i}` });
    await db.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Точка 1'), ($1, 'Точка 2')`, [proT.id]);
    for (let i = 0; i < 2; i++) await createDevice(client1.id, { mqttId: `CL100${i}` });
    await createDevice(client2.id, { mqttId: 'CL2000' });
    await createDevice(freeT.id, { mqttId: 'FREE00' });
    for (let i = 0; i < 5; i++) await createDevice(entT.id, { mqttId: `ENT00${i}` });
  });

  afterAll(async () => {
    await cleanDatabase();
    await shutdownDb();
  });

  it('snapshotAll writes yesterday and today for every open organisation', async () => {
    const r = await billing.snapshotAll({ now: NOW });
    expect(r.days).toEqual(['2026-09-05', '2026-09-06']);
    const { rows } = await db.query(
      `SELECT day::text AS day, active_devices, sites, users FROM usage_snapshots WHERE tenant_id = $1 ORDER BY day`, [proT.id]);
    expect(rows).toEqual([
      { day: '2026-09-05', active_devices: 3, sites: 2, users: 2 },
      { day: '2026-09-06', active_devices: 3, sites: 2, users: 2 },
    ]);
    const { rows: sys } = await db.query('SELECT 1 FROM usage_snapshots WHERE tenant_id = $1', [db.SYSTEM_TENANT_ID]);
    expect(sys).toHaveLength(0);
    // idempotent
    await billing.snapshotAll({ now: NOW });
    const { rows: again } = await db.query('SELECT COUNT(*)::int AS n FROM usage_snapshots WHERE tenant_id = $1', [proT.id]);
    expect(again[0].n).toBe(2);
  });

  it('generateInvoices bills August from the snapshots: pro per controller + site, partner consolidated, free and enterprise skipped', async () => {
    await fillSnapshots(proT.id, AUG, { devices: 3, sites: 2 });
    await fillSnapshots(partnerT.id, AUG, { devices: 0, sites: 0 });
    await fillSnapshots(client1.id, AUG, { devices: 2, sites: 1 });
    await fillSnapshots(client2.id, AUG, { devices: 1, sites: 1 });
    await fillSnapshots(freeT.id, AUG, { devices: 1, sites: 1 });
    await fillSnapshots(entT.id, AUG, { devices: 5, sites: 2 });
    // period not over yet → nothing
    expect((await billing.generateInvoices({ now: NOW, period: billing.periodFromString('2026-09') })).skipped).toBe('period_not_over');

    const r = await billing.generateInvoices({ now: NOW, period: AUG, send: false });
    expect(r.created.map(i => i.tenant_id).sort()).toEqual([proT.id, partnerT.id].sort());

    proInvoice = r.created.find(i => i.tenant_id === proT.id);
    expect(proInvoice.number).toMatch(/^MC-\d{6}$/);
    expect(Number(proInvoice.amount)).toBe(800);              // 3 × 100 + 2 × 250
    expect(proInvoice.lines.map(l => [l.kind, l.qty, l.unit_price, l.amount])).toEqual([
      ['controllers', 3, 100, 300], ['sites', 2, 250, 500],
    ]);
    expect(proInvoice.buyer).toMatchObject({ legal_name: 'ТОВ Мережа Про', tax_id: '11112222', email: 'money@bill-pro.test' });
    expect(new Date(proInvoice.due_at) - NOW).toBe(14 * 86_400_000);

    partnerInvoice = r.created.find(i => i.tenant_id === partnerT.id);
    expect(Number(partnerInvoice.amount)).toBe(2300);          // 2000 base + (2 + 1) × 100; no site price on the partner plan
    expect(partnerInvoice.lines.map(l => [l.kind, l.tenant_name, l.qty, l.amount])).toEqual([
      ['base', 'Холод-Сервіс', 1, 2000], ['controllers', 'Аптека', 2, 200], ['controllers', 'Кафе', 1, 100],
    ]);
    expect(partnerInvoice.buyer.legal_name).toBe('ТОВ Холод-Сервіс');

    // idempotent: a second run issues nothing
    expect((await billing.generateInvoices({ now: NOW, period: AUG, send: false })).created).toHaveLength(0);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM invoices');
    expect(rows[0].n).toBe(2);
  });

  it('proration: an organisation that joined mid-month pays for its device-days, and volume tiers apply', () => {
    const plans = { pro: { name: 'Мережа', price_base_uah: null, price_controller_uah: 100, price_site_uah: 250, price_tiers_uah: [{ from: 100, price: 80 }, { from: 500, price: 60 }] },
                    partner: { name: 'Партнер', price_base_uah: 2000, price_controller_uah: 100, price_site_uah: null, price_tiers_uah: [{ from: 100, price: 80 }] } };
    expect(billing.__test.tierPrice(plans.pro, 99)).toBe(100);
    expect(billing.__test.tierPrice(plans.pro, 100)).toBe(80);
    expect(billing.__test.tierPrice(plans.pro, 700)).toBe(60);

    // partner created on the 16th of a 31-day month: base × 16/31, 120 controllers at the tier price
    const payer = { id: 'p', name: 'P', plan: 'partner', created_at: '2026-08-16T12:00:00Z' };
    const members = [payer, { id: 'c', name: 'C' }];
    const lines = billing.__test.buildLines({ payer, members, usage: { c: { devices: 120, sites: 3 } }, plans, period: AUG });
    expect(lines[0]).toMatchObject({ kind: 'base', qty: 0.52, amount: 1040 });    // round2(16/31) × 2000
    expect(lines[1]).toMatchObject({ kind: 'controllers', tenant_id: 'c', qty: 120, unit_price: 80, amount: 9600 });
    expect(lines).toHaveLength(2);
  });

  it('an admin sees its own invoices and PDF, a viewer gets 403, a client billed through its partner sees who pays', async () => {
    expect((await request(app).get('/api/billing/invoices').set(H(proViewer, proT))).status).toBe(403);

    const list = await request(app).get('/api/billing/invoices').set(H(proAdmin, proT));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ number: proInvoice.number, status: 'issued', amount: 800, overdue: false });

    const one = await request(app).get(`/api/billing/invoices/${proInvoice.id}`).set(H(proAdmin, proT));
    expect(one.status).toBe(200);
    expect(one.body.data.lines).toHaveLength(2);
    // not mine
    expect((await request(app).get(`/api/billing/invoices/${partnerInvoice.id}`).set(H(proAdmin, proT))).status).toBe(404);

    const pdf = await request(app).get(`/api/billing/invoices/${proInvoice.id}/pdf?lang=en`).set(H(proAdmin, proT)).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toContain(`${proInvoice.number}.pdf`);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');

    const summary = await request(app).get('/api/billing/summary').set(H(proAdmin, proT));
    expect(summary.status).toBe(200);
    expect(summary.body.data.tenant).toMatchObject({ plan: 'pro', status: 'active', legal_name: 'ТОВ Мережа Про' });
    expect(summary.body.data.estimate).toMatchObject({ amount: 800, billed_via_partner: false });   // live: 3 controllers, 2 sites
    expect(summary.body.data.open_invoices).toHaveLength(1);
    expect(Object.keys(summary.body.data.seller)).toContain('seller_iban');

    // the partner's client: no invoices of its own, the payer named, no partner totals
    const cs = await request(app).get('/api/billing/summary').set(H(clientAdmin, client1));
    expect(cs.status).toBe(200);
    expect(cs.body.data.estimate).toEqual({ billed_via_partner: true, payer: { id: partnerT.id, name: 'Холод-Сервіс', plan: 'partner' }, period: expect.any(Object) });
    expect(cs.body.data.estimate.lines).toBeUndefined();
    expect((await request(app).get('/api/billing/invoices').set(H(clientAdmin, client1))).body.data).toEqual([]);

    // the partner sees the consolidated invoice with a line per client
    const ps = await request(app).get('/api/billing/summary').set(H(partnerAdmin, partnerT));
    expect(ps.body.data.estimate.lines.map(l => l.tenant_name)).toEqual(['Холод-Сервіс', 'Аптека', 'Кафе']);
    expect(ps.body.data.estimate.amount).toBe(2300);
  });

  it('dunning: day 7 past_due, day 14 reminder, day 21 suspended — for the partner and its clients too; payment restores', async () => {
    const dueAt = new Date(proInvoice.due_at);
    const at = (days) => new Date(dueAt.getTime() + days * 86_400_000 + 3_600_000);

    expect(await billing.runDunning({ now: at(3) })).toEqual({ past_due: [], reminded: [], suspended: [] });
    expect(await tenantStatus(proT.id)).toBe('active');

    let r = await billing.runDunning({ now: at(7) });
    expect(r.past_due.sort()).toEqual([proInvoice.number, partnerInvoice.number].sort());
    expect(await tenantStatus(proT.id)).toBe('past_due');
    expect(await tenantStatus(partnerT.id)).toBe('past_due');
    expect(await tenantStatus(client1.id)).toBe('past_due');
    // applied once
    expect((await billing.runDunning({ now: at(8) })).past_due).toEqual([]);

    r = await billing.runDunning({ now: at(14) });
    expect(r.reminded).toHaveLength(2);
    expect(await tenantStatus(proT.id)).toBe('past_due');

    r = await billing.runDunning({ now: at(21) });
    expect(r.suspended).toHaveLength(2);
    expect(await tenantStatus(proT.id)).toBe('suspended');
    expect(await tenantStatus(client2.id)).toBe('suspended');
    const { rows: st } = await db.query('SELECT dunning_stage FROM invoices WHERE id = $1', [proInvoice.id]);
    expect(st[0].dunning_stage).toBe(3);

    // a suspended organisation's admin can no longer reach the API; the superadmin marks the invoice paid
    expect((await request(app).post(`/api/billing/admin/invoices/${proInvoice.id}/pay`).set(H(proAdmin, proT)).send({})).status).toBe(403);
    const pay = await request(app).post(`/api/billing/admin/invoices/${proInvoice.id}/pay`).set(H(superadmin, otherT)).send({ note: 'виписка 05.10' });
    expect(pay.status).toBe(200);
    expect(pay.body.data).toMatchObject({ status: 'paid', paid_note: 'виписка 05.10' });
    expect(pay.body.data.restored.map(t => t.slug)).toEqual(['bill-pro']);
    expect(await tenantStatus(proT.id)).toBe('active');
    expect((await request(app).post(`/api/billing/admin/invoices/${proInvoice.id}/pay`).set(H(superadmin, otherT)).send({})).status).toBe(409);

    // voiding the partner's invoice restores the partner and both clients
    const v = await request(app).post(`/api/billing/admin/invoices/${partnerInvoice.id}/void`).set(H(superadmin, otherT)).send({ note: 'помилка' });
    expect(v.status).toBe(200);
    expect(v.body.data.restored.map(t => t.slug).sort()).toEqual(['bill-c1', 'bill-c2', 'bill-partner']);
    expect(await tenantStatus(client1.id)).toBe('active');
  });

  it('superadmin lists invoices, runs the jobs by hand and keeps the seller requisites', async () => {
    const all = await request(app).get('/api/billing/admin/invoices?status=paid').set(H(superadmin, otherT));
    expect(all.status).toBe(200);
    expect(all.body.data.map(i => i.tenant_slug)).toEqual(['bill-pro']);
    expect((await request(app).get('/api/billing/admin/invoices').set(H(proAdmin, proT))).status).toBe(403);

    const run = await request(app).post('/api/billing/admin/run').set(H(superadmin, otherT)).send({ job: 'invoices', period: '2026-08', send: false });
    expect(run.status).toBe(200);
    expect(run.body.data.invoices.created).toEqual([]);     // already issued
    expect((await request(app).post('/api/billing/admin/run').set(H(superadmin, otherT)).send({ job: 'invoices', period: '13-2026' })).status).toBe(400);

    const put = await request(app).put('/api/billing/admin/settings').set(H(superadmin, otherT))
      .send({ seller_name: 'ФОП Теплюк', seller_iban: 'UA213223130000026007233566001', due_days: 10, invoice_note: 'Без ПДВ' });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ seller_name: 'ФОП Теплюк', due_days: 10, invoice_note: 'Без ПДВ' });
    expect((await request(app).put('/api/billing/admin/settings').set(H(proAdmin, proT)).send({ due_days: 5 })).status).toBe(403);
    // an organisation's admin sees the requisites to pay to
    const s = await request(app).get('/api/billing/summary').set(H(proAdmin, proT));
    expect(s.body.data.seller).toMatchObject({ seller_iban: 'UA213223130000026007233566001', seller_name: 'ФОП Теплюк' });
  });

  it('plan change: the admin asks, one pending at a time, the superadmin approves and the plan changes', async () => {
    expect((await request(app).post('/api/billing/plan-request').set(H(proAdmin, proT)).send({ plan: 'pro' })).status).toBe(400);
    expect((await request(app).post('/api/billing/plan-request').set(H(proAdmin, proT)).send({ plan: 'nope' })).status).toBe(400);
    const req1 = await request(app).post('/api/billing/plan-request').set(H(proAdmin, proT)).send({ plan: 'basic', message: 'Менше точок' });
    expect(req1.status).toBe(201);
    expect(req1.body.data).toMatchObject({ current_plan: 'pro', requested_plan: 'basic', status: 'pending' });
    expect((await request(app).post('/api/billing/plan-request').set(H(proAdmin, proT)).send({ plan: 'enterprise' })).status).toBe(409);

    const pending = await request(app).get('/api/billing/admin/plan-requests').set(H(superadmin, otherT));
    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0]).toMatchObject({ tenant_slug: 'bill-pro', requested_plan: 'basic', requested_by_email: 'admin@bill-pro.test' });

    const ok = await request(app).post(`/api/billing/admin/plan-requests/${req1.body.data.id}/approve`).set(H(superadmin, otherT)).send({ note: 'ok' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'approved', resolution_note: 'ok' });
    const { rows } = await db.query('SELECT plan FROM tenants WHERE id = $1', [proT.id]);
    expect(rows[0].plan).toBe('basic');
    const s = await request(app).get('/api/billing/summary').set(H(proAdmin, proT));
    expect(s.body.data.tenant.plan).toBe('basic');
    expect(s.body.data.plan_request).toBeNull();

    // cancel a pending one
    await request(app).post('/api/billing/plan-request').set(H(proAdmin, proT)).send({ plan: 'pro' });
    expect((await request(app).delete('/api/billing/plan-request').set(H(proAdmin, proT))).status).toBe(200);
    expect((await request(app).delete('/api/billing/plan-request').set(H(proAdmin, proT))).status).toBe(404);
  });

  it('identity: the admin keeps the organisation’s legal name, tax id and billing e-mail', async () => {
    const res = await request(app).patch('/api/billing/identity').set(H(proAdmin, proT)).send({ legal_name: 'ТОВ Мережа Про Плюс', billing_email: '' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ legal_name: 'ТОВ Мережа Про Плюс', billing_email: null });
    expect((await request(app).patch('/api/billing/identity').set(H(proAdmin, proT)).send({})).status).toBe(400);
    // recipients fall back to the organisation's admins when billing_email is empty
    const rec = await billing.__test.recipientsOf(proT.id);
    expect(rec.to).toEqual(['admin@bill-pro.test']);
  });
});
