'use strict';

/**
 * Billing without card payments (plan epic 2.2).
 *
 * Three jobs, all idempotent, run by one hourly timer and callable by hand
 * from the superadmin page (POST /api/billing/admin/run):
 *
 *   snapshotAll      — usage_snapshots for yesterday and today, per open
 *                      organisation (active controllers, sites, users,
 *                      telemetry rows from the hourly archive, notifications).
 *   generateInvoices — on or after the 1st, one invoice per payer for the
 *                      previous calendar month from the snapshots × plan
 *                      prices; a partner gets one consolidated invoice with a
 *                      line per client (tenants.parent_tenant_id).
 *   runDunning       — issued invoices past due: day 7 → organisation
 *                      past_due + e-mail, day 14 → reminder, day 21 →
 *                      suspended. Payment (markPaid) restores the status.
 *
 * Quantities are per-day averages over the period ("device-days / days in
 * the month"), so an organisation that joined on the 20th pays a third of a
 * month and a controller that was active for a week costs a quarter. The
 * base fee is prorated by the days the organisation existed in the period.
 *
 * Prices are plan_limits.price_*_uah (UAH, without VAT) with the volume tiers
 * of price_tiers_uah; a plan with no prices (enterprise) or an amount of zero
 * (free) never produces an invoice.
 */

const db       = require('./db');
const planMw   = require('../middleware/plan');
const emailSvc = require('./email');
const pdfSvc   = require('./invoice-pdf');
const { pickLocale } = require('../lib/locale');

let logger = null;
let poller = null;
let bootTimer = null;
let running = false;

const BOOT_DELAY_MS  = 90_000;
const BOOT_JITTER_MS = 30_000;

const BILLABLE_STATUSES = ['active', 'past_due'];
const OPEN_STATUSES     = ['trial', 'active', 'past_due'];

function log() {
  if (!logger) logger = require('pino')({ level: process.env.LOG_LEVEL || 'info' }).child({ svc: 'billing' });
  return logger;
}

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

/** Dunning schedule in days after the due date. */
function dunningDays() {
  return {
    past_due: envInt('BILLING_PAST_DUE_DAYS', 7),
    reminder: envInt('BILLING_REMINDER_DAYS', 14),
    suspend:  envInt('BILLING_SUSPEND_DAYS', 21),
  };
}

// ── Date helpers (UTC calendar days) ──────────────────────

function dayStr(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayStr(d);
}
function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}
function monthStart(d) { return `${d.toISOString().slice(0, 7)}-01`; }

/** The calendar month before `now`: { start, end (exclusive), days }. */
function previousPeriod(now = new Date()) {
  const thisMonth = monthStart(now);
  const prev = new Date(`${thisMonth}T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const start = dayStr(prev);
  return { start, end: thisMonth, days: daysBetween(start, thisMonth) };
}

/** The calendar month containing `now` (for the live estimate). */
function currentPeriod(now = new Date()) {
  const start = monthStart(now);
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = dayStr(next);
  return { start, end, days: daysBetween(start, end) };
}

/** 'YYYY-MM' → period; null when malformed. */
function periodFromString(s) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s || '')) return null;
  const start = `${s}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = dayStr(next);
  return { start, end, days: daysBetween(start, end) };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── Usage snapshots ───────────────────────────────────────

const SNAPSHOT_SQL = `
  INSERT INTO usage_snapshots (tenant_id, day, active_devices, sites, users, telemetry_rows, notifications_sent, taken_at)
  SELECT t.id, $1::date,
         (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL),
         (SELECT COUNT(*) FROM sites s WHERE s.tenant_id = t.id),
         (SELECT COUNT(*) FROM user_tenants ut JOIN users u ON u.id = ut.user_id
           WHERE ut.tenant_id = t.id AND u.active = true AND u.role <> 'superadmin'),
         (SELECT COALESCE(SUM(h.samples), 0) FROM telemetry_hourly h
           WHERE h.tenant_id = t.id AND h.hour >= $1::date AND h.hour < ($1::date + 1)),
         (SELECT COUNT(*) FROM notification_log n
           WHERE n.tenant_id = t.id AND n.status = 'sent' AND n.created_at >= $1::date AND n.created_at < ($1::date + 1)),
         $2
    FROM tenants t
   WHERE t.id <> $3 AND t.status = ANY($4::text[])
  ON CONFLICT (tenant_id, day) DO UPDATE
     SET active_devices = EXCLUDED.active_devices, sites = EXCLUDED.sites, users = EXCLUDED.users,
         telemetry_rows = EXCLUDED.telemetry_rows, notifications_sent = EXCLUDED.notifications_sent,
         taken_at = EXCLUDED.taken_at`;

/**
 * Upsert the snapshot of today and of yesterday for every open organisation.
 * Today is refreshed on every run; yesterday gets its final values (the
 * hourly telemetry archive is filled by the retention job after midnight).
 */
async function snapshotAll({ now = new Date() } = {}) {
  const today = dayStr(now);
  const yesterday = addDays(today, -1);
  let rows = 0;
  for (const day of [yesterday, today]) {
    const r = await db.query(SNAPSHOT_SQL, [day, now, db.SYSTEM_TENANT_ID, OPEN_STATUSES]);
    rows += r.rowCount;
  }
  return { days: [yesterday, today], rows };
}

// ── Pricing ───────────────────────────────────────────────

async function loadPlans() {
  const { rows } = await db.query(
    `SELECT plan, name, price_base_uah, price_controller_uah, price_site_uah, price_tiers_uah FROM plan_limits`);
  return Object.fromEntries(rows.map(p => [p.plan, p]));
}

async function loadSettings() {
  const { rows } = await db.query('SELECT * FROM billing_settings WHERE id = 1');
  return rows[0] || { due_days: 14 };
}

/** Per-controller price for `qty` controllers: the highest tier reached, else the list price. */
function tierPrice(plan, qty) {
  let price = plan.price_controller_uah;
  const tiers = Array.isArray(plan.price_tiers_uah) ? plan.price_tiers_uah : [];
  for (const t of [...tiers].sort((a, b) => a.from - b.from)) {
    if (qty >= Number(t.from)) price = Number(t.price);
  }
  return price;
}

/** true when the plan has any price at all (enterprise has none — billed by contract). */
function hasPrices(plan) {
  return plan && [plan.price_base_uah, plan.price_controller_uah, plan.price_site_uah].some(v => v !== null && v !== undefined);
}

/**
 * Build the lines of one invoice.
 * @param {object} p
 * @param {object} p.payer     tenant row of the payer (plan, name, created_at)
 * @param {object[]} p.members every organisation covered (the payer first); each { id, name, created_at }
 * @param {object} p.usage     tenantId → { devices, sites } as per-day averages (already rounded)
 * @param {object} p.plans     plan catalogue
 * @param {object} p.period    { start, end, days }
 */
function buildLines({ payer, members, usage, plans, period }) {
  const plan = plans[payer.plan];
  if (!hasPrices(plan)) return [];
  const lines = [];

  // Base fee, prorated by the days the payer existed in the period
  if (plan.price_base_uah) {
    const created = payer.created_at ? dayStr(new Date(payer.created_at)) : period.start;
    const from = created > period.start ? created : period.start;
    const covered = Math.max(0, Math.min(period.days, daysBetween(from, period.end)));
    if (covered > 0) {
      const qty = round2(covered / period.days);
      lines.push({ kind: 'base', tenant_id: payer.id, tenant_name: payer.name, plan: payer.plan, plan_name: plan.name,
        qty, unit_price: plan.price_base_uah, amount: round2(qty * plan.price_base_uah) });
    }
  }

  // Controllers: one line per organisation, priced by the tier the total reaches
  if (plan.price_controller_uah !== null && plan.price_controller_uah !== undefined) {
    const total = members.reduce((s, m) => s + ((usage[m.id] || {}).devices || 0), 0);
    const unit = tierPrice(plan, total);
    for (const m of members) {
      const qty = (usage[m.id] || {}).devices || 0;
      if (qty > 0) lines.push({ kind: 'controllers', tenant_id: m.id, tenant_name: m.name, qty, unit_price: unit, amount: round2(qty * unit) });
    }
  }

  // Sites
  if (plan.price_site_uah) {
    for (const m of members) {
      const qty = (usage[m.id] || {}).sites || 0;
      if (qty > 0) lines.push({ kind: 'sites', tenant_id: m.id, tenant_name: m.name, qty, unit_price: plan.price_site_uah, amount: round2(qty * plan.price_site_uah) });
    }
  }
  return lines;
}

const sumLines = (lines) => round2(lines.reduce((s, l) => s + Number(l.amount), 0));

// ── Payer groups ──────────────────────────────────────────

/**
 * Who pays for whom. Returns [{ payer, members, account }] over every
 * billable organisation: a client (tenants.parent_tenant_id) is billed to its
 * partner, so the partner's group is the partner plus its clients; everyone
 * else pays for itself. The payer's billing account, when it has one, is the
 * legal identity printed on the invoice.
 */
async function payerGroups({ tenantIds = null } = {}) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.slug, t.plan, t.status, t.created_at, t.parent_tenant_id, t.billing_account_id,
            t.legal_name, t.tax_id, t.billing_email, t.billing_currency,
            ba.is_partner, ba.legal_name AS account_legal_name, ba.tax_id AS account_tax_id, ba.email AS account_email,
            ba.currency AS account_currency
       FROM tenants t
       LEFT JOIN billing_accounts ba ON ba.id = t.billing_account_id
      WHERE t.id <> $1
        AND (t.status = ANY($2::text[])
             OR t.id IN (SELECT c.parent_tenant_id FROM tenants c WHERE c.parent_tenant_id IS NOT NULL AND c.status = ANY($2::text[])))
        AND ($3::uuid[] IS NULL OR t.id = ANY($3::uuid[]) OR t.parent_tenant_id = ANY($3::uuid[]))
      ORDER BY t.parent_tenant_id NULLS FIRST, t.name, t.created_at`,
    [db.SYSTEM_TENANT_ID, BILLABLE_STATUSES, tenantIds]);

  const groups = new Map();
  for (const t of rows) {
    const key = t.parent_tenant_id || t.id;
    if (!groups.has(key)) groups.set(key, { payer: null, members: [], account: null });
    const g = groups.get(key);
    if (t.id === key) g.payer = t; else g.members.push(t);
  }
  const out = [];
  for (const g of groups.values()) {
    // A partner outside the billable statuses is not invoiced, and neither are
    // its clients through it (the superadmin suspended the partner by hand).
    if (!g.payer || !BILLABLE_STATUSES.includes(g.payer.status)) continue;
    const p = g.payer;
    if (p.billing_account_id) g.account = { id: p.billing_account_id, legal_name: p.account_legal_name, tax_id: p.account_tax_id, email: p.account_email, currency: p.account_currency };
    g.members = [p, ...g.members.filter(m => BILLABLE_STATUSES.includes(m.status))];
    out.push(g);
  }
  return out;
}

/** Per-day averages of the snapshots over the period, rounded to whole units. */
async function usageFor(tenantIds, period) {
  const { rows } = await db.query(
    `SELECT tenant_id, SUM(active_devices)::float AS device_days, SUM(sites)::float AS site_days, COUNT(*)::int AS days
       FROM usage_snapshots WHERE tenant_id = ANY($1::uuid[]) AND day >= $2::date AND day < $3::date
      GROUP BY tenant_id`,
    [tenantIds, period.start, period.end]);
  const usage = {};
  for (const r of rows) {
    usage[r.tenant_id] = {
      devices: Math.round(r.device_days / period.days),
      sites:   Math.round(r.site_days / period.days),
      days:    r.days,
    };
  }
  return usage;
}

/** Live counts (for the month-to-date estimate and as a fallback when no snapshot exists). */
async function liveUsage(tenantIds) {
  const { rows } = await db.query(
    `SELECT t.id AS tenant_id,
            (SELECT COUNT(*)::int FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active' AND d.deleted_at IS NULL) AS devices,
            (SELECT COUNT(*)::int FROM sites s WHERE s.tenant_id = t.id) AS sites,
            (SELECT COUNT(*)::int FROM user_tenants ut JOIN users u ON u.id = ut.user_id
              WHERE ut.tenant_id = t.id AND u.active = true AND u.role <> 'superadmin') AS users
       FROM tenants t WHERE t.id = ANY($1::uuid[])`, [tenantIds]);
  return Object.fromEntries(rows.map(r => [r.tenant_id, r]));
}

// ── Invoices ──────────────────────────────────────────────

function buyerOf(group) {
  const p = group.payer, a = group.account || {};
  return {
    legal_name: a.legal_name || p.legal_name || p.name,
    tax_id:     a.tax_id || p.tax_id || null,
    email:      p.billing_email || a.email || null,
  };
}

async function nextNumber(client) {
  const { rows } = await client.query(`SELECT nextval('invoice_number_seq') AS n`);
  return `MC-${String(rows[0].n).padStart(6, '0')}`;
}

/**
 * Generate the invoices of a period (default: the previous calendar month)
 * for every payer that has none yet. Returns the created invoices.
 */
async function generateInvoices({ now = new Date(), period = null, tenantIds = null, createdBy = null, send = true } = {}) {
  const p = period || previousPeriod(now);
  if (p.end > dayStr(now)) return { period: p, created: [], skipped: 'period_not_over' };
  const [plans, settings, groups] = await Promise.all([loadPlans(), loadSettings(), payerGroups({ tenantIds })]);
  const allIds = groups.flatMap(g => g.members.map(m => m.id));
  const usage = allIds.length ? await usageFor(allIds, p) : {};
  const created = [];

  for (const g of groups) {
    // Organisations that never had a snapshot in the period (billing enabled
    // mid-month) are charged for what they run now, for the whole month — the
    // safer direction is not to invent history, so this only applies when the
    // organisation existed before the period ended.
    const missing = g.members.filter(m => !usage[m.id]);
    if (missing.length) {
      const live = await liveUsage(missing.map(m => m.id));
      for (const m of missing) usage[m.id] = { devices: live[m.id]?.devices || 0, sites: live[m.id]?.sites || 0, days: 0, live: true };
    }
    const lines = buildLines({ payer: g.payer, members: g.members, usage, plans, period: p });
    const amount = sumLines(lines);
    if (amount <= 0) continue;

    const dueDays = settings.due_days || 14;
    const dueAt = new Date(now.getTime() + dueDays * 86_400_000);
    try {
      const invoice = await db.transaction(async (client) => {
        const { rows: exists } = await client.query(
          'SELECT 1 FROM invoices WHERE tenant_id = $1 AND period_start = $2::date', [g.payer.id, p.start]);
        if (exists.length) return null;
        const number = await nextNumber(client);
        const { rows } = await client.query(
          `INSERT INTO invoices (number, tenant_id, billing_account_id, period_start, period_end, lines, amount, currency,
                                 status, issued_at, due_at, buyer, created_by)
           VALUES ($1, $2, $3, $4::date, $5::date, $6::jsonb, $7, $8, 'issued', $9, $10, $11::jsonb, $12)
           RETURNING *`,
          [number, g.payer.id, g.account ? g.account.id : null, p.start, p.end, JSON.stringify(lines), amount,
           (g.account && g.account.currency) || g.payer.billing_currency || 'UAH', now, dueAt, JSON.stringify(buyerOf(g)), createdBy]);
        return rows[0];
      });
      if (!invoice) continue;
      created.push(invoice);
      log().info({ number: invoice.number, tenant: g.payer.slug, amount }, 'Invoice issued');
      if (send) await sendInvoiceEmail(invoice).catch(err => log().warn({ err, number: invoice.number }, 'Invoice e-mail failed'));
    } catch (err) {
      log().error({ err, tenant: g.payer.slug }, 'Invoice generation failed');
    }
  }
  return { period: p, created };
}

/** Month-to-date estimate for one organisation from live counts (the "Оплата" page). */
async function estimate(tenantId, { now = new Date() } = {}) {
  const [plans, groups] = await Promise.all([loadPlans(), payerGroups({ tenantIds: null })]);
  const group = groups.find(g => g.members.some(m => m.id === tenantId));
  if (!group) return null;
  const period = currentPeriod(now);
  const live = await liveUsage(group.members.map(m => m.id));
  const usage = Object.fromEntries(group.members.map(m => [m.id, { devices: live[m.id]?.devices || 0, sites: live[m.id]?.sites || 0 }]));
  const lines = buildLines({ payer: group.payer, members: group.members, usage, plans, period });
  return {
    period, payer: { id: group.payer.id, name: group.payer.name, plan: group.payer.plan },
    billed_via_partner: group.payer.id !== tenantId,
    members: group.members.map(m => ({ id: m.id, name: m.name, ...(live[m.id] || {}) })),
    lines, amount: sumLines(lines),
    currency: (group.account && group.account.currency) || group.payer.billing_currency || 'UAH',
  };
}

// ── E-mail ────────────────────────────────────────────────

/** billing_email of the payer, else the account's e-mail, else every admin of the payer. */
async function recipientsOf(tenantId) {
  const { rows } = await db.query(
    `SELECT t.billing_email, ba.email AS account_email, COALESCE(s.locale, 'uk') AS locale, t.name
       FROM tenants t LEFT JOIN billing_accounts ba ON ba.id = t.billing_account_id
       LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  const t = rows[0];
  if (!t) return { to: [], lang: 'uk', tenantName: '' };
  let to = [t.billing_email || t.account_email].filter(Boolean);
  if (to.length === 0) {
    const { rows: admins } = await db.query(
      `SELECT DISTINCT u.email FROM users u
         LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $1
        WHERE u.active = true AND u.role <> 'superadmin'
          AND (ut.role = 'admin' OR (u.tenant_id = $1 AND u.role = 'admin' AND ut.user_id IS NULL))`, [tenantId]);
    to = admins.map(a => a.email);
  }
  return { to, lang: pickLocale(t.locale), tenantName: t.name };
}

async function sendInvoiceEmail(invoice) {
  if (!emailSvc.isConfigured()) return false;
  const { to, lang, tenantName } = await recipientsOf(invoice.tenant_id);
  if (to.length === 0) return false;
  const seller = await loadSettings();
  const pdf = await pdfSvc.render({ invoice, seller, lang });
  const ok = await emailSvc.sendInvoice({ to, lang, invoice, seller, tenantName, pdf });
  if (ok) await db.query('UPDATE invoices SET sent_at = now(), updated_at = now() WHERE id = $1', [invoice.id]);
  return ok;
}

async function sendDunningEmail(invoice, stage) {
  if (!emailSvc.isConfigured()) return false;
  const { to, lang, tenantName } = await recipientsOf(invoice.tenant_id);
  if (to.length === 0) return false;
  const seller = await loadSettings();
  return emailSvc.sendDunning({ to, lang, invoice, seller, tenantName, stage });
}

// ── Dunning ───────────────────────────────────────────────

/** Every organisation an invoice covers: the payer and the clients in its lines. */
function coveredTenants(invoice) {
  const ids = new Set([invoice.tenant_id]);
  for (const l of (Array.isArray(invoice.lines) ? invoice.lines : [])) if (l.tenant_id) ids.add(l.tenant_id);
  return [...ids];
}

async function setStatus(tenantIds, status, fromStatuses) {
  const { rows } = await db.query(
    `UPDATE tenants SET status = $2 WHERE id = ANY($1::uuid[]) AND status = ANY($3::text[]) RETURNING id, slug`,
    [tenantIds, status, fromStatuses]);
  for (const r of rows) planMw.invalidate(r.id);
  if (rows.length) {
    try { await require('./mqtt').refreshRegistries(); } catch (err) { log().warn({ err }, 'Broker registry refresh failed'); }
  }
  return rows;
}

/**
 * Walk every overdue invoice and apply the stage its age has reached.
 * Stages are applied once each (dunning_stage), so a run every hour sends
 * each reminder exactly once.
 */
async function runDunning({ now = new Date() } = {}) {
  const D = dunningDays();
  const { rows } = await db.query(
    `SELECT i.* FROM invoices i WHERE i.status = 'issued' AND i.due_at < $1 ORDER BY i.due_at`, [now]);
  const report = { past_due: [], reminded: [], suspended: [] };
  for (const inv of rows) {
    const overdue = Math.floor((now - new Date(inv.due_at)) / 86_400_000);
    const target = overdue >= D.suspend ? 3 : overdue >= D.reminder ? 2 : overdue >= D.past_due ? 1 : 0;
    if (target <= inv.dunning_stage) continue;
    const tenants = coveredTenants(inv);
    try {
      if (target === 1) {
        await setStatus(tenants, 'past_due', ['active', 'trial']);
        report.past_due.push(inv.number);
      } else if (target === 2) {
        if (inv.dunning_stage < 1) await setStatus(tenants, 'past_due', ['active', 'trial']);
        report.reminded.push(inv.number);
      } else {
        await setStatus(tenants, 'suspended', ['active', 'trial', 'past_due']);
        report.suspended.push(inv.number);
      }
      await db.query('UPDATE invoices SET dunning_stage = $2, dunning_at = $3, updated_at = now() WHERE id = $1', [inv.id, target, now]);
      await sendDunningEmail({ ...inv, dunning_stage: target }, target).catch(err => log().warn({ err, number: inv.number }, 'Dunning e-mail failed'));
      log().info({ number: inv.number, stage: target, overdue }, 'Dunning applied');
    } catch (err) {
      log().error({ err, number: inv.number }, 'Dunning failed');
    }
  }
  return report;
}

/**
 * Payment received (or the invoice voided): the organisations the invoice
 * covers come back to `active` when billing was what held them — past_due,
 * or suspended by this invoice's own day-21 stage — and no other overdue
 * invoice of the payer is still open.
 */
async function restoreAfterSettlement(invoice) {
  const { rows: others } = await db.query(
    `SELECT 1 FROM invoices WHERE tenant_id = $1 AND status = 'issued' AND dunning_stage >= 1 AND id <> $2 LIMIT 1`,
    [invoice.tenant_id, invoice.id]);
  if (others.length) return [];
  const tenants = coveredTenants(invoice);
  const from = invoice.dunning_stage >= 3 ? ['past_due', 'suspended'] : ['past_due'];
  return setStatus(tenants, 'active', from);
}

async function markPaid(invoiceId, { paidAt = new Date(), note = null } = {}) {
  const { rows } = await db.query(
    `UPDATE invoices SET status = 'paid', paid_at = $2, paid_note = $3, updated_at = now()
      WHERE id = $1 AND status = 'issued' RETURNING *`, [invoiceId, paidAt, note]);
  if (!rows[0]) return null;
  const restored = await restoreAfterSettlement(rows[0]);
  return { invoice: rows[0], restored };
}

async function voidInvoice(invoiceId, { note = null } = {}) {
  const { rows } = await db.query(
    `UPDATE invoices SET status = 'void', voided_at = now(), paid_note = $2, updated_at = now()
      WHERE id = $1 AND status = 'issued' RETURNING *`, [invoiceId, note]);
  if (!rows[0]) return null;
  const restored = await restoreAfterSettlement(rows[0]);
  return { invoice: rows[0], restored };
}

// ── Lifecycle ─────────────────────────────────────────────

async function runOnce({ now = new Date() } = {}) {
  if (running) return null;
  running = true;
  const out = {};
  try {
    out.snapshot = await snapshotAll({ now });
    out.invoices = await generateInvoices({ now });
    out.dunning  = await runDunning({ now });
    log().info({ snapshots: out.snapshot.rows, invoices: out.invoices.created.length,
      dunning: Object.fromEntries(Object.entries(out.dunning).map(([k, v]) => [k, v.length])) }, 'Billing run');
  } catch (err) {
    log().error({ err }, 'Billing run failed');
  } finally {
    running = false;
  }
  return out;
}

function start(log_) {
  if (log_) logger = log_.child({ svc: 'billing' });
  const intervalMin = envInt('BILLING_INTERVAL_MIN', 60);
  if (intervalMin <= 0) { log().info('Billing: disabled (BILLING_INTERVAL_MIN=0)'); return; }
  if (bootTimer || poller) return;
  const bootDelayMs = BOOT_DELAY_MS + Math.floor(Math.random() * BOOT_JITTER_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runOnce();
    poller = setInterval(() => runOnce(), intervalMin * 60_000);
    if (poller.unref) poller.unref();
  }, bootDelayMs);
  if (bootTimer.unref) bootTimer.unref();
  log().info({ intervalMin, bootDelayMs, dunning: dunningDays() }, 'Billing started');
}

/** Must stay in the index.js shutdown() list. */
function shutdown() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (poller)    { clearInterval(poller);   poller = null; }
}

module.exports = {
  start, shutdown, runOnce,
  snapshotAll, generateInvoices, runDunning, markPaid, voidInvoice, estimate,
  sendInvoiceEmail, loadSettings, loadPlans, payerGroups,
  previousPeriod, currentPeriod, periodFromString, dunningDays,
  BILLABLE_STATUSES,
  __test: { buildLines, tierPrice, usageFor, recipientsOf, coveredTenants, setLogger(l) { logger = l; } },
};
