<script>
  import { navigate } from '../../lib/stores.js'
  import { timeAgo } from '../../lib/format.js'
  import StatusDot from '../ui/StatusDot.svelte'
  import Icon from '../ui/Icon.svelte'

  export let device

  $: temp = device.air_temp != null ? device.air_temp.toFixed(1) : '--'
  $: status = device.status === 'pending' ? 'pending'
    : device.online ? 'online' : 'offline'
  $: alarmStatus = device.alarm_active ? 'alarm'
    : device.online ? 'online' : 'offline'

  function handleClick() {
    navigate(`/device/${device.mqtt_device_id}`)
  }
</script>

<button class="row" on:click={handleClick}>
  <div class="cell cell-status">
    <StatusDot {status} size="sm" />
  </div>
  <div class="cell cell-name">
    <span class="name truncate">{device.name || device.mqtt_device_id}</span>
    {#if device.location}
      <span class="location truncate">{device.location}</span>
    {/if}
  </div>
  <div class="cell cell-temp">
    <span class="temp-value" class:alarm={device.alarm_active}>{temp}</span>
    <span class="temp-unit">°C</span>
  </div>
  <div class="cell cell-id font-mono">{device.mqtt_device_id}</div>
  <div class="cell cell-seen">{timeAgo(device.last_seen)}</div>
  {#if device.alarm_active}
    <div class="cell cell-alarm">
      <Icon name="alert-triangle" size={14} />
    </div>
  {/if}
</button>

<style>
  .row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
    width: 100%;
    text-align: left;
  }

  .row:hover {
    background: var(--bg-tertiary);
    border-color: var(--text-muted);
  }

  .cell { flex-shrink: 0; }

  .cell-status { width: 24px; display: flex; justify-content: center; }

  .cell-name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-weight: 500;
    color: var(--text-primary);
    font-size: var(--text-base);
  }

  .location {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .cell-temp {
    width: 60px;
    text-align: right;
  }

  .temp-value {
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .temp-value.alarm {
    color: var(--accent-red);
  }

  .temp-unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .cell-id {
    width: 70px;
    color: var(--text-muted);
  }

  .cell-seen {
    width: 70px;
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-align: right;
  }

  .cell-alarm {
    width: 20px;
    color: var(--accent-red);
    animation: pulse 2s ease-in-out infinite;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .cell-id, .cell-seen { display: none; }
  }
</style>
