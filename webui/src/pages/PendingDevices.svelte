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
    gap: var(--space-4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
  }

  .btn-refresh {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .btn-refresh:hover {
    background: var(--border-default);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .device-row {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row-info {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--status-offline);
  }

  .dot.online {
    background: var(--status-online);
    box-shadow: 0 0 6px var(--status-online);
  }

  .mqtt-id {
    font-weight: 700;
    font-family: var(--font-mono);
    font-size: var(--text-base);
    color: var(--text-primary);
  }

  .fw, .seen {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .assign-form {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input::placeholder {
    color: var(--text-muted);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 600;
    transition: background var(--transition-fast);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: var(--text-inverse);
  }

  .btn-primary:hover {
    background: #4a9aef;
  }

  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
  }

  .btn-secondary:hover {
    background: var(--border-default);
  }

  .assign-status {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .status-msg {
    text-align: center;
    color: var(--text-secondary);
    padding: var(--space-6);
  }

  .status-msg.error {
    color: var(--accent-red);
  }
</style>
