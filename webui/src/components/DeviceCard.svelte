<script>
  import { navigate } from '../lib/stores.js'
  import { timeAgo } from '../lib/format.js'
  import StatusDot from './ui/StatusDot.svelte'
  import Icon from './ui/Icon.svelte'

  export let device

  $: online = device.online
  $: temp = device.air_temp != null ? device.air_temp.toFixed(1) : '--'
  $: statusLabel = device.status === 'pending' ? 'pending' : (online ? 'online' : 'offline')
  $: hasAlarm = !!device.alarm_active
  $: stripe = hasAlarm ? 'alarm' : online ? 'online' : 'offline'

  function handleClick() {
    navigate(`/device/${device.mqtt_device_id}`)
  }
</script>

<button class="card" class:alarm={hasAlarm} on:click={handleClick}>
  <div class="stripe {stripe}" />

  <div class="card-inner">
    <div class="card-header">
      <StatusDot status={hasAlarm ? 'alarm' : statusLabel} size="sm" />
      <span class="device-name truncate">{device.name || device.mqtt_device_id}</span>
      {#if hasAlarm}
        <span class="alarm-badge">
          <Icon name="alert-triangle" size={12} />
          ALARM
        </span>
      {/if}
    </div>

    <div class="card-body">
      <div class="temp-block">
        <span class="temp-value" class:alarm={hasAlarm}>{temp}</span>
        <span class="temp-unit">°C</span>
      </div>
      <div class="meta">
        <span class="status-tag {statusLabel}">{statusLabel}</span>
        <span class="last-seen">{timeAgo(device.last_seen)}</span>
      </div>
    </div>

    {#if device.location || device.firmware_version}
      <div class="card-footer">
        {#if device.location}
          <span class="footer-item">
            <Icon name="map-pin" size={12} />
            {device.location}
          </span>
        {/if}
        {#if device.firmware_version}
          <span class="footer-item font-mono">v{device.firmware_version}</span>
        {/if}
      </div>
    {/if}
  </div>
</button>

<style>
  .card {
    all: unset;
    cursor: pointer;
    position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    display: flex;
    overflow: hidden;
    transition: all var(--transition-fast);
  }

  .card:hover {
    border-color: var(--text-muted);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
  }

  .card.alarm {
    border-color: rgba(248, 81, 73, 0.3);
  }

  .stripe {
    width: 4px;
    flex-shrink: 0;
  }

  .stripe.online { background: var(--accent-green); }
  .stripe.offline { background: var(--text-muted); }
  .stripe.alarm { background: var(--accent-red); }
  .stripe.pending { background: var(--accent-yellow); }

  .card-inner {
    flex: 1;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .device-name {
    font-weight: 600;
    font-size: var(--text-base);
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
  }

  .alarm-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(248, 81, 73, 0.15);
    color: var(--accent-red);
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.05em;
    animation: pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  .card-body {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
  }

  .temp-block {
    display: flex;
    align-items: baseline;
    gap: 2px;
  }

  .temp-value {
    font-size: var(--text-3xl);
    font-weight: 300;
    line-height: 1;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .temp-value.alarm {
    color: var(--accent-red);
  }

  .temp-unit {
    font-size: var(--text-lg);
    color: var(--text-muted);
  }

  .meta {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
  }

  .status-tag {
    text-transform: uppercase;
    font-weight: 700;
    font-size: var(--text-xs);
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .status-tag.online {
    color: var(--accent-green);
    background: rgba(63, 185, 80, 0.1);
  }
  .status-tag.offline {
    color: var(--text-muted);
    background: var(--bg-tertiary);
  }
  .status-tag.pending {
    color: var(--accent-yellow);
    background: rgba(210, 153, 34, 0.1);
  }

  .last-seen {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .card-footer {
    display: flex;
    gap: var(--space-3);
    border-top: 1px solid var(--border-muted);
    padding-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .footer-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
