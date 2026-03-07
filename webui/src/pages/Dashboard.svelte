<script>
  import { onMount, onDestroy } from 'svelte';
  import { getDevices } from '../lib/api.js';
  import { subscribe, unsubscribe, on } from '../lib/ws.js';
  import { devices } from '../lib/stores.js';
  import DeviceCard from '../components/DeviceCard.svelte';

  let loading = true;
  let error = null;
  let interval;

  /** Track which device IDs we've subscribed to via WS */
  let subscribedIds = new Set();
  let wsUnsubs = [];

  async function load() {
    try {
      const data = await getDevices();
      devices.set(data);
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
</style>
