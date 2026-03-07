<script>
  import { onMount, onDestroy } from 'svelte';
  import { getDevices, getFleetSummary } from '../lib/api.js';
  import { subscribe, unsubscribe, on } from '../lib/ws.js';
  import { devices } from '../lib/stores.js';
  import DeviceCard from '../components/DeviceCard.svelte';

  let loading = true;
  let error = null;
  let interval;

  let fleet = null;

  /** Track which device IDs we've subscribed to via WS */
  let subscribedIds = new Set();
  let wsUnsubs = [];

  async function load() {
    try {
      const [data, summary] = await Promise.all([
        getDevices(),
        getFleetSummary().catch(() => null),
      ]);
      devices.set(data);
      fleet = summary;
      error = null;
      // Subscribe to WS for all loaded devices
      syncWsSubscriptions(data);
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  /** Subscribe to WS for all visible devices to get real-time updates */
  function syncWsSubscriptions(deviceList) {
    const newIds = new Set(deviceList.map(d => d.mqtt_device_id));

    // Unsubscribe from devices no longer in list
    for (const id of subscribedIds) {
      if (!newIds.has(id)) {
        unsubscribe(id);
        subscribedIds.delete(id);
      }
    }

    // Subscribe to new devices
    for (const id of newIds) {
      if (!subscribedIds.has(id)) {
        subscribe(id);
        subscribedIds.add(id);
      }
    }
  }

  function setupWsListeners() {
    // Real-time state updates → update air_temp and alarm_active on cards
    wsUnsubs.push(on('state_update', (msg) => {
      devices.update(list => list.map(d => {
        if (d.mqtt_device_id !== msg.device_id) return d;
        const changes = msg.changes || {};
        return {
          ...d,
          air_temp: changes['equipment.air_temp'] !== undefined
            ? changes['equipment.air_temp'] : d.air_temp,
          alarm_active: changes['protection.alarm_active'] !== undefined
            ? !!changes['protection.alarm_active'] : d.alarm_active,
          last_seen: msg.time || d.last_seen,
        };
      }));
    }));

    // state_full → merge full state snapshot into device card
    wsUnsubs.push(on('state_full', (msg) => {
      devices.update(list => list.map(d => {
        if (d.mqtt_device_id !== msg.device_id) return d;
        const s = msg.state || {};
        return {
          ...d,
          air_temp: s['equipment.air_temp'] ?? d.air_temp,
          alarm_active: s['protection.alarm_active'] != null
            ? !!s['protection.alarm_active'] : d.alarm_active,
          online: msg.meta?.online ?? d.online,
        };
      }));
    }));

    // Device online/offline
    wsUnsubs.push(on('device_online', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id ? { ...d, online: true } : d
      ));
    }));

    wsUnsubs.push(on('device_offline', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, online: false, last_seen: msg.last_seen }
          : d
      ));
    }));

    // Alarm events
    wsUnsubs.push(on('alarm', (msg) => {
      devices.update(list => list.map(d =>
        d.mqtt_device_id === msg.device_id
          ? { ...d, alarm_active: msg.active }
          : d
      ));
    }));
  }

  onMount(() => {
    setupWsListeners();
    load();
    interval = setInterval(load, 30000); // full REST refresh every 30s as fallback
  });

  onDestroy(() => {
    clearInterval(interval);
    // Unsubscribe from all WS device subscriptions
    for (const id of subscribedIds) {
      unsubscribe(id);
    }
    subscribedIds.clear();
    for (const fn of wsUnsubs) fn();
  });
</script>

<div class="dashboard">
  <div class="header">
    <h1>Devices</h1>
    <button class="btn-refresh" on:click={load}>Refresh</button>
  </div>

  {#if fleet}
    <div class="fleet-summary">
      <div class="fleet-stat">
        <span class="fleet-value">{fleet.devices_online}</span>
        <span class="fleet-label">Online</span>
      </div>
      <div class="fleet-stat">
        <span class="fleet-value">{fleet.devices_total}</span>
        <span class="fleet-label">Total Devices</span>
      </div>
      <div class="fleet-stat" class:alert={fleet.alarms_active > 0}>
        <span class="fleet-value">{fleet.alarms_active}</span>
        <span class="fleet-label">Active Alarms</span>
      </div>
      <div class="fleet-stat">
        <span class="fleet-value">{fleet.alarms_24h}</span>
        <span class="fleet-label">Alarms (24h)</span>
      </div>
    </div>
  {/if}

  {#if loading}
    <p class="status-msg">Loading devices...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else if $devices.length === 0}
    <p class="status-msg">No devices found. Connect an ESP32 to get started.</p>
  {:else}
    <div class="grid">
      {#each $devices as device (device.id)}
        <DeviceCard {device} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .btn-refresh {
    padding: 0.4rem 1rem;
    background: #2d3436;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-refresh:hover {
    background: #636e72;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .status-msg {
    text-align: center;
    color: #636e72;
    padding: 2rem;
    font-size: 1rem;
  }

  .status-msg.error {
    color: #e17055;
  }

  .fleet-summary {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .fleet-stat {
    flex: 1;
    min-width: 120px;
    background: white;
    border: 1px solid #dfe6e9;
    border-radius: 12px;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .fleet-stat.alert {
    border-color: #d63031;
    background: #fff5f5;
  }

  .fleet-value {
    font-size: 1.75rem;
    font-weight: 700;
    color: #2d3436;
  }

  .fleet-stat.alert .fleet-value {
    color: #d63031;
  }

  .fleet-label {
    font-size: 0.75rem;
    color: #636e72;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
</style>
