<script>
  /**
   * One trade point (торгова точка) — `#/sites/:id`.
   *
   * The sites table is a directory of addresses; this is the place a dispatcher
   * or a technician actually looks at before a call or a visit: what stands on
   * the site and in what state, which alarms are open right now, which work
   * orders are still open, whom to phone. Every section links onward — the
   * device card, the alarms page narrowed to the site, the work orders page.
   *
   * Read is open to every authenticated role: GET /api/sites/:id narrows the
   * device list by RBAC and answers 404 when the caller may see nothing of the
   * site. The write controls (edit, public links) are admin-only, as on the
   * sites page; the report button follows the sites page too ($canWrite).
   */
  import { onMount, onDestroy } from 'svelte'
  import { getSite, getAlarms, getWorkOrders } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { isAdmin, canWrite, navigate } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { timeAgo, alarmLabel } from '../lib/format.js'
  import { formatAddress, formatCoords, precisionKey, geoSourceKey } from '../lib/geo.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import SiteReportModal from '../components/SiteReportModal.svelte'
  import SitePublicLinks from '../components/SitePublicLinks.svelte'

  // svelte-spa-router passes route params via `params` prop
  export let params = {}

  let site = null
  let alarms = []
  let orders = []
  let loading = true
  let notFound = false
  let showReport = false
  let reloadTimer = null
  let loadedFor = null
  const unsubscribers = []

  $: siteId = params.id

  async function load(id) {
    loading = true
    notFound = false
    // Marked before the await: a 404 must not re-trigger the reactive reload below.
    loadedFor = id
    try {
      site = await getSite(id)
    } catch (e) {
      site = null
      if (e.status === 404) notFound = true
      else toast.error(e.message || $t('site.load_error'))
      loading = false
      return
    }
    // The two side lists are best effort: a failure there must not take the
    // site down with it.
    const [alm, wo] = await Promise.all([
      getAlarms({ active: true, site_id: id, limit: 100 }).catch(() => []),
      getWorkOrders({ site_id: id, status: 'open', limit: 50 }).catch(() => []),
    ])
    alarms = Array.isArray(alm) ? alm : (alm?.data ?? [])
    orders = Array.isArray(wo) ? wo : (wo?.data ?? [])
    loading = false
  }

  /** Live events arrive in bursts; one reload per burst is enough. */
  function scheduleReload() {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => { if (siteId && !loading) load(siteId) }, 800)
  }

  // Reload when the route moves from one site to another without unmounting.
  $: if (siteId && siteId !== loadedFor && !loading) load(siteId)

  onMount(() => {
    if (siteId) load(siteId)
    for (const ev of ['alarm', 'alarm_ack', 'device_online', 'device_offline', 'work_order']) {
      unsubscribers.push(on(ev, scheduleReload))
    }
  })

  onDestroy(() => {
    clearTimeout(reloadTimer)
    for (const off of unsubscribers) off?.()
  })

  // ── Rendering helpers ──────────────────────────────────

  $: address = site ? formatAddress(site) : null
  $: hasContacts = !!(site && (site.contact_name || site.contact_phone || site.contact_email))
  $: hasCoords = !!(site && site.latitude !== null && site.latitude !== undefined && site.longitude !== null && site.longitude !== undefined)

  function deviceStatus(d) {
    if (d.alarm_active) return 'alarm'
    return d.online ? 'online' : 'offline'
  }

  function temp(value) {
    return value === null || value === undefined || Number.isNaN(Number(value)) ? '--' : Number(value).toFixed(1)
  }

  function severityVariant(severity) {
    if (severity === 'critical') return 'danger'
    if (severity === 'warning') return 'warning'
    return 'info'
  }

  function prioVariant(p) {
    return p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : p === 'low' ? 'neutral' : 'info'
  }

  function statusVariant(s) {
    return s === 'in_progress' ? 'info' : s === 'assigned' ? 'warning' : 'neutral'
  }
</script>

<div class="site-page">
  {#if loading && !site}
    <Skeleton height="80px" />
    <Skeleton height="240px" />
  {:else if notFound || !site}
    <EmptyState icon="building" title={$t('site.not_found')}>
      <a class="link-btn" href="#/sites"><Icon name="arrow-left" size={14} /> {$t('site.back_to_sites')}</a>
    </EmptyState>
  {:else}
    <PageHeader title={site.name} subtitle={address || $t('site.no_address')}>
      <a class="hdr-btn ghost" href="#/sites">
        <Icon name="arrow-left" size={14} />
        {$t('site.back_to_sites')}
      </a>
      {#if $canWrite}
        <button class="hdr-btn" on:click={() => (showReport = true)} disabled={site.device_count === 0}>
          <Icon name="file-text" size={14} />
          {$t('site.report')}
        </button>
      {/if}
      {#if $isAdmin}
        <a class="hdr-btn ghost" href="#/sites?edit={site.id}">
          <Icon name="edit" size={14} />
          {$t('site.edit_site')}
        </a>
      {/if}
    </PageHeader>

    <!-- Counters + contacts + facts -->
    <div class="summary">
      <div class="stats">
        <a class="stat" href="#/?site={site.id}" title={$t('site.show_on_dashboard')}>
          <span class="v font-mono">{site.device_count}</span>
          <span class="l">{$t('site.device_count')}</span>
        </a>
        <div class="stat">
          <span class="v font-mono ok">{site.online_count}</span>
          <span class="l">{$t('site.online_count')}</span>
        </div>
        <a class="stat" href="#/alarms?site={site.id}" title={$t('site.show_alarms')}>
          <span class="v font-mono" class:bad={site.alarm_count > 0}>{site.alarm_count}</span>
          <span class="l">{$t('site.alarm_count')}</span>
        </a>
      </div>

      <div class="facts">
        <div class="fact-block">
          <h3><Icon name="user" size={14} /> {$t('site.contacts')}</h3>
          {#if hasContacts}
            <dl>
              {#if site.contact_name}<dt>{$t('site.contact_name')}</dt><dd>{site.contact_name}</dd>{/if}
              {#if site.contact_phone}<dt>{$t('site.contact_phone')}</dt><dd><a href="tel:{site.contact_phone.replace(/[^+\d]/g, '')}">{site.contact_phone}</a></dd>{/if}
              {#if site.contact_email}<dt>{$t('site.contact_email')}</dt><dd><a href="mailto:{site.contact_email}">{site.contact_email}</a></dd>{/if}
            </dl>
          {:else}
            <p class="muted">{$t('site.no_contacts')}</p>
          {/if}
        </div>
        <div class="fact-block">
          <h3><Icon name="map-pin" size={14} /> {$t('site.address')}</h3>
          <dl>
            <dt>{$t('site.address')}</dt><dd>{address || $t('site.no_address')}</dd>
            <dt>{$t('site.coords')}</dt>
            <dd>
              {#if hasCoords}
                <span class="font-mono">{formatCoords(site.latitude, site.longitude)}</span>
                <span class="muted"> · {$t(geoSourceKey(site.geo_source))}{site.geo_precision ? ` · ${$t(precisionKey(site.geo_precision))}` : ''}</span>
              {:else}
                <span class="muted">{$t('site.coords_none')}</span>
              {/if}
            </dd>
            {#if site.timezone}<dt>{$t('site.timezone')}</dt><dd>{site.timezone}</dd>{/if}
            {#if site.haccp_excursion_min}<dt>{$t('site.haccp_excursion_min')}</dt><dd>{site.haccp_excursion_min}</dd>{/if}
            {#if site.notes}<dt>{$t('site.notes')}</dt><dd class="notes">{site.notes}</dd>{/if}
          </dl>
        </div>
      </div>
    </div>

    <!-- Equipment -->
    <section class="section">
      <h2 class="section-title">
        <Icon name="cpu" size={18} />
        {$t('site.equipment')}
        <span class="count">{site.devices.length}</span>
      </h2>
      {#if site.devices.length === 0}
        <EmptyState icon="cpu" title={$t('site.no_equipment')} message={$t('site.no_equipment_hint')} />
      {:else}
        <div class="device-list">
          {#each site.devices as d (d.id)}
            <button class="device-row" class:alarm={d.alarm_active} on:click={() => navigate(`/device/${d.mqtt_device_id}`)}
              aria-label="{d.name || d.mqtt_device_id}">
              <StatusDot status={deviceStatus(d)} size="sm" />
              <div class="device-main">
                <span class="device-name truncate">{d.name || d.mqtt_device_id}</span>
                <span class="device-meta">
                  <span class="font-mono">{d.mqtt_device_id}</span>
                  {#if d.location}<span> · {d.location}</span>{/if}
                </span>
              </div>
              <span class="device-state" class:ok={d.online} class:muted={!d.online}>{d.online ? $t('common.online') : $t('common.offline')}</span>
              <span class="device-temp font-mono" class:bad={d.alarm_active}>{temp(d.air_temp)}<span class="unit">°C</span></span>
              {#if d.alarm_active}
                <span class="alarm-badge"><Icon name="alert-triangle" size={12} /> {$t('device.alarm_badge')}</span>
              {/if}
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Active alarms -->
    <section class="section">
      <h2 class="section-title">
        <Icon name="alert-triangle" size={18} />
        {$t('site.active_alarms')}
        {#if alarms.length > 0}<Badge variant="danger">{alarms.length}</Badge>{/if}
        <a class="section-link" href="#/alarms?site={site.id}">{$t('site.all_site_alarms')} <Icon name="chevron-right" size={12} /></a>
      </h2>
      {#if alarms.length === 0}
        <div class="no-alarms">
          <Icon name="check-circle" size={20} />
          <span>{$t('site.no_active_alarms')}</span>
        </div>
      {:else}
        <div class="alarm-list">
          {#each alarms as alarm (alarm.id)}
            <button class="alarm-row" class:acked={alarm.acknowledged_at}
              on:click={() => navigate(`/device/${alarm.mqtt_device_id || alarm.device_id}`)}
              aria-label="{alarm.device_name || alarm.device_id} — {alarmLabel(alarm.alarm_code)}">
              <Badge variant={severityVariant(alarm.severity)} pulse={!alarm.acknowledged_at}>{(alarm.severity || 'warning').toUpperCase()}</Badge>
              <div class="alarm-info">
                <span class="alarm-type">{alarmLabel(alarm.alarm_code)}</span>
                <span class="alarm-device">{alarm.device_name || alarm.device_id} <span class="font-mono muted">{alarm.device_id}</span></span>
                {#if alarm.acknowledged_at}
                  <span class="ack-info">{$t('alarm.acked_by', alarm.acknowledged_by_email || '—')} · {timeAgo(alarm.acknowledged_at)}</span>
                {/if}
              </div>
              <span class="alarm-time">{timeAgo(alarm.triggered_at)}</span>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Open work orders -->
    <section class="section">
      <h2 class="section-title">
        <Icon name="clipboard" size={18} />
        {$t('site.open_orders')}
        {#if orders.length > 0}<span class="count">{orders.length}</span>{/if}
        <a class="section-link" href="#/work-orders">{$t('site.all_orders')} <Icon name="chevron-right" size={12} /></a>
      </h2>
      {#if orders.length === 0}
        <p class="muted">{$t('site.no_open_orders')}</p>
      {:else}
        <div class="order-list">
          {#each orders as o (o.id)}
            <button class="order-row" on:click={() => navigate(`/work-orders?id=${o.id}`)} aria-label="#{o.id} {o.title}">
              <div class="order-main">
                <span class="order-title"><span class="font-mono muted">#{o.id}</span> {o.title}</span>
                <span class="order-meta">
                  {#if o.device_name || o.device_mqtt_id}<span><Icon name="cpu" size={12} /> {o.device_name || o.device_mqtt_id}</span>{/if}
                  <span><Icon name="user" size={12} /> {o.assigned_to_email || $t('wo.unassigned')}</span>
                  <span class="muted">{timeAgo(o.created_at)}</span>
                </span>
              </div>
              <Badge variant={prioVariant(o.priority)} size="sm">{$t(`wo.prio_${o.priority}`)}</Badge>
              <Badge variant={statusVariant(o.status)} size="sm">{$t(`wo.status_${o.status}`)}</Badge>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Public status links (admin) -->
    {#if $isAdmin}
      <section class="section">
        <h2 class="section-title">
          <Icon name="link" size={18} />
          {$t('site.public_links')}
        </h2>
        <SitePublicLinks {site} />
      </section>
    {/if}
  {/if}
</div>

{#if showReport && site}
  <SiteReportModal {site} on:close={() => (showReport = false)} />
{/if}

<style>
  .site-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 1200px;
    margin: 0 auto;
  }

  .hdr-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--accent-blue);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    color: #fff;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    text-decoration: none;
    transition: filter var(--transition-fast);
  }

  .hdr-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .hdr-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hdr-btn.ghost {
    background: transparent;
    border-color: var(--border-default);
    color: var(--text-secondary);
  }

  .hdr-btn.ghost:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent-blue);
    text-decoration: none;
    font-size: var(--text-sm);
  }

  /* ── Summary ──────────────────────────────────────── */

  .summary {
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
    gap: var(--space-4);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
    align-content: start;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--space-3) var(--space-2);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: inherit;
  }

  a.stat:hover {
    border-color: var(--accent-blue);
  }

  .stat .v {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-primary);
  }

  .stat .l {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
  }

  .fact-block {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    min-width: 0;
  }

  .fact-block h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }

  .fact-block dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }

  .fact-block dt {
    color: var(--text-muted);
  }

  .fact-block dd {
    margin: 0;
    color: var(--text-primary);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .fact-block dd a {
    color: var(--accent-blue);
    text-decoration: none;
  }

  .fact-block dd.notes {
    white-space: pre-wrap;
  }

  /* ── Sections ─────────────────────────────────────── */

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .section-link {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--accent-blue);
    text-decoration: none;
  }

  .count {
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-radius: 999px;
    padding: 2px 8px;
  }

  .muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .ok {
    color: var(--accent-green);
  }

  .bad {
    color: var(--accent-red);
  }

  /* ── Devices ──────────────────────────────────────── */

  .device-list,
  .alarm-list,
  .order-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .device-row,
  .alarm-row,
  .order-row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    width: 100%;
    box-sizing: border-box;
    transition: all var(--transition-fast);
  }

  .device-row:hover,
  .order-row:hover {
    background: var(--bg-tertiary);
    border-color: var(--text-muted);
  }

  .device-row.alarm {
    border-color: rgba(239, 68, 68, 0.3);
  }

  .device-main,
  .alarm-info,
  .order-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .device-name,
  .alarm-type,
  .order-title {
    font-weight: 500;
    color: var(--text-primary);
    font-size: var(--text-base);
  }

  .device-meta,
  .alarm-device,
  .order-meta {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .order-meta span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .device-state {
    font-size: var(--text-xs);
    flex-shrink: 0;
  }

  .device-temp {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    flex-shrink: 0;
  }

  .device-temp .unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-left: 2px;
  }

  .alarm-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: rgba(239, 68, 68, 0.15);
    color: var(--accent-red);
    font-size: var(--text-xs);
    font-weight: 600;
    flex-shrink: 0;
  }

  /* ── Alarms ───────────────────────────────────────── */

  .no-alarms {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    background: rgba(63, 185, 80, 0.06);
    border: 1px solid rgba(63, 185, 80, 0.2);
    border-radius: var(--radius-md);
    color: var(--accent-green);
    font-size: var(--text-sm);
  }

  .alarm-row {
    border-color: rgba(248, 81, 73, 0.3);
  }

  .alarm-row:hover {
    border-color: var(--accent-red);
    background: rgba(248, 81, 73, 0.06);
  }

  .alarm-row.acked {
    opacity: 0.75;
  }

  .ack-info {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .alarm-time {
    font-size: var(--text-sm);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  @media (max-width: 768px) {
    .summary {
      grid-template-columns: 1fr;
    }

    .device-row,
    .alarm-row,
    .order-row {
      flex-wrap: wrap;
      padding: var(--space-3);
    }

    .device-main,
    .alarm-info,
    .order-main {
      flex-basis: 100%;
      order: -1;
    }

    .fact-block dl {
      grid-template-columns: 1fr;
    }
  }
</style>
