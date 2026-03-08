<script>
  import { onMount, onDestroy } from 'svelte'
  import { getDevice } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { navigate, liveState } from '../lib/stores.js'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Tabs from '../components/ui/Tabs.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import DeviceVitals from '../components/device/DeviceVitals.svelte'
  import ParameterEditor from '../components/device/ParameterEditor.svelte'
  import TelemetryChart from '../components/TelemetryChart.svelte'
  import AlarmHistory from '../components/AlarmHistory.svelte'
  import StateView from '../components/StateView.svelte'

  // svelte-spa-router passes route params via `params` prop
  export let params = {}
  export let deviceId = undefined
  $: resolvedId = deviceId || params.id

  let device = null
  let loading = true
  let error = null
  let unsubs = []

  let activeTab = 'chart'
  const tabs = [
    { id: 'chart',  label: 'Chart' },
    { id: 'params', label: 'Parameters' },
    { id: 'alarms', label: 'Alarms' },
    { id: 'state',  label: 'State' },
  ]

  async function loadDevice() {
    try {
      device = await getDevice(resolvedId)
      liveState.set(device.last_state || {})
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function setupWs() {
    subscribe(resolvedId)
    unsubs.push(on('state_full', (msg) => {
      // Merge with existing state (from REST API) — don't replace!
      // stateMap may not have all keys if device hasn't published them since backend start
      if (msg.device_id === resolvedId) liveState.update(s => ({ ...s, ...(msg.state || {}) }))
    }))
    unsubs.push(on('state_update', (msg) => {
      if (msg.device_id === resolvedId) liveState.update(s => ({ ...s, ...msg.changes }))
    }))
    unsubs.push(on('device_online', (msg) => {
      if (msg.device_id === resolvedId && device) device = { ...device, online: true }
    }))
    unsubs.push(on('device_offline', (msg) => {
      if (msg.device_id === resolvedId && device) device = { ...device, online: false }
    }))
  }

  onMount(() => { loadDevice(); setupWs() })
  onDestroy(() => { unsubscribe(resolvedId); for (const fn of unsubs) fn() })

  $: hasAlarm = !!$liveState['protection.alarm_active']
</script>

<div class="detail">
  <!-- Breadcrumb -->
  <div class="breadcrumb">
    <a href="#/" class="back-link">
      <Icon name="arrow-left" size={16} />
      Dashboard
    </a>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current">{resolvedId}</span>
  </div>

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="80px" />
    <Skeleton height="300px" />
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load device" message={error} />
  {:else if device}
    <!-- Device header -->
    <div class="device-header">
      <div class="header-top">
        <StatusDot status={hasAlarm ? 'alarm' : (device.online ? 'online' : 'offline')} />
        <h1 class="device-title">{device.name || device.mqtt_device_id}</h1>
        <Badge variant={device.online ? 'success' : 'neutral'}>
          {device.online ? 'Online' : 'Offline'}
        </Badge>
        {#if hasAlarm}
          <Badge variant="danger" pulse>ALARM</Badge>
        {/if}
      </div>
      <div class="header-meta">
        <span class="meta-item font-mono">ID: {device.mqtt_device_id}</span>
        {#if device.firmware_version}
          <span class="meta-item font-mono">FW: {device.firmware_version}</span>
        {/if}
        {#if device.location}
          <span class="meta-item">
            <Icon name="map-pin" size={12} />
            {device.location}
          </span>
        {/if}
      </div>
    </div>

    <!-- Vitals -->
    <DeviceVitals state={$liveState} />

    <!-- Tabs -->
    <Tabs {tabs} bind:active={activeTab} />

    <!-- Tab content -->
    <div class="tab-content">
      {#if activeTab === 'chart'}
        <TelemetryChart deviceId={resolvedId} />
      {:else if activeTab === 'params'}
        <ParameterEditor deviceId={resolvedId} state={$liveState} />
      {:else if activeTab === 'alarms'}
        <AlarmHistory deviceId={resolvedId} />
      {:else if activeTab === 'state'}
        <StateView state={$liveState} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .back-link {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--accent-blue);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .back-link:hover {
    color: var(--text-primary);
  }

  .breadcrumb-sep { color: var(--text-muted); }
  .breadcrumb-current { color: var(--text-secondary); }

  .device-header {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .device-title {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
  }

  .header-meta {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-top: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .tab-content {
    min-height: 200px;
  }
</style>
