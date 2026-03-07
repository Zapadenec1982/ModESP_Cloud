<script>
  import { onMount } from 'svelte';
  import { getPendingDevices, assignDevice } from '../lib/api.js';

  let devices = [];
  let loading = true;
  let error = null;

  // Assign form state
  let assigningId = null;
  let assignName = '';
  let assignLocation = '';
  let assignStatus = '';

  async function load() {
    try {
      devices = await getPendingDevices();
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function startAssign(mqttId) {
    assigningId = mqttId;
    assignName = '';
    assignLocation = '';
    assignStatus = '';
  }

  function cancelAssign() {
    assigningId = null;
  }

  async function confirmAssign() {
    assignStatus = 'Assigning...';
    try {
      await assignDevice(assigningId, {
        name: assignName || undefined,
        location: assignLocation || undefined,
      });
      assignStatus = 'Assigned!';
      assigningId = null;
      // Reload the list
      await load();
    } catch (e) {
      assignStatus = `Error: ${e.message}`;
    }
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  onMount(load);
</script>

<div class="pending">
  <div class="header">
    <h1>Pending Devices</h1>
    <button class="btn-refresh" on:click={load}>Refresh</button>
  </div>

  {#if loading}
    <p class="status-msg">Loading...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else if devices.length === 0}
    <p class="status-msg">No pending devices. New devices will appear here automatically.</p>
  {:else}
    <div class="list">
      {#each devices as dev (dev.id)}
        <div class="device-row">
          <div class="row-info">
            <div class="dot" class:online={dev.online}></div>
            <span class="mqtt-id">{dev.mqtt_device_id}</span>
            {#if dev.firmware_version}
              <span class="fw">FW: {dev.firmware_version}</span>
            {/if}
            <span class="seen">{timeAgo(dev.last_seen)}</span>
          </div>

          {#if assigningId === dev.mqtt_device_id}
            <form on:submit|preventDefault={confirmAssign} class="assign-form">
              <input type="text" bind:value={assignName} placeholder="Name (optional)" class="input" />
              <input type="text" bind:value={assignLocation} placeholder="Location (optional)" class="input" />
              <button type="submit" class="btn btn-primary">Assign</button>
              <button type="button" class="btn btn-secondary" on:click={cancelAssign}>Cancel</button>
              {#if assignStatus}
                <span class="assign-status">{assignStatus}</span>
              {/if}
            </form>
          {:else}
            <button class="btn btn-primary" on:click={() => startAssign(dev.mqtt_device_id)}>
              Assign to Tenant
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pending {
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
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .device-row {
    background: white;
    border: 1px solid #dfe6e9;
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .row-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #b2bec3;
  }

  .dot.online {
    background: #00b894;
    box-shadow: 0 0 6px #00b894;
  }

  .mqtt-id {
    font-weight: 700;
    font-family: 'SF Mono', 'Consolas', monospace;
    font-size: 1rem;
  }

  .fw, .seen {
    font-size: 0.8rem;
    color: #636e72;
  }

  .assign-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .input {
    padding: 0.4rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .input:focus {
    outline: none;
    border-color: #0984e3;
  }

  .btn {
    padding: 0.4rem 1rem;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .btn-primary {
    background: #0984e3;
    color: white;
  }

  .btn-secondary {
    background: #dfe6e9;
    color: #2d3436;
  }

  .assign-status {
    font-size: 0.8rem;
    color: #636e72;
  }

  .status-msg {
    text-align: center;
    color: #636e72;
    padding: 2rem;
  }

  .status-msg.error {
    color: #e17055;
  }
</style>
