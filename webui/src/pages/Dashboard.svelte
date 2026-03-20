<script>
  import { onMount, onDestroy } from 'svelte'
  import { getDevices } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { devices, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import FleetSummaryBar from '../components/dashboard/FleetSummaryBar.svelte'
  import DeviceFilter from '../components/dashboard/DeviceFilter.svelte'
  import DeviceCard from '../components/DeviceCard.svelte'
  import DeviceListRow from '../components/dashboard/DeviceListRow.svelte'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import Icon from '../components/ui/Icon.svelte'

  let loading = true
  let error = null
  let interval

  // Filter state
  let search = ''
  let filter = 'all'
  let view = 'grid'

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
    if (f === 'alarm')   result = result.filter(d => d.alarm_active)
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
  $: alarmCount = $devices.filter(d => d.alarm_active).length

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

    wsUnsubs.push(on('alarm', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, alarm_active: msg.active }
          : d
      ))
    }))
  }

  onMount(() => {
    setupWsListeners()
    load()
    interval = setInterval(load, 30000)
  })

  onDestroy(() => {
    clearInterval(interval)
    for (const id of subscribedIds) unsubscribe(id)
    subscribedIds.clear()
    for (const fn of wsUnsubs) fn()
  })
</script>

<div class="dashboard">
  <PageHeader title={$t('pages.dashboard')} subtitle={$t('pages.dashboard_sub')} />

  <FleetSummaryBar
    online={onlineCount}
    total={totalCount}
    alarms={alarmCount}
  />

  <DeviceFilter bind:search bind:filter bind:view />

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
        message={$t('dashboard.no_devices_hint')}
      />
    {/if}
  {:else if view === 'list'}
    <div class="list-view">
      {#each filtered as device (device.id)}
        <DeviceListRow {device} />
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
</style>
