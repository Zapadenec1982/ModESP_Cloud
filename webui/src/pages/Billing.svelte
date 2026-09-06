<script>
  // Billing (plan epic 2.2) for an organisation's admin: the plan and its
  // prices, the month-to-date estimate from live usage, how to pay (the
  // seller's IBAN), the organisation's own billing identity, every invoice
  // with its PDF, and a plan-change request the superadmin decides on. An
  // organisation billed through its partner sees who pays and nothing more.
  import { onMount } from 'svelte'
  import { getBillingSummary, getBillingInvoices, getBillingUsage, downloadInvoicePdf, updateBillingIdentity,
           createPlanRequest, cancelPlanRequest, getPlans } from '../lib/api.js'
  import { t, locale } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let loading = true
  let error = null
  let summary = null
  let invoices = []
  let usage = []
  let plans = []

  async function load() {
    loading = true
    try {
      const [s, inv, u] = await Promise.all([getBillingSummary(), getBillingInvoices(), getBillingUsage(3).catch(() => [])])
      summary = s; invoices = inv; usage = u
      identity = { legal_name: s.tenant.legal_name || '', tax_id: s.tenant.tax_id || '', billing_email: s.tenant.billing_email || '' }
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
  onMount(load)

  // ── formatting ──
  $: code = $t('time.locale_code')
  function money(v, currency = 'UAH') {
    try { return new Intl.NumberFormat(code, { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(v) || 0) }
    catch { return `${Number(v || 0).toFixed(2)} ${currency}` }
  }
  function day(v) {
    if (!v) return '—'
    return new Date(v).toLocaleDateString(code, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
  }
  function month(start) {
    return new Date(start).toLocaleDateString(code, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  }
  function invoiceStatus(i) { return i.status === 'issued' && i.overdue ? 'overdue' : i.status }
  const statusVariant = (s) => s === 'paid' ? 'success' : s === 'overdue' ? 'danger' : s === 'void' ? 'neutral' : 'info'
  const tenantStatusVariant = (s) => s === 'trial' ? 'info' : s === 'past_due' ? 'warning' : s === 'active' ? 'success' : 'danger'
  const lineLabel = (l) => l.kind === 'base' ? `${$t('billing.kind_base')} «${l.plan_name || l.plan}»`
    : `${$t(l.kind === 'sites' ? 'billing.kind_sites' : 'billing.kind_controllers')} — ${l.tenant_name}`

  // ── monthly usage from the daily snapshots ──
  $: months = Object.values(usage.reduce((acc, r) => {
    const key = String(r.day).slice(0, 7)
    const m = acc[key] || (acc[key] = { key, days: 0, devices: 0, sites: 0, users: 0, telemetry: 0, notifications: 0 })
    m.days++; m.devices += r.active_devices; m.sites += r.sites; m.users = Math.max(m.users, r.users)
    m.telemetry += Number(r.telemetry_rows || 0); m.notifications += r.notifications_sent
    return acc
  }, {})).sort((a, b) => b.key.localeCompare(a.key))

  // ── identity ──
  let identity = { legal_name: '', tax_id: '', billing_email: '' }
  let savingIdentity = false
  async function saveIdentity() {
    savingIdentity = true
    try {
      await updateBillingIdentity({ legal_name: identity.legal_name.trim() || null, tax_id: identity.tax_id.trim() || null, billing_email: identity.billing_email.trim() })
      toast.success($t('billing.identity_saved'))
    } catch (e) { toast.error(e.message) } finally { savingIdentity = false }
  }

  // ── plan change ──
  let showRequest = false
  let reqPlan = ''
  let reqMessage = ''
  let reqBusy = false
  async function openRequest() {
    showRequest = true
    reqMessage = ''
    try {
      if (plans.length === 0) plans = await getPlans()
      reqPlan = (plans.find(p => p.plan !== summary.tenant.plan && p.plan !== 'partner') || {}).plan || ''
    } catch (e) { toast.error(e.message) }
  }
  async function sendRequest() {
    reqBusy = true
    try {
      await createPlanRequest(reqPlan, reqMessage.trim())
      toast.success($t('billing.request_sent'))
      showRequest = false
      await load()
    } catch (e) { toast.error(e.message) } finally { reqBusy = false }
  }
  async function cancelRequest() {
    try {
      await cancelPlanRequest()
      toast.success($t('billing.request_cancelled'))
      await load()
    } catch (e) { toast.error(e.message) }
  }

  async function pdf(i) {
    try { await downloadInvoicePdf(i.id, i.number) } catch (e) { toast.error(e.message) }
  }

  function planPrice(tn) {
    const parts = []
    if (tn.price_base_uah) parts.push(`${money(tn.price_base_uah)} / ${$t('billing.per_month')}`)
    if (tn.price_controller_uah !== null && tn.price_controller_uah !== undefined) parts.push(`${money(tn.price_controller_uah)} / ${$t('billing.per_controller')}`)
    if (tn.price_site_uah) parts.push(`${money(tn.price_site_uah)} / ${$t('billing.per_site')}`)
    return parts.join(' + ')
  }
</script>

<div class="billing-page">
  <PageHeader title={$t('pages.billing')} subtitle={summary ? summary.tenant.name : $t('pages.billing_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="320px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else}
    {@const tn = summary.tenant}
    {@const est = summary.estimate}
    {@const seller = summary.seller}

    <div class="grid">
      <!-- Plan -->
      <section class="card">
        <div class="card-head"><h2><Icon name="shield" size={18} /> {$t('billing.plan_title')}</h2>
          <Badge size="sm" variant={tenantStatusVariant(tn.status)}>{$t('tenants.status_' + tn.status)}</Badge></div>
        <div class="plan-name">{tn.plan_name || tn.plan}</div>
        {#if tn.tagline}<div class="muted">{tn.tagline}</div>{/if}
        {#if planPrice(tn)}<div class="plan-price">{planPrice(tn)}</div>{/if}
        {#if tn.price_note}<div class="muted small">{tn.price_note}</div>{/if}
        {#if tn.status === 'trial' && tn.trial_expires_at}<div class="small">{$t('billing.trial_until').replace('{0}', day(tn.trial_expires_at))}</div>{/if}
        <div class="limits muted small">
          {$t('tenants.col_devices')}: {tn.max_devices ?? '∞'} · {$t('tenants.col_sites')}: {tn.max_sites ?? '∞'} · {$t('tenants.col_users')}: {tn.max_users ?? '∞'}
        </div>
        <div class="card-actions">
          {#if summary.plan_request}
            <span class="small">{$t('billing.request_pending').replace('{0}', $t('tenants.plan_' + summary.plan_request.requested_plan))}</span>
            <Button size="sm" variant="ghost" on:click={cancelRequest}>{$t('billing.cancel_request')}</Button>
          {:else if !est || !est.billed_via_partner}
            <Button size="sm" variant="secondary" on:click={openRequest}>{$t('billing.change_plan')}</Button>
          {/if}
        </div>
      </section>

      <!-- Estimate -->
      <section class="card">
        <div class="card-head"><h2><Icon name="activity" size={18} /> {$t('billing.estimate_title')}</h2>
          {#if est}<span class="count">{month(est.period.start)}</span>{/if}</div>
        {#if !est}
          <p class="muted">{$t('billing.no_estimate')}</p>
        {:else if est.billed_via_partner}
          <p>{$t('billing.billed_via').replace('{0}', est.payer.name)}</p>
        {:else if est.lines.length === 0}
          <p class="muted">{$t('billing.no_estimate')}</p>
        {:else}
          <table class="table">
            <thead><tr><th>{$t('billing.col_desc')}</th><th class="num">{$t('billing.col_qty')}</th><th class="num">{$t('billing.col_unit')}</th><th class="num">{$t('billing.col_amount')}</th></tr></thead>
            <tbody>
              {#each est.lines as l}
                <tr><td>{lineLabel(l)}</td><td class="num">{l.qty}</td><td class="num">{money(l.unit_price, est.currency)}</td><td class="num">{money(l.amount, est.currency)}</td></tr>
              {/each}
              <tr class="total"><td colspan="3">{$t('billing.total')}</td><td class="num">{money(est.amount, est.currency)}</td></tr>
            </tbody>
          </table>
          {#if est.members.length > 1}
            <div class="members muted small">
              {#each est.members as m}<span>{m.name}: {m.devices} {$t('billing.unit_controllers')}{#if m.sites}, {m.sites} {$t('billing.unit_sites')}{/if}</span>{/each}
            </div>
          {/if}
          <p class="muted small">{$t('billing.estimate_hint')}</p>
        {/if}
      </section>

      <!-- How to pay -->
      <section class="card">
        <div class="card-head"><h2><Icon name="credit-card" size={18} /> {$t('billing.pay_title')}</h2></div>
        {#if seller.seller_iban || seller.seller_name}
          <dl class="req">
            {#if seller.seller_name}<dt>{$t('billing.recipient')}</dt><dd>{seller.seller_name}</dd>{/if}
            {#if seller.seller_tax_id}<dt>{$t('billing.tax_id')}</dt><dd>{seller.seller_tax_id}</dd>{/if}
            {#if seller.seller_iban}<dt>{$t('billing.iban')}</dt><dd><code>{seller.seller_iban}</code></dd>{/if}
            {#if seller.seller_bank}<dt>{$t('billing.bank')}</dt><dd>{seller.seller_bank}</dd>{/if}
            {#if summary.open_invoices.length > 0}
              <dt>{$t('billing.purpose')}</dt><dd>{$t('billing.purpose_text').replace('{0}', summary.open_invoices[0].number)}</dd>
            {/if}
          </dl>
          {#if seller.invoice_note}<p class="muted small">{seller.invoice_note}</p>{/if}
        {:else}
          <p class="muted">{$t('billing.no_requisites')}</p>
        {/if}
        <p class="muted small">{$t('billing.pay_hint')}</p>
      </section>

      <!-- Identity -->
      <section class="card">
        <div class="card-head"><h2><Icon name="building" size={18} /> {$t('billing.identity_title')}</h2></div>
        <p class="muted small">{$t('billing.identity_hint')}</p>
        <div class="form-group"><label for="b-legal">{$t('billing.legal_name')}</label><input id="b-legal" type="text" bind:value={identity.legal_name} maxlength="256" /></div>
        <div class="form-group"><label for="b-tax">{$t('billing.tax_id')}</label><input id="b-tax" type="text" bind:value={identity.tax_id} maxlength="32" /></div>
        <div class="form-group"><label for="b-email">{$t('billing.billing_email')}</label><input id="b-email" type="email" bind:value={identity.billing_email} maxlength="256" /></div>
        <div class="card-actions"><Button size="sm" variant="primary" disabled={savingIdentity} on:click={saveIdentity}>{$t('common.save')}</Button></div>
      </section>
    </div>

    <!-- Invoices -->
    <section class="card">
      <div class="card-head"><h2><Icon name="clipboard" size={18} /> {$t('billing.invoices_title')}</h2><span class="count">{invoices.length}</span></div>
      {#if invoices.length === 0}
        <p class="muted">{est && est.billed_via_partner ? $t('billing.billed_via').replace('{0}', est.payer.name) : $t('billing.no_invoices')}</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>{$t('billing.col_number')}</th><th>{$t('billing.col_period')}</th><th class="num">{$t('billing.col_amount')}</th>
              <th>{$t('billing.col_due')}</th><th>{$t('billing.col_status')}</th><th></th>
            </tr></thead>
            <tbody>
              {#each invoices as i (i.id)}
                <tr>
                  <td><code>{i.number}</code></td>
                  <td>{month(i.period_start)}</td>
                  <td class="num">{money(i.amount, i.currency)}</td>
                  <td>{day(i.due_at)}</td>
                  <td><Badge size="sm" variant={statusVariant(invoiceStatus(i))}>{$t('billing.status_' + invoiceStatus(i))}</Badge>
                    {#if i.paid_at}<span class="muted small"> {day(i.paid_at)}</span>{/if}</td>
                  <td class="actions"><Button size="sm" variant="ghost" icon="download" on:click={() => pdf(i)}>{$t('billing.pdf')}</Button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- Usage -->
    <section class="card">
      <div class="card-head"><h2><Icon name="bar-chart" size={18} /> {$t('billing.usage_title')}</h2></div>
      {#if months.length === 0}
        <p class="muted">{$t('billing.no_usage')}</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{$t('billing.col_month')}</th><th class="num">{$t('billing.col_devices')}</th><th class="num">{$t('billing.col_sites')}</th><th class="num">{$t('billing.col_users')}</th><th class="num">{$t('billing.col_telemetry')}</th><th class="num">{$t('billing.col_notifications')}</th></tr></thead>
            <tbody>
              {#each months as m (m.key)}
                <tr><td>{month(m.key + '-01')}</td><td class="num">{(m.devices / m.days).toFixed(1)}</td><td class="num">{(m.sites / m.days).toFixed(1)}</td><td class="num">{m.users}</td><td class="num">{m.telemetry.toLocaleString(code)}</td><td class="num">{m.notifications}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="muted small">{$t('billing.usage_hint')}</p>
      {/if}
    </section>
  {/if}
</div>

{#if showRequest}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showRequest = false}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header"><h2>{$t('billing.request_title')}</h2><button class="modal-close" on:click={() => showRequest = false}><Icon name="x" size={18} /></button></div>
      <div class="modal-body">
        <div class="form-group"><label for="pr-plan">{$t('billing.request_plan')}</label>
          <select id="pr-plan" bind:value={reqPlan}>
            {#each plans.filter(p => p.plan !== summary.tenant.plan) as p}<option value={p.plan}>{p.name} — {planPrice(p) || p.price_note || ''}</option>{/each}
          </select></div>
        <div class="form-group"><label for="pr-msg">{$t('billing.request_message')}</label><textarea id="pr-msg" rows="3" bind:value={reqMessage} maxlength="1000"></textarea></div>
      </div>
      <div class="modal-actions">
        <Button variant="ghost" on:click={() => showRequest = false} disabled={reqBusy}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={sendRequest} disabled={reqBusy || !reqPlan}>{$t('billing.request_send')}</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .billing-page { display: flex; flex-direction: column; gap: var(--space-4); }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-4); }
  .card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  .card-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); }
  .card-head h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-lg); flex: 1; }
  .count { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-full); background: var(--bg-tertiary); color: var(--text-secondary); }
  .card-actions { display: flex; align-items: center; gap: var(--space-2); margin-top: auto; padding-top: var(--space-2); }
  .plan-name { font-size: var(--text-2xl, 1.6rem); font-weight: 700; }
  .plan-price { font-family: var(--font-mono); font-size: var(--text-sm); }
  .table-wrap { overflow-x: auto; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { text-align: left; padding: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 2px solid var(--border-muted); }
  .table td { padding: var(--space-2); font-size: var(--text-sm); border-bottom: 1px solid var(--border-muted); vertical-align: middle; }
  .table tr.total td { font-weight: 700; border-bottom: none; }
  .num { text-align: right; font-family: var(--font-mono); }
  .actions { text-align: right; white-space: nowrap; }
  .members { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .req { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--text-sm); }
  .req dt { color: var(--text-muted); }
  .req dd { margin: 0; word-break: break-all; }
  .muted { color: var(--text-secondary); }
  .small { font-size: var(--text-xs); }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-group label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .form-group input, .form-group select, .form-group textarea { padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: inherit; }
  .modal-backdrop { position: fixed; inset: 0; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; padding: var(--space-4); }
  .modal { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-muted); }
  .modal-header h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
  .modal-close { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }
  @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
</style>
