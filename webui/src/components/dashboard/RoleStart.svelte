<script>
  /**
   * The role's own start block on the dashboard (audit item 8). One dashboard
   * for everyone; what changes is the first thing the role came for:
   *   technician — «Моя робота»: the orders assigned to them, deadline and route;
   *   admin      — «Сервіс»: the organisation's orders — nobody's, in progress,
   *                overdue, done — and who carries them;
   *   superadmin — «Платформа»: organisations to approve, past-due ones, the
   *                controller queue, open support requests, users, firmware.
   * A viewer gets no block: the attention list and the cards are their whole
   * story. Nothing here is a second copy of data — the orders arrive with the
   * dashboard's own request, the rest is one count each.
   */
  import { onMount } from 'svelte'
  import { authUser, authEnabled, isAdmin, isSuperAdmin, navigate } from '../../lib/stores.js'
  import { getWorkOrderStats, getTenants, getSupportRequests } from '../../lib/api.js'
  import { t } from '../../lib/i18n.js'
  import { formatDate } from '../../lib/format.js'
  import Icon from '../ui/Icon.svelte'
  import Badge from '../ui/Badge.svelte'

  export let devices = []   // the dashboard's device list (GET /devices)
  export let orders = []    // GET /work-orders?status=open — new, assigned and in progress
  export let now = Date.now()
  export let limit = 5

  // With auth off there is no user: the page behaves as an administrator's
  $: role = $authEnabled ? ($authUser?.role || 'viewer') : 'admin'

  const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }
  const ts = (v) => { const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? 0 : n }
  const when = (o) => ts(o.scheduled_at) || Number.MAX_SAFE_INTEGER
  const isOpen = (o) => o.status !== 'done' && o.status !== 'cancelled'
  $: overdue = (o) => isOpen(o) && !!o.scheduled_at && ts(o.scheduled_at) < now

  // ── technician: my orders, the late ones first, then by priority and date ──
  $: mine = $authUser
    ? orders.filter(o => o.assigned_to === $authUser.id && isOpen(o))
        .sort((a, b) => (overdue(b) - overdue(a))
          || ((PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2))
          || (when(a) - when(b)))
    : []
  $: freeCount = orders.filter(o => o.status === 'new').length

  // ── admin: the organisation's orders ──
  let stats = null            // GET /work-orders/stats — the last 30 days
  $: unassigned = orders.filter(o => o.status === 'new').length
  $: inProgress = orders.filter(o => o.status === 'assigned' || o.status === 'in_progress').length
  $: overdueCount = orders.filter(overdue).length
  $: byAssignee = groupAssignees(orders)
  $: showService = role === 'admin' && $isAdmin && !$isSuperAdmin && (orders.length > 0 || (stats && stats.total > 0))

  function groupAssignees(list) {
    const m = new Map()
    for (const o of list) {
      if (!o.assigned_to) continue
      const key = o.assigned_to_email || o.assigned_to
      m.set(key, (m.get(key) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  }

  // ── superadmin: the platform ──
  let tenants = null          // GET /tenants — every organisation
  let supportOpen = null      // GET /support/requests → meta.open
  $: awaiting = (tenants || []).filter(x => x.awaiting_approval).length
  $: pastDue = (tenants || []).filter(x => x.status === 'past_due' || x.status === 'suspended').length
  $: queue = devices.filter(d => d.status === 'pending').length

  onMount(async () => {
    if (role === 'admin' && !$isSuperAdmin) {
      try { stats = await getWorkOrderStats() } catch { stats = null }
    } else if (role === 'superadmin') {
      const [tn, sr] = await Promise.allSettled([getTenants(), getSupportRequests({})])
      if (tn.status === 'fulfilled') tenants = Array.isArray(tn.value) ? tn.value : (tn.value?.data || [])
      if (sr.status === 'fulfilled') supportOpen = sr.value?.meta?.open ?? null
    }
  })

  function open(o) { navigate(`/work-orders?id=${o.id}`) }
</script>

{#if role === 'technician'}
  <section class="role-block" aria-labelledby="mywork-title">
    <header class="rb-head">
      <div class="rb-title">
        <Icon name="clipboard" size={16} />
        <h2 id="mywork-title">{$t('dashboard.my_work_title')}</h2>
        {#if mine.length}<span class="rb-count" class:late={overdueCount > 0}>{mine.length}</span>{/if}
      </div>
      <p class="rb-sub">{$t('dashboard.my_work_sub')}</p>
    </header>

    {#if mine.length === 0}
      <p class="calm">
        <Icon name="check-circle" size={14} />
        <span>{$t('dashboard.my_work_empty')}</span>
        {#if freeCount}<a class="rb-link" href="#/work-orders?tab=open">{$t('dashboard.my_work_free', freeCount)} →</a>{/if}
      </p>
    {:else}
      <div class="rows" role="list">
        {#each mine.slice(0, limit) as o (o.id)}
          <div class="row {o.priority}" class:late={overdue(o)} role="listitem">
            <button type="button" class="row-main" on:click={() => open(o)}>
              <span class="dot" />
              <span class="title truncate"><span class="id">#{o.id}</span> {o.title}</span>
              <span class="place truncate">{o.site_name || o.device_name || o.device_mqtt_id || '—'}</span>
              <span class="when" class:late={overdue(o)}>
                {(o.scheduled_at ? formatDate(o.scheduled_at) : '—') + (overdue(o) ? ' · ' + $t('dashboard.my_work_overdue') : '')}
              </span>
              <span class="status"><Badge variant={o.status === 'in_progress' ? 'info' : 'warning'} size="sm">{$t('wo.status_' + o.status)}</Badge></span>
            </button>
            {#if o.maps_url}
              <a class="route" href={o.maps_url} target="_blank" rel="noopener"><Icon name="map-pin" size={14} /> {$t('wo.route')}</a>
            {/if}
          </div>
        {/each}
      </div>
      <div class="rb-foot">
        <a class="rb-link" href="#/work-orders?tab=mine">{$t('dashboard.my_work_all')} ({mine.length}) →</a>
        {#if freeCount}<a class="rb-link" href="#/work-orders?tab=open">{$t('dashboard.my_work_free', freeCount)} →</a>{/if}
      </div>
    {/if}
  </section>

{:else if showService}
  <section class="role-block" aria-labelledby="service-title">
    <header class="rb-head">
      <div class="rb-title">
        <Icon name="wrench" size={16} />
        <h2 id="service-title">{$t('dashboard.service_title')}</h2>
      </div>
      <p class="rb-sub">{$t('dashboard.service_sub')}</p>
    </header>
    <div class="tiles">
      <a class="tile" class:lit={unassigned > 0} href="#/work-orders?tab=open">
        <span class="v">{unassigned}</span><span class="l">{$t('dashboard.service_unassigned')}</span>
      </a>
      <a class="tile" href="#/work-orders?tab=open">
        <span class="v">{inProgress}</span><span class="l">{$t('dashboard.service_in_progress')}</span>
      </a>
      <a class="tile" class:warn={overdueCount > 0} href="#/work-orders?tab=open">
        <span class="v">{overdueCount}</span><span class="l">{$t('dashboard.service_overdue')}</span>
      </a>
      <a class="tile" href="#/work-orders?tab=closed">
        <span class="v">{stats ? stats.done : '—'}</span><span class="l">{$t('dashboard.service_done_30d')}</span>
      </a>
    </div>
    {#if byAssignee.length}
      <div class="chips">
        <span class="chips-label">{$t('dashboard.service_by_assignee')}:</span>
        {#each byAssignee as [who, n] (who)}
          <a class="chip" href="#/work-orders?tab=open" title={who}><span class="truncate">{who}</span> <b>{n}</b></a>
        {/each}
        <a class="rb-link" href="#/work-orders">{$t('dashboard.service_all')} →</a>
      </div>
    {/if}
  </section>

{:else if role === 'superadmin'}
  <section class="role-block" aria-labelledby="platform-title">
    <header class="rb-head">
      <div class="rb-title">
        <Icon name="globe" size={16} />
        <h2 id="platform-title">{$t('dashboard.platform_title')}</h2>
      </div>
      <p class="rb-sub">{$t('dashboard.platform_sub')}</p>
    </header>
    <div class="tiles">
      <a class="tile" class:lit={awaiting > 0} href="#/tenants">
        <span class="v">{tenants ? tenants.length : '—'}</span><span class="l">{$t('dashboard.platform_orgs')}</span>
        {#if awaiting}<span class="extra">{$t('dashboard.platform_awaiting', awaiting)}</span>{/if}
      </a>
      <a class="tile" class:warn={pastDue > 0} href="#/admin/billing">
        <span class="v">{tenants ? pastDue : '—'}</span><span class="l">{$t('dashboard.platform_past_due')}</span>
      </a>
      <a class="tile" class:lit={queue > 0} href="#/pending">
        <span class="v">{queue}</span><span class="l">{$t('dashboard.platform_queue')}</span>
      </a>
      <a class="tile" class:lit={supportOpen > 0} href="#/support">
        <span class="v">{supportOpen ?? '—'}</span><span class="l">{$t('dashboard.platform_support')}</span>
      </a>
      <a class="tile go" href="#/users"><Icon name="users" size={18} /><span class="l">{$t('dashboard.platform_users')}</span></a>
      <a class="tile go" href="#/firmware"><Icon name="upload" size={18} /><span class="l">{$t('dashboard.platform_firmware')}</span></a>
    </div>
  </section>
{/if}

<style>
  .role-block {
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rb-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .rb-title { display: flex; align-items: center; gap: var(--space-2); color: var(--text-primary); }
  .rb-title h2 { font-size: var(--text-base); font-weight: 600; margin: 0; }
  .rb-count {
    background: rgba(74, 158, 255, 0.14); color: var(--accent-blue);
    font-size: var(--text-xs); font-weight: 700; padding: 1px 7px; border-radius: var(--radius-full); font-family: var(--font-mono);
  }
  .rb-count.late { background: rgba(239, 68, 68, 0.12); color: var(--accent-red); }
  .rb-sub { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }

  .calm { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin: 0; padding: var(--space-2) 0; font-size: var(--text-sm); color: var(--accent-green); }
  .rb-link { font-size: var(--text-xs); font-weight: 600; color: var(--accent-blue); text-decoration: none; white-space: nowrap; }
  .rb-link:hover { text-decoration: underline; }
  .rb-foot { display: flex; gap: var(--space-4); flex-wrap: wrap; padding-top: var(--space-1); }

  /* ── my orders ── */
  .rows { display: flex; flex-direction: column; gap: 2px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; border-radius: var(--radius-sm); }
  .row-main {
    all: unset; cursor: pointer; box-sizing: border-box; min-width: 0;
    display: grid; grid-template-columns: 8px minmax(160px, 1.6fr) minmax(110px, 1fr) minmax(150px, auto) auto;
    gap: var(--space-3); align-items: center; padding: var(--space-2); border-radius: var(--radius-sm);
    font-size: var(--text-sm); color: var(--text-primary); transition: background var(--transition-fast);
  }
  .row-main:hover { background: var(--bg-tertiary); }
  .row-main:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: -2px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .urgent .dot { background: var(--accent-red); box-shadow: 0 0 6px rgba(239, 68, 68, 0.6); }
  .high .dot { background: var(--accent-yellow); }
  .normal .dot { background: var(--accent-blue); }
  .title { font-weight: 600; }
  .id { font-family: var(--font-mono); font-weight: 400; color: var(--text-muted); }
  .place { color: var(--text-secondary); }
  .when { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); white-space: nowrap; }
  .when.late { color: var(--accent-red); font-weight: 600; }
  .route { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-blue); font-size: var(--text-xs); text-decoration: none; padding-right: var(--space-2); white-space: nowrap; }
  .route:hover { text-decoration: underline; }

  /* ── tiles (service, platform) ── */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-2); }
  .tile {
    display: flex; flex-direction: column; gap: 2px; padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-muted); border-radius: var(--radius-md); background: var(--bg-surface);
    color: var(--text-primary); text-decoration: none; transition: border-color var(--transition-fast), background var(--transition-fast);
  }
  .tile:hover { border-color: var(--accent-blue); background: var(--bg-tertiary); }
  .tile .v { font-family: var(--font-mono); font-size: var(--text-xl); font-weight: 700; line-height: 1.1; color: var(--text-secondary); }
  .tile.lit .v { color: var(--accent-blue); }
  .tile.warn .v { color: var(--accent-red); }
  .tile .l { font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .extra { font-size: var(--text-xs); color: var(--accent-blue); font-weight: 600; }
  .tile.go { flex-direction: row; align-items: center; gap: var(--space-2); color: var(--text-secondary); }
  .tile.go .l { text-transform: none; letter-spacing: 0; font-size: var(--text-sm); color: var(--text-secondary); }

  .chips { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-xs); }
  .chips-label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; max-width: 260px; padding: 2px 8px;
    border-radius: var(--radius-full); background: var(--bg-tertiary); color: var(--text-secondary); text-decoration: none;
  }
  .chip:hover { color: var(--text-primary); }
  .chip b { font-family: var(--font-mono); color: var(--text-primary); }

  @media (max-width: 768px) {
    .row { grid-template-columns: 1fr; }
    .row-main { grid-template-columns: 8px minmax(0, 1fr); }
    .row-main .place, .row-main .status { grid-column: 2; }
    .row-main .when { grid-column: 2; }
    .route { padding: 0 var(--space-2) var(--space-2) calc(8px + var(--space-3) + var(--space-2)); }
  }
</style>
