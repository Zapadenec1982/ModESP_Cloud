<script>
  // Billing ledger for the superadmin (plan epic 2.2): every invoice with
  // "paid" / "void" / "send" actions, the jobs run by hand (usage snapshot,
  // invoices for a period, dunning), plan-change requests to approve or
  // reject, and the seller's requisites printed on each invoice.
  import { onMount } from 'svelte'
  import { adminGetInvoices, adminPayInvoice, adminVoidInvoice, adminSendInvoice, adminRunBilling,
           adminGetBillingSettings, adminSaveBillingSettings, adminGetPlanRequests, adminResolvePlanRequest,
           downloadInvoicePdf } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let loading = true
  let error = null
  let invoices = []
  let requests = []
  let settings = {}
  let filter = ''

  async function load() {
    loading = true
    try {
      const [inv, rq, st] = await Promise.all([adminGetInvoices({ status: filter }), adminGetPlanRequests('pending'), adminGetBillingSettings()])
      invoices = inv; requests = rq; settings = { ...st, due_days: st.due_days ?? 14 }
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
  onMount(load)
  async function reloadInvoices() { try { invoices = await adminGetInvoices({ status: filter }) } catch (e) { toast.error(e.message) } }

  $: code = $t('time.locale_code')
  function money(v, currency = 'UAH') {
    try { return new Intl.NumberFormat(code, { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(v) || 0) }
    catch { return `${Number(v || 0).toFixed(2)} ${currency}` }
  }
  const day = (v) => v ? new Date(v).toLocaleDateString(code, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '—'
  const month = (v) => new Date(v).toLocaleDateString(code, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const invoiceStatus = (i) => i.status === 'issued' && i.overdue ? 'overdue' : i.status
  const statusVariant = (s) => s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : s === 'void' ? 'neutral' : 'info'

  // ── jobs ──
  let period = ''
  let running = ''
  async function run(job) {
    running = job
    try {
      const out = await adminRunBilling({ job, period: job === 'invoices' && period ? period : undefined, send: true })
      const parts = []
      if (out.snapshot) parts.push(`${$t('billing.admin_run_snapshot')}: ${out.snapshot.rows}`)
      if (out.invoices) parts.push(`${$t('billing.admin_run_invoices')}: ${out.invoices.created.length}${out.invoices.skipped ? ' (' + out.invoices.skipped + ')' : ''}`)
      if (out.dunning) parts.push(`${$t('billing.admin_run_dunning')}: ${out.dunning.past_due.length}/${out.dunning.reminded.length}/${out.dunning.suspended.length}`)
      toast.success($t('billing.admin_ran').replace('{0}', parts.join(' · ')))
      await load()
    } catch (e) { toast.error(e.message) } finally { running = '' }
  }

  // ── invoice actions ──
  let busy = null
  async function pay(i) {
    const note = window.prompt($t('billing.admin_pay_note'), '')
    if (note === null) return
    busy = i.id
    try {
      const r = await adminPayInvoice(i.id, note.trim())
      toast.success($t('billing.admin_paid_ok').replace('{0}', i.number))
      if (r.restored && r.restored.length) toast.info($t('billing.admin_restored').replace('{0}', r.restored.map(t => t.slug).join(', ')))
      await reloadInvoices()
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }
  async function annul(i) {
    if (!window.confirm($t('billing.admin_void_confirm').replace('{0}', i.number))) return
    busy = i.id
    try {
      await adminVoidInvoice(i.id, '')
      toast.success($t('billing.admin_void_ok').replace('{0}', i.number))
      await reloadInvoices()
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }
  async function send(i) {
    busy = i.id
    try {
      await adminSendInvoice(i.id)
      toast.success($t('billing.admin_sent_ok'))
      await reloadInvoices()
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }
  async function pdf(i) { try { await downloadInvoicePdf(i.id, i.number) } catch (e) { toast.error(e.message) } }

  // ── plan requests ──
  async function resolve(r, decision) {
    const note = window.prompt($t('billing.admin_request_note'), '')
    if (note === null) return
    busy = r.id
    try {
      await adminResolvePlanRequest(r.id, decision, note.trim())
      toast.success($t('billing.admin_request_done').replace('{0}', $t('billing.request_' + decision)))
      requests = await adminGetPlanRequests('pending')
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }

  // ── settings ──
  let savingSettings = false
  async function saveSettings() {
    savingSettings = true
    try {
      const body = {}
      for (const k of ['seller_name', 'seller_tax_id', 'seller_iban', 'seller_bank', 'seller_address', 'seller_email', 'invoice_note']) body[k] = (settings[k] || '').trim() || null
      body.due_days = Number(settings.due_days) || 14
      settings = { ...(await adminSaveBillingSettings(body)) }
      toast.success($t('billing.settings_saved'))
    } catch (e) { toast.error(e.message) } finally { savingSettings = false }
  }
</script>

<div class="billing-admin">
  <PageHeader title={$t('pages.billing_admin')} subtitle={$t('pages.billing_admin_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="320px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else}
    <!-- Jobs -->
    <section class="card">
      <div class="card-head"><h2><Icon name="clock" size={18} /> {$t('billing.admin_jobs_title')}</h2></div>
      <div class="jobs">
        <Button size="sm" variant="secondary" disabled={!!running} on:click={() => run('snapshot')}>{$t('billing.admin_run_snapshot')}</Button>
        <span class="job">
          <input type="text" placeholder="2026-08" bind:value={period} maxlength="7" aria-label={$t('billing.admin_period')} />
          <Button size="sm" variant="secondary" disabled={!!running} on:click={() => run('invoices')}>{$t('billing.admin_run_invoices')}</Button>
        </span>
        <Button size="sm" variant="secondary" disabled={!!running} on:click={() => run('dunning')}>{$t('billing.admin_run_dunning')}</Button>
      </div>
      <p class="muted small">{$t('billing.admin_jobs_hint')}</p>
    </section>

    <!-- Invoices -->
    <section class="card">
      <div class="card-head"><h2><Icon name="clipboard" size={18} /> {$t('billing.invoices_title')}</h2><span class="count">{invoices.length}</span>
        <select class="filter" bind:value={filter} on:change={reloadInvoices}>
          <option value="">{$t('billing.admin_filter_all')}</option>
          {#each ['issued', 'overdue', 'paid', 'void'] as s}<option value={s}>{$t('billing.status_' + s)}</option>{/each}
        </select>
      </div>
      {#if invoices.length === 0}
        <p class="muted">{$t('billing.no_invoices')}</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>{$t('billing.col_number')}</th><th>{$t('billing.col_tenant')}</th><th>{$t('billing.col_period')}</th>
              <th class="num">{$t('billing.col_amount')}</th><th>{$t('billing.col_due')}</th><th>{$t('billing.col_status')}</th>
              <th>{$t('billing.col_dunning')}</th><th>{$t('billing.col_sent')}</th><th></th>
            </tr></thead>
            <tbody>
              {#each invoices as i (i.id)}
                <tr>
                  <td><code>{i.number}</code></td>
                  <td><strong>{i.tenant_name}</strong><div class="muted small">{i.tenant_slug} · {$t('tenants.status_' + i.tenant_status)}</div></td>
                  <td>{month(i.period_start)}</td>
                  <td class="num">{money(i.amount, i.currency)}</td>
                  <td>{day(i.due_at)}</td>
                  <td><Badge size="sm" variant={statusVariant(invoiceStatus(i))}>{$t('billing.status_' + invoiceStatus(i))}</Badge>
                    {#if i.paid_at}<div class="muted small">{day(i.paid_at)}{i.paid_note ? ' · ' + i.paid_note : ''}</div>{/if}</td>
                  <td class="small">{$t('billing.dunning_' + i.dunning_stage)}</td>
                  <td class="small">{i.sent_at ? day(i.sent_at) : '—'}</td>
                  <td class="actions">
                    <Button size="sm" variant="ghost" icon="download" on:click={() => pdf(i)}>{$t('billing.pdf')}</Button>
                    {#if i.status === 'issued'}
                      <Button size="sm" variant="ghost" icon="send" disabled={busy === i.id} on:click={() => send(i)}>{$t('billing.admin_send')}</Button>
                      <Button size="sm" variant="primary" icon="check" disabled={busy === i.id} on:click={() => pay(i)}>{$t('billing.admin_pay')}</Button>
                      <Button size="sm" variant="ghost" disabled={busy === i.id} on:click={() => annul(i)}>{$t('billing.admin_void')}</Button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <div class="two-col">
      <!-- Plan requests -->
      <section class="card">
        <div class="card-head"><h2><Icon name="shield" size={18} /> {$t('billing.admin_requests_title')}</h2><span class="count">{requests.length}</span></div>
        {#if requests.length === 0}
          <p class="muted">{$t('billing.admin_no_requests')}</p>
        {:else}
          <ul class="list">
            {#each requests as r (r.id)}
              <li class="row">
                <div class="row-main">
                  <span class="row-title">{r.tenant_name} · {$t('tenants.plan_' + r.current_plan)} → <strong>{$t('tenants.plan_' + r.requested_plan)}</strong></span>
                  <span class="muted small">{r.requested_by_email || '—'} · {day(r.created_at)}{r.message ? ' · ' + r.message : ''}</span>
                </div>
                <Button size="sm" variant="primary" disabled={busy === r.id} on:click={() => resolve(r, 'approve')}>{$t('billing.admin_approve')}</Button>
                <Button size="sm" variant="ghost" disabled={busy === r.id} on:click={() => resolve(r, 'reject')}>{$t('billing.admin_reject')}</Button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Seller requisites -->
      <section class="card">
        <div class="card-head"><h2><Icon name="credit-card" size={18} /> {$t('billing.admin_settings_title')}</h2></div>
        <p class="muted small">{$t('billing.admin_settings_hint')}</p>
        <div class="form-grid">
          <div class="form-group"><label for="s-name">{$t('billing.seller_name')}</label><input id="s-name" type="text" bind:value={settings.seller_name} maxlength="256" /></div>
          <div class="form-group"><label for="s-tax">{$t('billing.tax_id')}</label><input id="s-tax" type="text" bind:value={settings.seller_tax_id} maxlength="32" /></div>
          <div class="form-group"><label for="s-iban">{$t('billing.iban')}</label><input id="s-iban" type="text" bind:value={settings.seller_iban} maxlength="64" /></div>
          <div class="form-group"><label for="s-bank">{$t('billing.seller_bank')}</label><input id="s-bank" type="text" bind:value={settings.seller_bank} maxlength="128" /></div>
          <div class="form-group"><label for="s-addr">{$t('billing.seller_address')}</label><input id="s-addr" type="text" bind:value={settings.seller_address} maxlength="256" /></div>
          <div class="form-group"><label for="s-email">{$t('billing.seller_email')}</label><input id="s-email" type="email" bind:value={settings.seller_email} maxlength="256" /></div>
          <div class="form-group"><label for="s-due">{$t('billing.due_days')}</label><input id="s-due" type="number" min="1" max="90" bind:value={settings.due_days} /></div>
          <div class="form-group wide"><label for="s-note">{$t('billing.invoice_note')}</label><input id="s-note" type="text" bind:value={settings.invoice_note} maxlength="2000" /></div>
        </div>
        <div class="card-actions"><Button size="sm" variant="primary" disabled={savingSettings} on:click={saveSettings}>{$t('common.save')}</Button></div>
      </section>
    </div>
  {/if}
</div>

<style>
  .billing-admin { display: flex; flex-direction: column; gap: var(--space-4); }
  .card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  .card-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); }
  .card-head h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-lg); flex: 1; }
  .count { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-full); background: var(--bg-tertiary); color: var(--text-secondary); }
  .filter, .job input { padding: var(--space-1) var(--space-2); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); }
  .jobs { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .job { display: inline-flex; gap: var(--space-2); align-items: center; }
  .job input { width: 90px; font-family: var(--font-mono); }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .table-wrap { overflow-x: auto; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { text-align: left; padding: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 2px solid var(--border-muted); }
  .table td { padding: var(--space-2); font-size: var(--text-sm); border-bottom: 1px solid var(--border-muted); vertical-align: middle; }
  .num { text-align: right; font-family: var(--font-mono); }
  .actions { display: flex; gap: var(--space-1); justify-content: flex-end; white-space: nowrap; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-muted); }
  .row:last-child { border-bottom: none; }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .row-title { font-weight: 500; }
  .muted { color: var(--text-secondary); }
  .small { font-size: var(--text-xs); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2) var(--space-3); }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-group.wide { grid-column: 1 / -1; }
  .form-group label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .form-group input { padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: inherit; }
  .card-actions { display: flex; justify-content: flex-end; padding-top: var(--space-2); }
  @media (max-width: 1000px) { .two-col { grid-template-columns: 1fr; } .form-grid { grid-template-columns: 1fr; } }
</style>
