<script>
  // Support card of an organisation (plan epic 2.13, superadmin): everything
  // a support engineer wants before picking up the phone — limits, 60 days of
  // usage, the latest signs of life, the notification channels and whether
  // they deliver, the members (to sign in as one), recent records and requests.
  import { onMount } from 'svelte'
  import { getTenantCard } from '../lib/api.js'
  import { timeAgo } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import ImpersonateModal from '../components/ImpersonateModal.svelte'

  export let params = {}

  let card = null
  let loading = true
  let error = null

  let showImpersonate = false
  let impUser = null

  async function load() {
    loading = true
    error = null
    try {
      card = await getTenantCard(params.id)
    } catch (err) {
      error = err.message
    } finally {
      loading = false
    }
  }

  onMount(load)
  $: if (params.id && card && card.tenant.id !== params.id) load()

  $: tenant = card?.tenant
  $: latest = card?.latest || {}
  $: channels = card?.channels || {}
  $: billing = card?.billing || {}

  // ── usage (60 days) ──
  $: usage = card?.usage || []
  $: usageMax = Math.max(1, ...usage.map(u => u.active_devices))
  $: notifMax = Math.max(1, ...usage.map(u => u.notifications_sent))
  $: usageSummary = usage.length ? {
    days: usage.length,
    avgDevices: Math.round(usage.reduce((a, u) => a + u.active_devices, 0) / usage.length * 10) / 10,
    maxDevices: Math.max(...usage.map(u => u.active_devices)),
    telemetry: usage.reduce((a, u) => a + Number(u.telemetry_rows || 0), 0),
    notifications: usage.reduce((a, u) => a + u.notifications_sent, 0),
  } : null

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString($t('time.locale_code')) : '—'
  const fmtTime = (d) => d ? new Date(d).toLocaleString($t('time.locale_code'), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const ago = (d) => d ? timeAgo(d) : $t('tenants.card_never')
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString($t('time.locale_code')))
  const usageOf = (count, max) => max ? `${count} / ${max}` : String(count ?? 0)

  function planColor(plan) {
    return { enterprise: 'success', partner: 'success', pro: 'info', basic: 'neutral', free: 'warning' }[plan] || 'neutral'
  }
  function statusColor(status) {
    return { active: 'success', trial: 'info', past_due: 'warning', suspended: 'danger', closed: 'danger' }[status] || 'neutral'
  }
  function methodColor(method) {
    if (method === 'POST') return 'info'
    if (method === 'PUT' || method === 'PATCH') return 'warning'
    if (method === 'DELETE') return 'danger'
    return 'neutral'
  }
  function requestStatusColor(s) {
    return { new: 'warning', open: 'info', closed: 'neutral' }[s] || 'neutral'
  }

  function signInAs(user) {
    impUser = user
    showImpersonate = true
  }
</script>

<div class="card-page">
  {#if loading}
    <Skeleton height="480px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else if card}
    <PageHeader title={tenant.name} subtitle="{tenant.slug} · {$t('tenants.created')} {fmtDate(tenant.created_at)}{tenant.parent_name ? ' · ' + $t('tenants.card_partner') + ' ' + tenant.parent_name : ''}">
      <a class="link-btn" href="#/tenants"><Icon name="arrow-left" size={14} /> {$t('common.back')}</a>
      <a class="link-btn" href="#/audit-log?tenant_id={tenant.id}"><Icon name="shield" size={14} /> {$t('tenants.card_audit_link')}</a>
      <a class="link-btn" href="#/admin/billing"><Icon name="credit-card" size={14} /> {$t('tenants.card_billing_link')}</a>
      <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
    </PageHeader>

    <div class="badges">
      <Badge variant={planColor(tenant.plan)}>{$t('tenants.plan_' + tenant.plan)}</Badge>
      <Badge variant={statusColor(tenant.status)}>{$t('tenants.status_' + (tenant.status || 'active'))}</Badge>
      {#if tenant.awaiting_approval}<Badge variant="warning">{$t('tenants.status_awaiting')}</Badge>{/if}
      {#if tenant.trial_expires_at && tenant.status === 'trial'}<span class="muted">{$t('tenants.card_trial_until', fmtDate(tenant.trial_expires_at))}</span>{/if}
      {#if tenant.status === 'closed' && tenant.purge_after}<span class="muted">{$t('tenants.purge_after', fmtDate(tenant.purge_after))}</span>{/if}
      {#if tenant.billing_email}<span class="muted">· {tenant.billing_email}</span>{/if}
    </div>

    <div class="grid">
      <!-- Limits -->
      <section class="section-card">
        <div class="section-header"><h2><Icon name="bar-chart" size={16} /> {$t('tenants.card_limits')}</h2></div>
        <dl class="facts">
          <div><dt>{$t('tenants.col_devices')}</dt><dd class:over={tenant.max_devices && tenant.device_count >= tenant.max_devices}>{usageOf(tenant.device_count, tenant.max_devices)}{#if tenant.pending_count} <small>+{tenant.pending_count} {$t('tenants.card_pending')}</small>{/if}</dd></div>
          <div><dt>{$t('tenants.col_sites')}</dt><dd>{usageOf(tenant.site_count, tenant.max_sites)}</dd></div>
          <div><dt>{$t('tenants.col_users')}</dt><dd class:over={tenant.max_users && tenant.user_count >= tenant.max_users}>{usageOf(tenant.user_count, tenant.max_users)}</dd></div>
          <div><dt>{$t('tenants.card_retention')}</dt><dd>{tenant.retention_days ?? '—'} {$t('tenants.card_days')}{#if tenant.raw_retention_days} <small>({$t('tenants.card_override')})</small>{/if}</dd></div>
          <div><dt>{$t('tenants.card_sampling')}</dt><dd>{tenant.sampling_sec ? tenant.sampling_sec + ' ' + $t('time.s') : '—'}</dd></div>
          <div><dt>{$t('tenants.card_features')}</dt><dd class="features">{#if Array.isArray(tenant.features) && tenant.features.length}{#each tenant.features as f}<code>{f}</code>{/each}{:else}—{/if}</dd></div>
        </dl>
      </section>

      <!-- Latest data -->
      <section class="section-card">
        <div class="section-header"><h2><Icon name="activity" size={16} /> {$t('tenants.card_latest')}</h2></div>
        <dl class="facts">
          <div><dt>{$t('tenants.card_last_seen')}</dt><dd title={fmtTime(latest.last_seen_at)}>{ago(latest.last_seen_at)}</dd></div>
          <div><dt>{$t('tenants.card_online')}</dt><dd>{latest.devices_online ?? 0} / {latest.devices_active ?? 0} <small>· {$t('tenants.card_seen_24h', latest.devices_seen_24h ?? 0)}</small></dd></div>
          <div><dt>{$t('tenants.card_firmware_versions')}</dt><dd>{latest.firmware_versions ?? 0}</dd></div>
          <div><dt>{$t('tenants.card_alarms')}</dt><dd class:warn={latest.alarms_active > 0}>{latest.alarms_active ?? 0}{#if latest.alarms_critical} <small class="danger">({latest.alarms_critical} {$t('tenants.card_critical')})</small>{/if} <small>· {$t('tenants.card_per_7d', latest.alarms_7d ?? 0)}</small></dd></div>
          <div><dt>{$t('tenants.card_last_alarm')}</dt><dd title={fmtTime(latest.last_alarm_at)}>{ago(latest.last_alarm_at)}</dd></div>
          <div><dt>{$t('tenants.card_last_login')}</dt><dd title={fmtTime(latest.last_login_at)}>{ago(latest.last_login_at)}</dd></div>
          <div><dt>{$t('tenants.card_last_activity')}</dt><dd title={fmtTime(latest.last_activity_at)}>{ago(latest.last_activity_at)} <small>· {$t('tenants.card_actions_7d', latest.actions_7d ?? 0, latest.errors_7d ?? 0)}</small></dd></div>
          <div><dt>{$t('tenants.card_last_support')}</dt><dd title={fmtTime(latest.last_support_at)}>{ago(latest.last_support_at)}</dd></div>
          <div><dt>{$t('tenants.card_open_work')}</dt><dd>{$t('tenants.card_open_work_value', latest.work_orders_open ?? 0, latest.hints_open ?? 0)}</dd></div>
          <div><dt>{$t('tenants.card_last_import')}</dt><dd title={fmtTime(latest.last_import_at)}>{ago(latest.last_import_at)}</dd></div>
          <div><dt>{$t('tenants.card_last_report')}</dt><dd title={fmtTime(latest.last_report_at)}>{ago(latest.last_report_at)}</dd></div>
        </dl>
      </section>

      <!-- Channels -->
      <section class="section-card">
        <div class="section-header"><h2><Icon name="bell" size={16} /> {$t('tenants.card_channels')}</h2></div>
        <dl class="facts">
          <div><dt>{$t('tenants.card_email_recipients')}</dt><dd>{channels.email_recipients ?? 0}</dd></div>
          <div><dt>Telegram</dt><dd>{channels.users_telegram ?? 0} {$t('tenants.card_users_linked')}{#if channels.telegram_subscribers} <small>+ {channels.telegram_subscribers} {$t('tenants.card_subscribers')}</small>{/if}</dd></div>
          <div><dt>Web Push</dt><dd>{channels.push_subscriptions ?? 0}{#if channels.fcm_subscribers} <small>+ FCM {channels.fcm_subscribers}</small>{/if}</dd></div>
          <div><dt>{$t('tenants.card_webhooks')}</dt><dd>{channels.webhooks_enabled ?? 0}{#if channels.webhooks_disabled} <small class="danger">· {$t('tenants.card_webhooks_disabled', channels.webhooks_disabled)}</small>{/if}</dd></div>
          <div><dt>{$t('tenants.card_api_keys')}</dt><dd>{channels.api_keys ?? 0}</dd></div>
          <div><dt>{$t('tenants.card_report_schedules')}</dt><dd>{channels.report_schedules ?? 0}</dd></div>
          <div><dt>{$t('tenants.card_notifications_7d')}</dt><dd>{channels.notifications_7d ?? 0}{#if channels.notifications_failed_7d} <small class="danger">· {$t('tenants.card_failed', channels.notifications_failed_7d)}</small>{/if}</dd></div>
          <div><dt>{$t('tenants.card_last_notification')}</dt><dd title={fmtTime(channels.last_notification_at)}>{ago(channels.last_notification_at)}</dd></div>
        </dl>
      </section>

      <!-- Billing -->
      <section class="section-card">
        <div class="section-header"><h2><Icon name="credit-card" size={16} /> {$t('tenants.card_billing')}</h2></div>
        <dl class="facts">
          <div><dt>{$t('tenants.card_open_invoices')}</dt><dd class:warn={billing.overdue_invoices > 0}>{billing.open_invoices ?? 0}{#if billing.overdue_invoices} <small class="danger">· {$t('tenants.card_overdue', billing.overdue_invoices)}</small>{/if}</dd></div>
          <div><dt>{$t('tenants.card_open_amount')}</dt><dd>{num(billing.open_amount)} {tenant.billing_currency || 'UAH'}</dd></div>
          <div><dt>{$t('tenants.card_last_invoice')}</dt><dd>{fmtDate(billing.last_invoice_at)}</dd></div>
          <div><dt>{$t('tenants.card_last_paid')}</dt><dd>{fmtDate(billing.last_paid_at)}</dd></div>
          {#if tenant.legal_name}<div><dt>{$t('tenants.legal_name')}</dt><dd>{tenant.legal_name}{#if tenant.tax_id} <small>· {tenant.tax_id}</small>{/if}</dd></div>{/if}
        </dl>
      </section>
    </div>

    <!-- Usage -->
    <section class="section-card block">
      <div class="section-header">
        <h2><Icon name="bar-chart" size={16} /> {$t('tenants.card_usage')}</h2>
        {#if usageSummary}
          <span class="muted">{$t('tenants.card_usage_summary', usageSummary.days, usageSummary.avgDevices, usageSummary.maxDevices, num(usageSummary.telemetry), num(usageSummary.notifications))}</span>
        {/if}
      </div>
      {#if usage.length === 0}
        <p class="empty">{$t('tenants.card_no_usage')}</p>
      {:else}
        <div class="chart-wrap">
          <div class="chart" role="img" aria-label={$t('tenants.card_usage_devices')}>
            {#each usage as u (u.day)}
              <div class="bar-col" title="{fmtDate(u.day)}: {u.active_devices} {$t('tenants.card_usage_devices')}, {u.notifications_sent} {$t('tenants.card_usage_notifications')}">
                <div class="bar notif" style="height: {Math.round(u.notifications_sent / notifMax * 100)}%"></div>
                <div class="bar dev" style="height: {Math.round(u.active_devices / usageMax * 100)}%"></div>
              </div>
            {/each}
          </div>
          <div class="legend">
            <span><i class="sw dev"></i> {$t('tenants.card_usage_devices')} (max {usageMax})</span>
            <span><i class="sw notif"></i> {$t('tenants.card_usage_notifications')} (max {notifMax})</span>
            <span class="muted">{fmtDate(usage[0].day)} → {fmtDate(usage[usage.length - 1].day)}</span>
          </div>
        </div>
      {/if}
    </section>

    <!-- Users -->
    <section class="section-card block">
      <div class="section-header">
        <h2><Icon name="users" size={16} /> {$t('tenants.card_users')}</h2>
        <span class="count-badge">{card.users.length}</span>
      </div>
      {#if card.users.length === 0}
        <p class="empty">{$t('tenants.card_no_users')}</p>
      {:else}
        <div class="table">
          <div class="table-header">
            <span class="c-email">E-mail</span>
            <span class="c-role">{$t('users.col_role')}</span>
            <span class="c-flags">MFA · Telegram</span>
            <span class="c-login">{$t('tenants.card_last_login')}</span>
            <span class="c-actions"></span>
          </div>
          {#each card.users as u (u.id)}
            <div class="row" class:inactive={!u.active}>
              <span class="c-email" title={u.email}>{u.email}{#if !u.is_home} <small>· {$t('tenants.card_guest')}</small>{/if}</span>
              <span class="c-role"><Badge variant="neutral" size="sm">{$t('users.role_' + u.role)}</Badge>{#if !u.active} <Badge variant="danger" size="sm">{$t('common.inactive')}</Badge>{/if}</span>
              <span class="c-flags">{u.mfa ? '✓' : '—'} · {u.telegram ? '✓' : '—'}</span>
              <span class="c-login" title={fmtTime(u.last_login)}>{ago(u.last_login)}</span>
              <span class="c-actions">
                {#if u.active}
                  <Button variant="secondary" size="sm" on:click={() => signInAs(u)} title={$t('impersonation.title')}>
                    <Icon name="user-check" size={13} /> {$t('tenants.card_sign_in_as')}
                  </Button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <div class="grid two">
      <!-- Recent audit -->
      <section class="section-card">
        <div class="section-header">
          <h2><Icon name="shield" size={16} /> {$t('tenants.card_recent_audit')}</h2>
          <a class="muted link" href="#/audit-log?tenant_id={tenant.id}">{$t('tenants.card_all')} →</a>
        </div>
        {#if card.recent_audit.length === 0}
          <p class="empty">{$t('audit.no_entries')}</p>
        {:else}
          <div class="table compact">
            {#each card.recent_audit as e (e.id)}
              <div class="row" class:error-row={e.status_code >= 400}>
                <span class="c-time">{fmtTime(e.created_at)}</span>
                <span class="c-who" title={e.user_email}>{e.user_email || '—'}{#if e.impersonator_email} <Badge variant="warning" size="sm">{$t('audit.via_support')}</Badge>{/if}</span>
                <span class="c-action"><code>{e.action}</code></span>
                <span class="c-status"><Badge variant={methodColor(e.method)} size="sm">{e.method}</Badge> <Badge variant={e.status_code >= 400 ? 'danger' : 'success'} size="sm">{e.status_code}</Badge></span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Support requests -->
      <section class="section-card">
        <div class="section-header">
          <h2><Icon name="help-circle" size={16} /> {$t('tenants.card_support_requests')}</h2>
          <a class="muted link" href="#/support?tenant_id={tenant.id}">{$t('tenants.card_all')} →</a>
        </div>
        {#if card.support_requests.length === 0}
          <p class="empty">{$t('support.no_requests')}</p>
        {:else}
          <div class="table compact">
            {#each card.support_requests as r (r.id)}
              <div class="row">
                <span class="c-time">{fmtTime(r.created_at)}</span>
                <span class="c-who" title={r.user_email}>{r.user_email}</span>
                <span class="c-action" title={r.subject}>{$t('support.cat_' + r.category)} · {r.subject}</span>
                <span class="c-status"><Badge variant={requestStatusColor(r.status)} size="sm">{$t('support.status_' + r.status)}</Badge></span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<ImpersonateModal bind:show={showImpersonate} user={impUser} tenant={tenant ? { id: tenant.id, name: tenant.name } : null} />

<style>
  .card-page { max-width: 1400px; margin: 0 auto; }
  .link-btn {
    display: inline-flex; align-items: center; gap: var(--space-1);
    padding: var(--space-2) var(--space-3); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    color: var(--text-secondary); font-size: var(--text-sm); text-decoration: none;
  }
  .link-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
  .badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: calc(-1 * var(--space-3)) 0 var(--space-4); }
  .muted { color: var(--text-muted); font-size: var(--text-xs); }
  .link { text-decoration: none; margin-left: auto; }
  .link:hover { color: var(--accent-blue); }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-4); }
  .grid.two { grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); }
  .section-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); overflow: hidden; }
  .section-card.block { margin-bottom: var(--space-4); }
  .section-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-muted); flex-wrap: wrap; }
  .section-header h2 { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); }
  .count-badge { font-size: var(--text-xs); color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 8px; border-radius: 999px; }
  .empty { margin: 0; padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }

  .facts { margin: 0; padding: var(--space-2) var(--space-4); display: flex; flex-direction: column; }
  .facts > div { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-muted); font-size: var(--text-sm); }
  .facts > div:last-child { border-bottom: none; }
  .facts dt { color: var(--text-muted); }
  .facts dd { margin: 0; color: var(--text-primary); text-align: right; }
  .facts dd small { color: var(--text-muted); font-size: var(--text-xs); }
  .facts dd.over, .facts dd.warn { color: var(--accent-yellow, #d29922); }
  .facts small.danger, .danger { color: var(--accent-red); }
  .features { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
  .features code { font-size: var(--text-xs); background: var(--bg-tertiary); padding: 1px 6px; border-radius: var(--radius-sm); font-family: var(--font-mono); }

  .chart-wrap { padding: var(--space-3) var(--space-4) var(--space-4); }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
  .bar-col { flex: 1; position: relative; height: 100%; display: flex; align-items: flex-end; min-width: 3px; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; border-radius: 2px 2px 0 0; min-height: 1px; }
  .bar.dev { background: var(--accent-blue); opacity: 0.85; }
  .bar.notif { background: var(--accent-yellow, #d29922); opacity: 0.5; }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-2); font-size: var(--text-xs); color: var(--text-secondary); }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
  .sw.dev { background: var(--accent-blue); }
  .sw.notif { background: var(--accent-yellow, #d29922); opacity: 0.6; }

  .table { display: flex; flex-direction: column; }
  .table-header { display: flex; gap: var(--space-3); padding: var(--space-2) var(--space-4); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); border-bottom: 1px solid var(--border-muted); }
  .row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border-muted); font-size: var(--text-sm); color: var(--text-secondary); }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--bg-hover); }
  .row.inactive { opacity: 0.6; }
  .row.error-row { background: rgba(248, 81, 73, 0.04); }
  .row > span, .table-header > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-email { flex: 2; min-width: 160px; color: var(--text-primary); }
  .c-email small { color: var(--text-muted); }
  .c-role { flex: 1.2; min-width: 120px; display: flex; gap: 4px; }
  .c-flags { flex: 0.8; min-width: 90px; font-family: var(--font-mono); font-size: var(--text-xs); }
  .c-login { flex: 1; min-width: 100px; color: var(--text-muted); }
  .c-actions { flex: 1; min-width: 120px; display: flex; justify-content: flex-end; }
  .c-time { flex: 0 0 96px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .c-who { flex: 1.4; min-width: 120px; display: flex; align-items: center; gap: 4px; }
  .c-action { flex: 1.6; min-width: 120px; }
  .c-action code { font-size: var(--text-xs); background: var(--bg-tertiary); padding: 2px 6px; border-radius: var(--radius-sm); font-family: var(--font-mono); }
  .c-status { flex: 0 0 auto; display: flex; gap: 4px; }

  @media (max-width: 768px) {
    .table-header { display: none; }
    .row { flex-wrap: wrap; }
    .c-actions { justify-content: flex-start; }
  }
</style>
