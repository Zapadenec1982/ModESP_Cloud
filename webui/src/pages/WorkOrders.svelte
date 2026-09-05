<script>
  // Work orders (plan epic 2.3): alarm or hint → technician → visit → record.
  // Any role may open the page; the server narrows the list to orders the
  // caller may see. Administrators assign and cancel, technicians take and
  // close, everyone follows the status.
  import { onMount, onDestroy } from 'svelte'
  import { querystring } from 'svelte-spa-router'
  import { getWorkOrders, getWorkOrder, getWorkOrderStats, getWorkOrderAssignees, createWorkOrder,
           assignWorkOrder, startWorkOrder, closeWorkOrder, cancelWorkOrder, getDevices } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { navigate, isAdmin, canWrite, authUser } from '../lib/stores.js'
  import { timeAgo, formatDate } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Button from '../components/ui/Button.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let tab = 'open'          // open | mine | closed
  let orders = []
  let loading = true
  let error = ''
  let stats = null
  let assignees = []
  let devices = []
  let busy = null
  let wsUnsub = null
  let selected = null       // expanded order detail
  let selectedDetail = null

  // ── create modal ──
  let showCreate = false
  let form = { title: '', description: '', priority: 'normal', device_id: '', assigned_to: '', scheduled_at: '' }
  let saving = false

  // ── close modal ──
  let closing = null
  let closeForm = { work_done: '', duration_min: '', parts: '', cost: '', cost_currency: 'UAH' }

  async function load() {
    loading = true
    error = ''
    try {
      const params = tab === 'mine' ? { status: 'open', mine: true } : { status: tab }
      orders = await getWorkOrders(params)
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
  async function loadSide() {
    try { stats = await getWorkOrderStats() } catch { stats = null }
    if ($isAdmin) { try { assignees = await getWorkOrderAssignees() } catch { assignees = [] } }
    try { devices = (await getDevices()) || [] } catch { devices = [] }
  }
  async function openDetail(id) {
    if (selected === id) { selected = null; selectedDetail = null; return }
    selected = id
    selectedDetail = null
    try { selectedDetail = await getWorkOrder(id) } catch (e) { toast.error(e.message) }
  }

  function setTab(next) { tab = next; load() }
  function status(o) { return $t(`wo.status_${o.status}`) }
  function statusVariant(s) {
    if (s === 'done') return 'success'
    if (s === 'cancelled') return 'neutral'
    if (s === 'in_progress') return 'info'
    return 'warning'
  }
  function prioVariant(p) { return p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : 'neutral' }
  function source(o) { return o.alarm_id ? $t('wo.from_alarm') : o.hint_id ? $t('wo.from_hint') : $t('wo.manual') }
  function mine(o) { return $authUser && o.assigned_to === $authUser.id }
  function minutes(m) { return m == null ? '—' : `${m} ${$t('wo.minutes_short')}` }

  // ── actions ──
  async function act(o, fn, okMsg) {
    busy = o.id
    try {
      await fn()
      if (okMsg) toast.success(okMsg)
      await load()
      if (selected === o.id) selectedDetail = await getWorkOrder(o.id)
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }
  const take   = (o) => act(o, () => assignWorkOrder(o.id, $authUser.id))
  const start  = (o) => act(o, () => startWorkOrder(o.id))
  const cancel = (o) => {
    const reason = window.prompt($t('wo.cancel_reason_prompt'), '')
    if (reason === null) return
    return act(o, () => cancelWorkOrder(o.id, reason))
  }
  async function assign(o, ev) {
    const userId = ev.target.value
    if (!userId) return
    await act(o, () => assignWorkOrder(o.id, userId))
  }

  function openCreate() {
    form = { title: '', description: '', priority: 'normal', device_id: '', assigned_to: '', scheduled_at: '' }
    showCreate = true
  }
  async function save() {
    saving = true
    try {
      const body = { title: form.title, description: form.description || null, priority: form.priority }
      if (form.device_id) body.device_id = form.device_id
      if (form.assigned_to) body.assigned_to = form.assigned_to
      if (form.scheduled_at) body.scheduled_at = new Date(form.scheduled_at).toISOString()
      await createWorkOrder(body)
      toast.success($t('wo.saved'))
      showCreate = false
      await load()
    } catch (e) { toast.error(e.message) } finally { saving = false }
  }

  function openClose(o) {
    closing = o
    closeForm = { work_done: '', duration_min: '', parts: '', cost: '', cost_currency: 'UAH' }
  }
  function parseParts(text) {
    return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [name, qty, cost] = l.split(';').map(x => x.trim())
      const p = { name }
      if (qty && !isNaN(Number(qty))) p.qty = Number(qty)
      if (cost && !isNaN(Number(cost))) p.cost = Number(cost)
      return p
    })
  }
  async function submitClose() {
    saving = true
    try {
      const body = { work_done: closeForm.work_done }
      if (closeForm.duration_min !== '') body.duration_min = Number(closeForm.duration_min)
      if (closeForm.cost !== '') { body.cost = Number(closeForm.cost); body.cost_currency = closeForm.cost_currency || 'UAH' }
      const parts = parseParts(closeForm.parts)
      if (parts.length) body.parts = parts
      await closeWorkOrder(closing.id, body)
      toast.success($t('wo.closed_ok'))
      closing = null
      await load()
      await loadSide()
    } catch (e) { toast.error(e.message) } finally { saving = false }
  }

  onMount(async () => {
    const q = new URLSearchParams($querystring || '')
    await load()
    loadSide()
    const id = q.get('id')
    if (id) {
      // an order reached from an alarm or a hint may be closed already
      if (!orders.some(o => String(o.id) === id)) { tab = 'closed'; await load() }
      if (!orders.some(o => String(o.id) === id)) { tab = 'open'; await load() }
      openDetail(id)
    }
    wsUnsub = on('work_order', () => load())
  })
  onDestroy(() => { if (wsUnsub) wsUnsub() })
</script>

<div class="page">
  <PageHeader title={$t('pages.work_orders')} subtitle={$t('pages.work_orders_sub')}>
    {#if $canWrite}
      <Button variant="primary" icon="plus" on:click={openCreate}>{$t('wo.create')}</Button>
    {/if}
  </PageHeader>

  {#if stats}
    <div class="stats">
      <div class="stat"><span class="v">{stats.total}</span><span class="l">{$t('wo.stats_total')} · {$t('wo.stats_title')}</span></div>
      <div class="stat"><span class="v">{stats.done}</span><span class="l">{$t('wo.stats_done')}</span></div>
      <div class="stat"><span class="v">{minutes(stats.avg_assign_min)}</span><span class="l">{$t('wo.stats_avg_assign')}</span></div>
      <div class="stat"><span class="v">{minutes(stats.avg_close_min)}</span><span class="l">{$t('wo.stats_avg_close')}</span></div>
    </div>
  {/if}

  <div class="tabs">
    <button class="tab" class:active={tab === 'open'} on:click={() => setTab('open')}>{$t('wo.open')}</button>
    <button class="tab" class:active={tab === 'mine'} on:click={() => setTab('mine')}>{$t('wo.mine')}</button>
    <button class="tab" class:active={tab === 'closed'} on:click={() => setTab('closed')}>{$t('wo.closed')}</button>
  </div>

  {#if loading}
    <Skeleton height="120px" />
  {:else if error}
    <p class="error">{error}</p>
  {:else if orders.length === 0}
    <EmptyState icon="clipboard" title={$t('wo.empty')} message={$t('wo.empty_hint')} />
  {:else}
    <div class="list">
      {#each orders as o (o.id)}
        <div class="order" class:open-detail={selected === o.id}>
          <button class="row" on:click={() => openDetail(o.id)}>
            <div class="col-main">
              <div class="title-line">
                <span class="id">#{o.id}</span>
                <span class="title">{o.title}</span>
                <Badge variant={prioVariant(o.priority)} size="sm">{$t(`wo.prio_${o.priority}`)}</Badge>
                <Badge variant={statusVariant(o.status)} size="sm">{status(o)}</Badge>
              </div>
              <div class="meta">
                {#if o.device_name || o.device_mqtt_id}<span><Icon name="cpu" size={12} /> {o.device_name || o.device_mqtt_id}</span>{/if}
                {#if o.site_name}<span><Icon name="building" size={12} /> {o.site_name}{o.site_city ? ', ' + o.site_city : ''}</span>{/if}
                <span><Icon name="user" size={12} /> {o.assigned_to_email || $t('wo.unassigned')}</span>
                <span class="muted">{source(o)} · {timeAgo(o.created_at)}</span>
              </div>
            </div>
            <Icon name={selected === o.id ? 'chevron-down' : 'chevron-right'} size={16} />
          </button>

          <div class="actions">
            {#if o.status !== 'done' && o.status !== 'cancelled'}
              {#if $isAdmin}
                <select class="assign" on:change={(e) => assign(o, e)} disabled={busy === o.id} value="">
                  <option value="">{$t('wo.assign')}…</option>
                  {#each assignees as u}<option value={u.id}>{u.email}</option>{/each}
                </select>
              {:else if $canWrite && !o.assigned_to}
                <Button size="sm" variant="secondary" disabled={busy === o.id} on:click={() => take(o)}>{$t('wo.take')}</Button>
              {/if}
              {#if (mine(o) || $isAdmin) && o.status !== 'in_progress'}
                <Button size="sm" variant="secondary" disabled={busy === o.id} on:click={() => start(o)}>{$t('wo.start')}</Button>
              {/if}
              {#if mine(o) || $isAdmin}
                <Button size="sm" variant="primary" disabled={busy === o.id} on:click={() => openClose(o)}>{$t('wo.close')}</Button>
              {/if}
              {#if $isAdmin}
                <Button size="sm" variant="ghost" disabled={busy === o.id} on:click={() => cancel(o)}>{$t('wo.cancel')}</Button>
              {/if}
            {/if}
            {#if o.maps_url}
              <a class="route" href={o.maps_url} target="_blank" rel="noopener"><Icon name="map-pin" size={14} /> {$t('wo.route')}</a>
            {/if}
          </div>

          {#if selected === o.id}
            <div class="detail">
              {#if !selectedDetail}
                <Skeleton height="60px" />
              {:else}
                {#if selectedDetail.description}<p class="desc">{selectedDetail.description}</p>{/if}
                <dl>
                  <dt>{$t('wo.created_by')}</dt><dd>{selectedDetail.created_by_email || '—'} · {formatDate(selectedDetail.created_at)}</dd>
                  {#if selectedDetail.site_address}<dt>{$t('wo.site')}</dt><dd>{selectedDetail.site_name} — {selectedDetail.site_address}</dd>{/if}
                  {#if selectedDetail.scheduled_at}<dt>{$t('wo.scheduled')}</dt><dd>{formatDate(selectedDetail.scheduled_at)}</dd>{/if}
                  {#if selectedDetail.alarm}<dt>{$t('wo.from_alarm')}</dt><dd class="mono">{selectedDetail.alarm.alarm_code} · {formatDate(selectedDetail.alarm.triggered_at)}</dd>{/if}
                  {#if selectedDetail.hint}<dt>{$t('wo.from_hint')}</dt><dd>{$t(`hint.${selectedDetail.hint.rule_key}`)} · {selectedDetail.hint.value} / {selectedDetail.hint.threshold}</dd>{/if}
                  {#if selectedDetail.started_at}<dt>{$t('wo.status_in_progress')}</dt><dd>{formatDate(selectedDetail.started_at)}</dd>{/if}
                  {#if selectedDetail.service_record}
                    <dt>{$t('wo.work_done')}</dt>
                    <dd>{selectedDetail.service_record.work_done}
                      {#if selectedDetail.service_record.duration_min != null} · {minutes(selectedDetail.service_record.duration_min)}{/if}
                      {#if selectedDetail.service_record.cost != null} · {selectedDetail.service_record.cost} {selectedDetail.service_record.cost_currency || ''}{/if}
                      {#if selectedDetail.service_record.parts && selectedDetail.service_record.parts.length}
                        <ul class="parts">{#each selectedDetail.service_record.parts as p}<li>{p.name}{p.qty ? ` × ${p.qty}` : ''}{p.cost != null ? ` — ${p.cost}` : ''}</li>{/each}</ul>
                      {/if}
                    </dd>
                  {:else if selectedDetail.closed_reason}
                    <dt>{status(selectedDetail)}</dt><dd>{selectedDetail.closed_reason}</dd>
                  {/if}
                </dl>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showCreate}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showCreate = false}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header"><h2>{$t('wo.create')}</h2><button class="modal-close" on:click={() => showCreate = false}><Icon name="x" size={18} /></button></div>
      <div class="modal-body">
        <div class="form-group"><label for="wo-title">{$t('wo.title')}</label><input id="wo-title" type="text" bind:value={form.title} placeholder={$t('wo.title_placeholder')} maxlength="200" /></div>
        <div class="form-group"><label for="wo-desc">{$t('wo.description')}</label><textarea id="wo-desc" rows="3" bind:value={form.description}></textarea></div>
        <div class="form-row">
          <div class="form-group"><label for="wo-prio">{$t('wo.priority')}</label>
            <select id="wo-prio" bind:value={form.priority}>
              {#each ['low', 'normal', 'high', 'urgent'] as p}<option value={p}>{$t(`wo.prio_${p}`)}</option>{/each}
            </select></div>
          <div class="form-group"><label for="wo-when">{$t('wo.scheduled')}</label><input id="wo-when" type="datetime-local" bind:value={form.scheduled_at} /></div>
        </div>
        <div class="form-group"><label for="wo-dev">{$t('wo.device')}</label>
          <select id="wo-dev" bind:value={form.device_id}>
            <option value="">{$t('wo.device_any')}</option>
            {#each devices as d}<option value={d.id}>{d.name || d.mqtt_device_id}{d.site_name ? ` — ${d.site_name}` : ''}</option>{/each}
          </select></div>
        {#if $isAdmin}
          <div class="form-group"><label for="wo-who">{$t('wo.assignee')}</label>
            <select id="wo-who" bind:value={form.assigned_to}>
              <option value="">{$t('wo.unassigned')}</option>
              {#each assignees as u}<option value={u.id}>{u.email}</option>{/each}
            </select></div>
        {/if}
      </div>
      <div class="modal-actions">
        <Button variant="ghost" on:click={() => showCreate = false} disabled={saving}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={save} disabled={saving || !form.title.trim() || !form.device_id}>{saving ? $t('common.loading') : $t('common.save')}</Button>
      </div>
    </div>
  </div>
{/if}

{#if closing}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => closing = null}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header"><h2>{$t('wo.close_title').replace('{0}', closing.id)}</h2><button class="modal-close" on:click={() => closing = null}><Icon name="x" size={18} /></button></div>
      <div class="modal-body">
        <div class="form-group"><label for="cl-work">{$t('wo.work_done')}</label><textarea id="cl-work" rows="3" bind:value={closeForm.work_done} placeholder={$t('wo.work_done_placeholder')}></textarea></div>
        <div class="form-row">
          <div class="form-group"><label for="cl-dur">{$t('wo.duration')}</label><input id="cl-dur" type="number" min="0" bind:value={closeForm.duration_min} /></div>
          <div class="form-group"><label for="cl-cost">{$t('wo.cost')}</label><input id="cl-cost" type="number" min="0" step="0.01" bind:value={closeForm.cost} /></div>
          <div class="form-group"><label for="cl-cur">{$t('wo.currency')}</label><input id="cl-cur" type="text" maxlength="3" bind:value={closeForm.cost_currency} /></div>
        </div>
        <div class="form-group"><label for="cl-parts">{$t('wo.parts')}</label><textarea id="cl-parts" rows="3" bind:value={closeForm.parts} placeholder={$t('wo.parts_placeholder')}></textarea></div>
      </div>
      <div class="modal-actions">
        <Button variant="ghost" on:click={() => closing = null} disabled={saving}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={submitClose} disabled={saving || !closeForm.work_done.trim()}>{saving ? $t('common.loading') : $t('wo.close')}</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { display: flex; flex-direction: column; gap: var(--space-4); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3); }
  @media (max-width: 720px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .stat { display: flex; flex-direction: column; padding: var(--space-3); background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); }
  .stat .v { font-family: var(--font-mono); font-size: var(--text-xl); font-weight: 700; }
  .stat .l { font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .tabs { display: flex; gap: var(--space-2); }
  .tab { padding: 6px 14px; border-radius: var(--radius-full); border: 1px solid var(--border-default); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: var(--text-sm); }
  .tab.active { background: var(--accent-blue); border-color: var(--accent-blue); color: var(--text-inverse); }
  .list { display: flex; flex-direction: column; gap: var(--space-2); }
  .order { border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-surface); }
  .order.open-detail { border-color: var(--accent-blue); }
  .row { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-3); background: transparent; border: none; color: var(--text-primary); text-align: left; cursor: pointer; }
  .col-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .title-line { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .id { font-family: var(--font-mono); color: var(--text-secondary); font-size: var(--text-sm); }
  .title { font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
  .meta span { display: inline-flex; align-items: center; gap: 4px; }
  .muted { color: var(--text-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; padding: 0 var(--space-3) var(--space-3); }
  .assign { padding: 6px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: var(--text-sm); }
  .route { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; color: var(--accent-blue); font-size: var(--text-sm); text-decoration: none; }
  .detail { padding: 0 var(--space-3) var(--space-3); border-top: 1px solid var(--border-muted); padding-top: var(--space-3); }
  .desc { margin: 0 0 var(--space-2); white-space: pre-wrap; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--space-3); margin: 0; font-size: var(--text-sm); }
  dt { color: var(--text-secondary); }
  dd { margin: 0; }
  .mono { font-family: var(--font-mono); }
  .parts { margin: 4px 0 0; padding-left: 18px; }
  .error { color: var(--accent-red); }
  .modal-backdrop { position: fixed; inset: 0; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; padding: var(--space-4); }
  .modal { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-muted); }
  .modal-header h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
  .modal-close { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-3); }
  .form-row .form-group:nth-child(2):last-child { grid-column: span 2; }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-group label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .form-group input, .form-group textarea, .form-group select { padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: inherit; }
  .form-group textarea { resize: vertical; }
</style>
