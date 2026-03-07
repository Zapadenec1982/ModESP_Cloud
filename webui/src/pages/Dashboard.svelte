<script>
  import { onMount, onDestroy } from 'svelte';
  import { getDevices } from '../lib/api.js';
  import { devices } from '../lib/stores.js';
  import DeviceCard from '../components/DeviceCard.svelte';

  let loading = true;
  let error = null;
  let interval;

  async function load() {
    try {
      const data = await getDevices();
      devices.set(data);
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    interval = setInterval(load, 30000); // refresh every 30s
  });

  onDestroy(() => {
    clearInterval(interval);
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
