<script>
  import { navigate } from '../lib/stores.js'
  import { timeAgo } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import StatusDot from './ui/StatusDot.svelte'
  import Icon from './ui/Icon.svelte'

  export let device

  $: online = device.online
  $: temp = device.air_temp != null ? device.air_temp.toFixed(1) : '--'
  $: statusKey = device.status === 'pending' ? 'pending' : (online ? 'online' : 'offline')
  $: hasAlarm = !!device.alarm_active
  $: stripe = hasAlarm ? 'alarm' : statusKey

  function handleClick() {
    navigate(`/device/${device.mqtt_device_id}`)
  }
</script>

<button class="card" class:alarm={hasAlarm} class:online on:click={handleClick}>
  <div class="stripe {stripe}" />

  <div class="card-inner">
    <div class="card-header">
      <StatusDot status={hasAlarm ? 'alarm' : statusKey} size="sm" />
      <span class="device-name truncate">{device.name || device.mqtt_device_id}</span>
      {#if hasAlarm}
        <span class="alarm-badge">
          <Icon name="alert-triangle" size={12} />
          {$t('device.alarm_badge')}
        </span>
      {/if}
    </div>

    <div class="card-body">
      <div class="temp-block">
        <span class="temp-value" class:temp-alarm={hasAlarm}>{temp}</span>
        <span class="temp-unit">°C</span>
      </div>
      <div class="meta">
        <span class="status-tag {statusKey}">{$t(`common.${statusKey}`)}</span>
        <span class="last-seen">{timeAgo(device.last_seen)}</span>
      </div>
    </div>

    {#if device.location || device.model || device.firmware_version}
      <div class="card-footer">
        {#if device.location}
          <span class="footer-item">
            <Icon name="map-pin" size={12} />
            {device.location}
          </span>
        {/if}
        {#if device.model}
          <span class="footer-item">
            <Icon name="cpu" size={12} />
            {device.model}
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
    background: var(--glass-bg);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    display: flex;
    overflow: hidden;
    transition:
      border-color 0.2s ease,
      box-shadow 0.25s ease,
      transform 0.2s ease;
  }

  .card:hover {
    border-color: var(--border-default);
    box-shadow: var(--shadow-md), var(--shadow-glow-blue);
    transform: translateY(-2px);
  }

  .card.online:hover {
    box-shadow: var(--shadow-md), 0 0 20px rgba(52, 211, 153, 0.1);
  }

  .card.alarm {
    border-color: rgba(239, 68, 68, 0.25);
    box-shadow: 0 0 12px rgba(239, 68, 68, 0.08);
  }

  .card.alarm:hover {
    box-shadow: var(--shadow-md), var(--shadow-glow-red);
  }

  .stripe {
    width: 3px;
    flex-shrink: 0;
  }

  .stripe.online  { background: linear-gradient(180deg, var(--accent-green), var(--accent-cyan)); }
  .stripe.offline { background: var(--text-muted); }
  .stripe.alarm   { background: linear-gradient(180deg, var(--accent-red), var(--accent-orange)); }
  .stripe.pending { background: linear-gradient(180deg, var(--accent-yellow), var(--accent-orange)); }

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
    background: rgba(239, 68, 68, 0.12);
    color: var(--accent-red);
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.06em;
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
    letter-spacing: -0.02em;
  }

  .temp-value.temp-alarm {
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
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .status-tag.online {
    color: var(--accent-green);
    background: rgba(52, 211, 153, 0.1);
  }
  .status-tag.offline {
    color: var(--text-muted);
    background: var(--bg-tertiary);
  }
  .status-tag.pending {
    color: var(--accent-yellow);
    background: rgba(251, 191, 36, 0.1);
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
