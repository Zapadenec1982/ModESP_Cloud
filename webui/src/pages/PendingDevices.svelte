<script>
  import { onMount } from 'svelte'
  import { getPendingDevices, assignDevice } from '../lib/api.js'
  import { timeAgo } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'

  let devices = []
  let loading = true
  let error = null

  // Assign modal state
  let assigningDevice = null
  let assignName = ''
  let assignLocation = ''
  let assigning = false

  async function load() {
    try {
      devices = await getPendingDevices()
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function openAssign(dev) {
    assigningDevice = dev
    assignName = ''
    assignLocation = ''
  }

  function closeAssign() {
    assigningDevice = null
  }

  async function confirmAssign() {
    if (!assigningDevice) return
    assigning = true
    try {
      await assignDevice(assigningDevice.mqtt_device_id, {
        name: assignName || undefined,
        location: assignLocation || undefined,
      })
      toast.success(`Device ${assigningDevice.mqtt_device_id} assigned`)
      assigningDevice = null
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      assigning = false
    }
  }

  onMount(load)
</script>

<div class="pending-page">
  <PageHeader title="Pending Devices" subtitle="Unassigned devices waiting for tenant assignment">
    <Button variant="secondary" icon="refresh" on:click={load}>Refresh</Button>
  </PageHeader>

  {#if loading}
    <div class="skeleton-list">
      {#each Array(3) as _}
        <Skeleton height="80px" />
      {/each}
    </div>
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load" message={error} />
  {:else if devices.length === 0}
    <EmptyState
      icon="wifi"
      title="No pending devices"
      message="New devices will appear here automatically when they connect for the first time"
    />
  {:else}
    <div class="device-list">
      {#each devices as dev (dev.id)}
        <div class="device-row">
          <div class="device-info">
            <StatusDot status={dev.online ? 'online' : 'offline'} />
            <span class="device-id">{dev.mqtt_device_id}</span>
            {#if dev.firmware_version}
              <Badge variant="neutral" size="sm">FW: {dev.firmware_version}</Badge>
            {/if}
            <Badge variant={dev.online ? 'success' : 'neutral'} size="sm">
              {dev.online ? 'Online' : 'Offline'}
            </Badge>
          </div>
          <div class="device-meta">
            <span class="meta-item">
              <Icon name="clock" size={12} />
              {timeAgo(dev.last_seen)}
            </span>
          </div>
          <div class="device-actions">
            <Button variant="primary" size="sm" on:click={() => openAssign(dev)}>
              Assign to Tenant
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Assign Modal -->
{#if assigningDevice}
  <div class="modal-backdrop" role="presentation" on:click={closeAssign} on:keydown={() => {}}>
    <div class="modal" role="dialog" on:click|stopPropagation on:keydown={() => {}}>
      <div class="modal-header">
        <h3>Assign Device</h3>
        <button class="close-btn" on:click={closeAssign}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <div class="assign-device-info">
          <StatusDot status={assigningDevice.online ? 'online' : 'offline'} />
          <span class="device-id">{assigningDevice.mqtt_device_id}</span>
          {#if assigningDevice.firmware_version}
            <Badge variant="neutral" size="sm">v{assigningDevice.firmware_version}</Badge>
          {/if}
        </div>

        <label class="field">
          <span>Device Name</span>
          <input type="text" bind:value={assignName} placeholder="e.g. Cold Room #1" />
        </label>

        <label class="field">
          <span>Location</span>
          <input type="text" bind:value={assignLocation} placeholder="e.g. Warehouse A" />
        </label>
      </div>

      <div class="modal-actions">
        <Button variant="secondary" on:click={closeAssign} disabled={assigning}>Cancel</Button>
        <Button variant="primary" on:click={confirmAssign} loading={assigning}>Assign</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pending-page {
    display: flex;
    flex-direction: column;
    animation: fade-in 0.3s ease-out;
  }

  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .device-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .device-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    transition: border-color var(--transition-fast);
  }

  .device-row:hover {
    border-color: var(--text-muted);
  }

  .device-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .device-id {
    font-weight: 700;
    font-family: var(--font-mono);
    font-size: var(--text-base);
    color: var(--text-primary);
  }

  .device-meta {
    display: flex;
    gap: var(--space-3);
    flex-shrink: 0;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .device-actions {
    flex-shrink: 0;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fade-in 0.15s ease-out;
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 90%;
    max-width: 440px;
    box-shadow: var(--shadow-lg);
    animation: slide-in-up 0.2s ease-out;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h3 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
  }

  .close-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }

  .modal-body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .assign-device-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-md);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field span {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .field input {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    transition: border-color var(--transition-fast);
  }

  .field input::placeholder {
    color: var(--text-muted);
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.1);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-muted);
  }

  @media (max-width: 640px) {
    .device-row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .device-actions {
      align-self: flex-end;
    }
  }
</style>
