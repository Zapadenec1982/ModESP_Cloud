<script>
  // Partner plan (plan epic 2.5): the organisations this one services, in one
  // place — totals, every client's devices / alarms / orders / hints, the team
  // placed in each client, active alarms and open orders across all of them,
  // and the clients' sites on one map. Entering a client is an ordinary tenant
  // switch; the role held there decides what the partner's person may do.
  import { onMount } from 'svelte'
  import { getPartnerOverview, getPartnerClients, createPartnerClient, updatePartnerClient,
           getPartnerClientMembers, addPartnerClientMember, removePartnerClientMember, getPartnerSites,
           getUsers, switchTenant } from '../lib/api.js'
  import { navigate, authUser } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { timeAgo, alarmLabel } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let loading = true
  let error = null
  let overview = null
  let clients = []
  let sites = []
  let staff = []          // the partner's own people (for the team dialog)

  async function load() {
    loading = true
    try {
      const [ov, cl, st] = await Promise.all([getPartnerOverview(), getPartnerClients(), getPartnerSites().catch(() => [])])
      overview = ov; clients = cl; sites = st
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
  onMount(load)

  // ── create client ──
  let showCreate = false
  let saving = false
  let form = { name: '', slug: '', plan: 'basic' }
  const slugify = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  function openCreate() { form = { name: '', slug: '', plan: 'basic' }; showCreate = true }
  function onNameInput() { if (!form._slugTouched) form.slug = slugify(form.name) }
  async function create() {
    saving = true
    try {
      await createPartnerClient({ name: form.name.trim(), slug: form.slug.trim(), plan: form.plan })
      toast.success($t('partner.client_created'))
      showCreate = false
      await load()
    } catch (e) { toast.error(e.message) } finally { saving = false }
  }

  // ── rename ──
  async function rename(c) {
    const name = window.prompt($t('partner.rename'), c.name)
    if (name === null || !name.trim() || name.trim() === c.name) return
    try {
      await updatePartnerClient(c.id, { name: name.trim() })
      toast.success($t('partner.client_updated'))
      await load()
    } catch (e) { toast.error(e.message) }
  }

  // ── enter a client ──
  async function enter(c) {
    try {
      await switchTenant(c.id)
      navigate('/')
    } catch (e) { toast.error(e.message) }
  }

  // ── team dialog ──
  let teamFor = null
  let members = []
  let membersLoading = false
  let pickUser = ''
  let pickRole = 'technician'
  let memberBusy = false
  async function openTeam(c) {
    teamFor = c
    members = []
    membersLoading = true
    try {
      if (staff.length === 0) staff = (await getUsers()).filter(u => u.active && u.is_home !== false)
      members = await getPartnerClientMembers(c.id)
    } catch (e) { toast.error(e.message) } finally { membersLoading = false }
  }
  $: addable = teamFor ? staff.filter(u => u.id !== $authUser?.id && !members.some(m => m.id === u.id)) : []
  async function addMember() {
    if (!pickUser) return
    memberBusy = true
    try {
      await addPartnerClientMember(teamFor.id, pickUser, pickRole)
      toast.success($t('partner.member_added'))
      pickUser = ''
      members = await getPartnerClientMembers(teamFor.id)
      clients = await getPartnerClients()
    } catch (e) { toast.error(e.message) } finally { memberBusy = false }
  }
  async function removeMember(m) {
    memberBusy = true
    try {
      await removePartnerClientMember(teamFor.id, m.id)
      toast.success($t('partner.member_removed'))
      members = await getPartnerClientMembers(teamFor.id)
      clients = await getPartnerClients()
    } catch (e) { toast.error(e.message) } finally { memberBusy = false }
  }

  // ── map: the clients' sites as the map component's site features ──
  $: mapFeatures = sites.map(s => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
    properties: {
      site_id: s.id, site_name: `${s.tenant_name} — ${s.name}`, city: s.city,
      device_count: s.device_count, online_count: s.online_count,
      offline_count: Math.max(0, s.device_count - s.online_count), alarm_count: s.active_alarms, devices: [],
    },
  }))

  const sevVariant = (s) => s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'info'
  const prioVariant = (p) => p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : 'neutral'
</script>

<div class="partner-page">
  <PageHeader title={$t('pages.partner')} subtitle={$t('pages.partner_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
    <Button variant="primary" icon="plus" on:click={openCreate}>{$t('partner.new_client')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="320px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else}
    <!-- Totals -->
    <div class="totals">
      {#each [['clients', 'totals_clients'], ['devices', 'totals_devices'], ['online', 'totals_online'], ['active_alarms', 'totals_alarms'], ['open_orders', 'totals_orders'], ['open_hints', 'totals_hints']] as [key, label]}
        <div class="tile" class:alert={key === 'active_alarms' && overview.totals[key] > 0}>
          <span class="tile-value">{overview.totals[key]}</span>
          <span class="tile-label">{$t('partner.' + label)}</span>
        </div>
      {/each}
    </div>

    <!-- Clients -->
    <section class="card">
      <div class="card-head"><h2><Icon name="layers" size={18} /> {$t('partner.clients')}</h2><span class="count">{clients.length}</span></div>
      {#if clients.length === 0}
        <EmptyState icon="layers" title={$t('partner.no_clients')} message={$t('partner.no_clients_hint')} />
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{$t('partner.col_client')}</th>
                <th>{$t('tenants.col_plan')}</th>
                <th class="num">{$t('partner.col_devices')}</th>
                <th class="num">{$t('partner.col_online')}</th>
                <th class="num">{$t('partner.col_alarms')}</th>
                <th class="num">{$t('partner.col_orders')}</th>
                <th class="num">{$t('partner.col_hints')}</th>
                <th class="num">{$t('partner.col_team')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each clients as c (c.id)}
                <tr>
                  <td>
                    <strong>{c.name}</strong>
                    <div class="muted small"><code>{c.slug}</code>{#if c.status !== 'active'} · {$t('tenants.status_' + c.status)}{/if}</div>
                  </td>
                  <td><Badge size="sm" variant="neutral">{c.plan_name || c.plan}</Badge></td>
                  <td class="num">{c.device_count}</td>
                  <td class="num">{c.online_count}</td>
                  <td class="num">
                    {#if c.active_alarms > 0}<Badge size="sm" variant={c.critical_alarms > 0 ? 'danger' : 'warning'}>{c.active_alarms}</Badge>{:else}0{/if}
                  </td>
                  <td class="num">{c.open_orders}</td>
                  <td class="num">{c.open_hints}</td>
                  <td class="num">{c.member_count}</td>
                  <td class="actions">
                    <Button size="sm" variant="ghost" on:click={() => openTeam(c)}>{$t('partner.team')}</Button>
                    <Button size="sm" variant="ghost" on:click={() => rename(c)}>{$t('partner.rename')}</Button>
                    {#if c.my_role}
                      <Button size="sm" variant="secondary" on:click={() => enter(c)}>{$t('partner.enter')}</Button>
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
      <!-- Alarms across clients -->
      <section class="card">
        <div class="card-head"><h2><Icon name="alert-triangle" size={18} /> {$t('partner.alarms_title')}</h2><span class="count">{overview.alarms.length}</span></div>
        {#if overview.alarms.length === 0}
          <p class="muted">{$t('partner.no_alarms')}</p>
        {:else}
          <ul class="list">
            {#each overview.alarms as a (a.id)}
              <li class="row">
                <Badge size="sm" variant={sevVariant(a.severity)}>{a.severity}</Badge>
                <div class="row-main">
                  <span class="row-title">{alarmLabel(a.alarm_code)}</span>
                  <span class="muted small">{a.tenant_name}{a.site_name ? ' · ' + a.site_name : ''} · {a.device_name || a.device_mqtt_id}</span>
                </div>
                <span class="muted small">{timeAgo(a.triggered_at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Open orders across clients -->
      <section class="card">
        <div class="card-head"><h2><Icon name="clipboard" size={18} /> {$t('partner.orders_title')}</h2><span class="count">{overview.work_orders.length}</span></div>
        {#if overview.work_orders.length === 0}
          <p class="muted">{$t('partner.no_orders')}</p>
        {:else}
          <ul class="list">
            {#each overview.work_orders as o (o.id)}
              <li class="row">
                <Badge size="sm" variant={prioVariant(o.priority)}>{$t('wo.prio_' + o.priority)}</Badge>
                <div class="row-main">
                  <span class="row-title">#{o.id} {o.title}</span>
                  <span class="muted small">{o.tenant_name}{o.site_name ? ' · ' + o.site_name : ''} · {$t('wo.status_' + o.status)}{o.assigned_to_email ? ' · ' + o.assigned_to_email : ''}</span>
                </div>
                <span class="muted small">{timeAgo(o.created_at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>

    <!-- Hints across clients -->
    {#if overview.hints.length > 0}
      <section class="card">
        <div class="card-head"><h2><Icon name="wrench" size={18} /> {$t('partner.hints_title')}</h2><span class="count">{overview.hints.length}</span></div>
        <ul class="list">
          {#each overview.hints as h (h.id)}
            <li class="row">
              <Badge size="sm" variant="info">{h.value}×</Badge>
              <div class="row-main">
                <span class="row-title">{$t('hint.alarm_repeat')}: {alarmLabel(h.alarm_code)}</span>
                <span class="muted small">{h.tenant_name} · {h.device_name || h.device_mqtt_id}</span>
              </div>
              <span class="muted small">{timeAgo(h.opened_at)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Map of the clients' sites -->
    <section class="card">
      <div class="card-head"><h2><Icon name="map-pin" size={18} /> {$t('partner.map_title')}</h2><span class="count">{sites.length}</span></div>
      {#if sites.length === 0}
        <p class="muted">{$t('partner.no_sites')}</p>
      {:else}
        {#await import('../components/map/MapCanvas.svelte')}
          <Skeleton height="360px" />
        {:then { default: MapCanvas }}
          <MapCanvas features={mapFeatures} height="360px" clustered={true} />
        {:catch}
          <p class="muted">{$t('common.failed_to_load')}</p>
        {/await}
      {/if}
    </section>
  {/if}
</div>

{#if showCreate}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showCreate = false}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header"><h2>{$t('partner.create_client')}</h2><button class="modal-close" on:click={() => showCreate = false}><Icon name="x" size={18} /></button></div>
      <div class="modal-body">
        <div class="form-group"><label for="pc-name">{$t('partner.client_name')}</label><input id="pc-name" type="text" bind:value={form.name} on:input={onNameInput} placeholder={$t('tenants.name_placeholder')} maxlength="128" /></div>
        <div class="form-group"><label for="pc-slug">{$t('partner.client_slug')}</label><input id="pc-slug" type="text" bind:value={form.slug} on:input={() => form._slugTouched = true} placeholder={$t('tenants.slug_placeholder')} maxlength="64" /><small class="muted">{$t('tenants.slug_hint')}</small></div>
        <div class="form-group"><label for="pc-plan">{$t('partner.client_plan')}</label>
          <select id="pc-plan" bind:value={form.plan}>
            {#each ['free', 'basic', 'pro'] as p}<option value={p}>{$t('tenants.plan_' + p)}</option>{/each}
          </select></div>
      </div>
      <div class="modal-actions">
        <Button variant="ghost" on:click={() => showCreate = false} disabled={saving}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={create} disabled={saving || !form.name.trim() || form.slug.length < 2}>{saving ? $t('common.loading') : $t('common.save')}</Button>
      </div>
    </div>
  </div>
{/if}

{#if teamFor}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => teamFor = null}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header"><h2>{$t('partner.members_title').replace('{0}', teamFor.name)}</h2><button class="modal-close" on:click={() => teamFor = null}><Icon name="x" size={18} /></button></div>
      <div class="modal-body">
        <p class="muted small">{$t('partner.members_hint')}</p>
        {#if membersLoading}
          <Skeleton height="120px" />
        {:else}
          <ul class="members">
            {#each members as m (m.id)}
              <li class="member">
                <span class="member-email">{m.email}</span>
                <Badge size="sm" variant={m.partner_staff ? 'info' : 'neutral'}>{m.partner_staff ? $t('partner.partner_staff') : $t('partner.client_staff')}</Badge>
                <span class="muted small">{$t('users.role_' + m.role)}</span>
                {#if m.partner_staff}
                  <Button size="sm" variant="ghost" disabled={memberBusy} on:click={() => removeMember(m)}>{$t('partner.remove_member')}</Button>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="add-row">
            <select bind:value={pickUser}>
              <option value="">{$t('partner.pick_user')}</option>
              {#each addable as u}<option value={u.id}>{u.email}</option>{/each}
            </select>
            <select bind:value={pickRole}>
              {#each ['admin', 'technician', 'viewer'] as r}<option value={r}>{$t('users.role_' + r)}</option>{/each}
            </select>
            <Button size="sm" variant="primary" disabled={memberBusy || !pickUser} on:click={addMember}>{$t('partner.add_member')}</Button>
          </div>
        {/if}
      </div>
      <div class="modal-actions">
        <Button variant="ghost" on:click={() => teamFor = null}>{$t('common.close')}</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .partner-page { display: flex; flex-direction: column; gap: var(--space-4); }
  .totals { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--space-3); }
  .tile { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; }
  .tile.alert { border-color: rgba(248, 81, 73, 0.4); }
  .tile-value { font-size: var(--text-2xl, 1.6rem); font-weight: 700; font-family: var(--font-mono); }
  .tile.alert .tile-value { color: var(--accent-red); }
  .tile-label { font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); padding: var(--space-4); }
  .card-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
  .card-head h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-lg); }
  .count { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-full); background: var(--bg-tertiary); color: var(--text-secondary); }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .table-wrap { overflow-x: auto; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { text-align: left; padding: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 2px solid var(--border-muted); }
  .table td { padding: var(--space-2); font-size: var(--text-sm); border-bottom: 1px solid var(--border-muted); vertical-align: middle; }
  .num { text-align: right; font-family: var(--font-mono); }
  .actions { display: flex; gap: var(--space-1); justify-content: flex-end; white-space: nowrap; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-muted); }
  .row:last-child { border-bottom: none; }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .row-title { font-weight: 500; }
  .muted { color: var(--text-secondary); }
  .small { font-size: var(--text-xs); }
  .members { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .member { display: flex; align-items: center; gap: var(--space-2); }
  .member-email { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .add-row { display: flex; gap: var(--space-2); }
  .add-row select { flex: 1; padding: var(--space-2); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); }
  .modal-backdrop { position: fixed; inset: 0; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; padding: var(--space-4); }
  .modal { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-muted); }
  .modal-header h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
  .modal-close { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-group label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .form-group input, .form-group select { padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: inherit; }
  @media (max-width: 1000px) { .totals { grid-template-columns: repeat(3, 1fr); } .two-col { grid-template-columns: 1fr; } }
</style>
