<script>
  import { onMount, onDestroy } from 'svelte'
  import { getDevices, deleteDevicesBulk, exportDevicesCsv, getHaccpPresets, setHaccpBulk } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { devices, isSuperAdmin, isAdmin } from '../lib/stores.js'
  import { t, locale } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import FleetSummaryBar from '../components/dashboard/FleetSummaryBar.svelte'
  import OnboardingChecklist from '../components/dashboard/OnboardingChecklist.svelte'
  import DeviceFilter from '../components/dashboard/DeviceFilter.svelte'
  import DeviceCard from '../components/DeviceCard.svelte'
  import DeviceListRow from '../components/dashboard/DeviceListRow.svelte'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import Icon from '../components/ui/Icon.svelte'

  let loading = true
  let error = null
  let interval
  let deleting = false

  // Filter state
  let search = ''
  let filter = 'all'
  let view = 'grid'

  // Selection
  let selected = new Set()
  $: selectedCount = selected.size
  $: allFilteredSelected = filtered.length > 0 && filtered.every(d => selected.has(d.id))

  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    selected = selected
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      selected = new Set()
    } else {
      selected = new Set(filtered.map(d => d.id))
    }
  }

  function clearSelection() {
    selected = new Set()
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return
    const msg = $t('dashboard.bulk_delete_confirm').replace('{0}', String(selected.size))
    if (!confirm(msg)) return
    deleting = true
    try {
      const res = await deleteDevicesBulk([...selected])
      toast.success($t('dashboard.bulk_deleted').replace('{0}', String(res?.deleted ?? selected.size)))
      selected = new Set()
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      deleting = false
    }
  }

  // Bulk HACCP critical limits (PATCH /devices/haccp): a preset by what the
  // equipment stores, optional overrides, and by default only devices without limits.
  let haccpModal = false
  let haccpPresets = []
  let haccpForm = { preset: '', haccp_min: '', haccp_max: '', haccp_tolerance: '', haccp_product: '', only_empty: true }
  let haccpSaving = false

  async function openHaccpModal() {
    if (selected.size === 0) return
    haccpForm = { preset: '', haccp_min: '', haccp_max: '', haccp_tolerance: '', haccp_product: '', only_empty: true }
    haccpModal = true
    if (!haccpPresets.length) {
      try { haccpPresets = await getHaccpPresets() || [] } catch (err) { toast.error(err.message) }
    }
  }

  /** "≤ −18 °C (±3)" / "0…6 °C (±2)" for a preset option label. */
  function presetRange(p) {
    const n = (v) => String(v).replace('-', '−')
    const range = p.haccp_min == null ? `≤ ${n(p.haccp_max)}` : p.haccp_max == null ? `≥ ${n(p.haccp_min)}` : `${n(p.haccp_min)}…${n(p.haccp_max)}`
    return `${range} °C${p.haccp_tolerance ? ` (±${p.haccp_tolerance})` : ''}`
  }
  function onHaccpPreset() {
    const p = haccpPresets.find(x => x.key === haccpForm.preset)
    if (!p) return
    haccpForm = { ...haccpForm, haccp_min: p.haccp_min ?? '', haccp_max: p.haccp_max ?? '', haccp_tolerance: p.haccp_tolerance ?? '', haccp_product: p.label[$locale] || p.label.uk }
  }

  async function applyHaccpBulk() {
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
    const payload = { ids: [...selected], only_empty: haccpForm.only_empty, lang: $locale }
    if (haccpForm.preset) payload.preset = haccpForm.preset
    for (const k of ['haccp_min', 'haccp_max', 'haccp_tolerance']) { const v = num(haccpForm[k]); if (v !== null && !Number.isNaN(v)) payload[k] = v }
    if ((haccpForm.haccp_product || '').trim()) payload.haccp_product = haccpForm.haccp_product.trim()
    if (!payload.preset && payload.haccp_min === undefined && payload.haccp_max === undefined) return
    haccpSaving = true
    try {
      const res = await setHaccpBulk(payload)
      toast.success($t('dashboard.bulk_haccp_done').replace('{0}', String(res?.updated ?? 0)).replace('{1}', String(res?.skipped ?? 0)))
      haccpModal = false
      selected = new Set()
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      haccpSaving = false
    }
  }

  function onHaccpKey(e) { if (e.key === 'Escape') haccpModal = false }

  // WS tracking
  let subscribedIds = new Set()
  let wsUnsubs = []

  // Derived filtered list
  $: filtered = filterDevices($devices, search, filter)

  // Group by location (skip grouping for superadmin — tenant badge on cards is enough)
  $: groups = $isSuperAdmin ? null : groupByLocation(filtered)

  function filterDevices(list, q, f) {
    let result = list
    if (q) {
      const lq = q.toLowerCase()
      result = result.filter(d =>
        (d.name || '').toLowerCase().includes(lq) ||
        (d.mqtt_device_id || '').toLowerCase().includes(lq) ||
        (d.location || '').toLowerCase().includes(lq) ||
        (d.model || '').toLowerCase().includes(lq) ||
        (d.serial_number || '').toLowerCase().includes(lq) ||
        (d.tenant_name || '').toLowerCase().includes(lq)
      )
    }
    if (f === 'online')  result = result.filter(d => d.online)
    if (f === 'offline') result = result.filter(d => !d.online && d.status !== 'pending')
    if (f === 'alarm')   result = result.filter(d => (d.alarms_open || 0) > 0)
    return result
  }

  function groupByLocation(list) {
    const map = new Map()
    for (const d of list) {
      const group = d.location || $t('dashboard.unassigned')
      if (!map.has(group)) map.set(group, [])
      map.get(group).push(d)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }

  // Fleet stats derived from device list
  $: onlineCount = $devices.filter(d => d.online).length
  $: totalCount = $devices.length
  // Аварії = записи, які платформа відкрила і ще не закрила, тобто рівно те, що
  // показує сторінка «Аварії». Зведений прапорець контролера (alarm_active) сюди
  // не входить: він піднімається щойно відчиняються двері, до того як затримка
  // вирішить, чи це взагалі аварія.
  $: alarmCount = $devices.filter(d => (d.alarms_open || 0) > 0).length
  $: hintCount = $devices.filter(d => (d.hints_open || 0) > 0).length

  async function load() {
    try {
      const data = await getDevices()
      devices.set(data)
      error = null
      syncWsSubscriptions(data)
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function syncWsSubscriptions(deviceList) {
    const newIds = new Set(deviceList.map(d => d.mqtt_device_id))
    for (const id of subscribedIds) {
      if (!newIds.has(id)) { unsubscribe(id); subscribedIds.delete(id) }
    }
    for (const id of newIds) {
      if (!subscribedIds.has(id)) { subscribe(id); subscribedIds.add(id) }
    }
  }

  function setupWsListeners() {
    wsUnsubs.push(on('state_update', (msg) => {
      devices.update(list => list.map(d => {
        if (d.mqtt_device_id !== msg.device_id) return d
        const changes = msg.changes || {}
        return {
          ...d,
          air_temp: changes['equipment.air_temp'] !== undefined
            ? changes['equipment.air_temp'] : d.air_temp,
          alarm_active: changes['protection.alarm_active'] !== undefined
            ? !!changes['protection.alarm_active'] : d.alarm_active,
          door_open: changes['equipment.door_open'] !== undefined
            ? !!changes['equipment.door_open'] : d.door_open,
          last_seen: msg.time || d.last_seen,
        }
      }))
    }))

    wsUnsubs.push(on('state_full', (msg) => {
      devices.update(list => list.map(d => {
        if (d.mqtt_device_id !== msg.device_id) return d
        const s = msg.state || {}
        return {
          ...d,
          air_temp: s['equipment.air_temp'] ?? d.air_temp,
          alarm_active: s['protection.alarm_active'] != null
            ? !!s['protection.alarm_active'] : d.alarm_active,
          door_open: s['equipment.door_open'] != null
            ? !!s['equipment.door_open'] : d.door_open,
          online: msg.meta?.online ?? d.online,
        }
      }))
    }))

    wsUnsubs.push(on('device_online', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id ? { ...d, online: true } : d
      ))
    }))

    wsUnsubs.push(on('device_offline', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, online: false, last_seen: msg.last_seen }
          : d
      ))
    }))

    // Подія alarm несе запис аварії, а не стан приладу. Точне число приходить із
    // наступним опитуванням; тут досить тримати ознаку живою.
    wsUnsubs.push(on('alarm', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, alarms_open: msg.active ? Math.max(1, d.alarms_open || 0) : 0 }
          : d
      ))
    }))

    // Maintenance hint opened/closed (plan epic 2.4) — keep the per-card count live
    wsUnsubs.push(on('hint', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, hints_open: Math.max(0, (d.hints_open || 0) + (msg.active ? 1 : -1)) }
          : d
      ))
    }))
  }

  onMount(() => {
    setupWsListeners()
    load()
    interval = setInterval(load, 30000)
  })

  // ── Inventory export (admin) ──────────────────────────
  let exportingInventory = false

  async function handleExportInventory() {
    exportingInventory = true
    try {
      await exportDevicesCsv()
      toast.success($t('export.export_success'))
    } catch (e) {
      if (e.status !== 402) toast.error(e.message || $t('export.export_error'))
    } finally {
      exportingInventory = false
    }
  }

  onDestroy(() => {
    clearInterval(interval)
    for (const id of subscribedIds) unsubscribe(id)
    subscribedIds.clear()
    for (const fn of wsUnsubs) fn()
  })
</script>

<div class="dashboard">
  <PageHeader title={$t('pages.dashboard')} subtitle={$t('pages.dashboard_sub')}>
    {#if $isAdmin && totalCount > 0}
      <Button variant="secondary" size="sm" icon="download" loading={exportingInventory} on:click={handleExportInventory}>
        {$t('export.export_inventory')}
      </Button>
    {/if}
  </PageHeader>

  <FleetSummaryBar
    online={onlineCount}
    total={totalCount}
    alarms={alarmCount}
    hints={hintCount}
  />

  {#if $isAdmin && !$isSuperAdmin}
    <!-- Getting-started checklist of the organisation (plan epic 2.1); dismissable -->
    <OnboardingChecklist />
  {/if}

  <DeviceFilter bind:search bind:filter bind:view />

  {#if selectedCount > 0}
    <div class="bulk-bar">
      <span class="bulk-info">
        <Icon name="check-square" size={16} />
        {$t('dashboard.selected').replace('{0}', String(selectedCount))}
      </span>
      <div class="bulk-actions">
        <Button variant="secondary" size="sm" on:click={clearSelection}>{$t('common.cancel')}</Button>
        {#if $isAdmin}
          <Button variant="secondary" size="sm" icon="thermometer" on:click={openHaccpModal}>{$t('dashboard.bulk_haccp')}</Button>
        {/if}
        <Button variant="danger" size="sm" icon="trash-2" loading={deleting} on:click={handleBulkDelete}>
          {$t('dashboard.delete_selected')}
        </Button>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="skeleton-grid">
      {#each Array(6) as _}
        <Skeleton height="140px" />
      {/each}
    </div>
  {:else if error}
    <EmptyState
      icon="x-circle"
      title={$t('dashboard.load_error')}
      message={error}
    />
  {:else if filtered.length === 0}
    {#if search || filter !== 'all'}
      <EmptyState
        icon="search"
        title={$t('dashboard.no_match')}
        message={$t('dashboard.no_match_hint')}
      />
    {:else}
      <EmptyState
        icon="wifi"
        title={$t('dashboard.no_devices')}
        message={$isAdmin ? $t('dashboard.no_devices_hint') : $t('dashboard.no_access_hint')}
      />
    {/if}
  {:else if view === 'list'}
    <div class="list-view">
      <button class="select-all-row" on:click={toggleSelectAll}>
        <input type="checkbox" checked={allFilteredSelected} tabindex="-1" />
        <span>{allFilteredSelected ? $t('dashboard.deselect_all') : $t('dashboard.select_all')}</span>
      </button>
      {#each filtered as device (device.id)}
        <DeviceListRow {device} selectable selected={selected.has(device.id)} on:toggle={(e) => toggleSelect(e.detail)} />
      {/each}
    </div>
  {:else if groups}
    {#each groups as [location, devicesInGroup]}
      {#if groups.length > 1}
        <div class="group-header">
          <Icon name="map-pin" size={14} />
          <span>{location}</span>
          <span class="group-count">{devicesInGroup.length}</span>
        </div>
      {/if}
      <div class="grid">
        {#each devicesInGroup as device (device.id)}
          <DeviceCard {device} />
        {/each}
      </div>
    {/each}
  {:else}
    <div class="grid">
      {#each filtered as device (device.id)}
        <DeviceCard {device} />
      {/each}
    </div>
  {/if}
</div>

{#if haccpModal}
  <div class="modal-backdrop" role="presentation" on:click={() => (haccpModal = false)} on:keydown={onHaccpKey}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="haccp-bulk-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <div>
          <h2 id="haccp-bulk-title">{$t('dashboard.bulk_haccp_title')}</h2>
          <span class="modal-subtitle">{$t('dashboard.selected').replace('{0}', String(selectedCount))}</span>
        </div>
        <button class="modal-close" on:click={() => (haccpModal = false)} aria-label={$t('common.close')}><Icon name="x" size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="hint">{$t('dashboard.bulk_haccp_hint')}</p>
        <div class="form-group">
          <label for="bulk-haccp-preset">{$t('device.haccp_preset')}</label>
          <select id="bulk-haccp-preset" bind:value={haccpForm.preset} on:change={onHaccpPreset}>
            <option value="">{$t('device.haccp_preset_none')}</option>
            {#each haccpPresets as p (p.key)}
              <option value={p.key}>{p.label[$locale] || p.label.uk} — {presetRange(p)}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="bulk-haccp-product">{$t('device.haccp_product')}</label>
          <input id="bulk-haccp-product" type="text" maxlength="96" bind:value={haccpForm.haccp_product} placeholder={$t('device.haccp_product_placeholder')} />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="bulk-haccp-min">{$t('device.haccp_min')}</label>
            <input id="bulk-haccp-min" type="number" step="0.5" min="-99" max="99" bind:value={haccpForm.haccp_min} />
          </div>
          <div class="form-group">
            <label for="bulk-haccp-max">{$t('device.haccp_max')}</label>
            <input id="bulk-haccp-max" type="number" step="0.5" min="-99" max="99" bind:value={haccpForm.haccp_max} />
          </div>
          <div class="form-group">
            <label for="bulk-haccp-tol">{$t('device.haccp_tolerance')}</label>
            <input id="bulk-haccp-tol" type="number" step="0.5" min="0" max="30" bind:value={haccpForm.haccp_tolerance} />
          </div>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={haccpForm.only_empty} />
          {$t('dashboard.bulk_haccp_only_empty')}
        </label>
      </div>
      <div class="modal-actions">
        <Button variant="secondary" size="sm" on:click={() => (haccpModal = false)}>{$t('common.cancel')}</Button>
        <Button variant="primary" size="sm" loading={haccpSaving} disabled={!haccpForm.preset && haccpForm.haccp_min === '' && haccpForm.haccp_max === ''} on:click={applyHaccpBulk}>
          {$t('dashboard.bulk_haccp_apply')}
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: fade-in 0.3s ease-out;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }

  /* Stagger card entrance in grid */
  .grid > :global(*) {
    animation: slide-in-up 0.35s ease-out both;
  }
  .grid > :global(*:nth-child(1)) { animation-delay: 0ms; }
  .grid > :global(*:nth-child(2)) { animation-delay: 50ms; }
  .grid > :global(*:nth-child(3)) { animation-delay: 100ms; }
  .grid > :global(*:nth-child(4)) { animation-delay: 150ms; }
  .grid > :global(*:nth-child(5)) { animation-delay: 200ms; }
  .grid > :global(*:nth-child(6)) { animation-delay: 250ms; }
  .grid > :global(*:nth-child(n+7)) { animation-delay: 280ms; }

  .list-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
    padding: var(--space-3) 0 var(--space-1);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .group-count {
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    font-weight: 600;
  }

  .bulk-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-surface);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    animation: fade-in 0.2s ease-out;
  }

  .bulk-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--accent-blue);
  }

  .bulk-actions {
    display: flex;
    gap: var(--space-2);
  }

  .select-all-row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .select-all-row:hover { color: var(--text-secondary); }

  .select-all-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-blue);
    cursor: pointer;
  }

  /* Bulk HACCP limits modal (same look as the editor modals on Sites) */
  .modal-backdrop { position: fixed; inset: 0; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; padding: var(--space-4); }
  .modal { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
  .modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-muted); }
  .modal-header h2 { font-size: var(--text-lg); font-weight: 600; color: var(--text-primary); }
  .modal-subtitle { display: block; color: var(--text-muted); font-size: var(--text-xs); }
  .modal-close { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-muted); cursor: pointer; }
  .modal-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); color: var(--text-primary); font-size: var(--text-sm); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }
  .modal-body .hint { color: var(--text-muted); font-size: var(--text-xs); margin: 0; }
  .modal-body .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .modal-body .form-group label { font-size: var(--text-xs); color: var(--text-secondary); }
  .modal-body .form-group input, .modal-body .form-group select { padding: var(--space-2); border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: var(--text-sm); }
  .modal-body .form-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
  .modal-body .check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); cursor: pointer; }
</style>
