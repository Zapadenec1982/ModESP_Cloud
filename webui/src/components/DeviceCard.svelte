<script>
  import { navigate } from '../lib/stores.js'
  import { timeAgo, durationSince } from '../lib/format.js'
  import { tempState, haccpRangeLabel } from '../lib/haccp.js'
  import { t } from '../lib/i18n.js'
  import StatusDot from './ui/StatusDot.svelte'
  import Icon from './ui/Icon.svelte'

  export let device
  // The dashboard's clock tick: every card recomputes «поза межею N хв» from it
  // instead of running a timer of its own.
  export let now = Date.now()

  $: online = device.online
  $: temp = device.air_temp != null ? Number(device.air_temp).toFixed(1) : '--'
  $: statusKey = device.status === 'pending' ? 'pending' : (online ? 'online' : 'offline')
  $: hasAlarm = (device.alarms_open || 0) > 0
  $: hasHint = (device.hints_open || 0) > 0
  $: doorOpen = !!device.door_open
  $: stripe = hasAlarm ? 'alarm' : statusKey

  // Three separate axes on one card: connectivity (dot, status tag), the
  // temperature against the organisation's HACCP range (the figure and the
  // «поза межею» badge), and the operating mode (compressor / defrost chips).
  // The figure turns red only for temperature — a live reading past the range
  // or a recorded temperature alarm — never for a door or a cycling alarm;
  // those keep the alarm badge in the header.
  $: range = haccpRangeLabel(device)
  $: state = tempState(device)
  $: tempOut = state === 'out_of_range' || !!device.temp_alarm_since
  $: outFor = device.temp_alarm_since ? durationSince(device.temp_alarm_since, now) : ''
  // Mode chips mean something only while the device is talking to us; null =
  // the controller never published the key, and the chip is not shown.
  $: showMode = online && device.status !== 'pending' && (device.compressor != null || device.defrost != null)

  function handleClick() {
    navigate(`/device/${device.mqtt_device_id}`)
  }
</script>

<button class="card" class:alarm={hasAlarm} class:online class:temp-out={tempOut} on:click={handleClick}>
  <div class="stripe {stripe}" />

  <div class="card-inner">
    <div class="card-header">
      <StatusDot status={hasAlarm ? 'alarm' : statusKey} size="sm" />
      <span class="device-name truncate">{device.name || device.mqtt_device_id}</span>
      {#if doorOpen}
        <span class="door-badge" title={$t('device.door_open')}>
          <Icon name="door-open" size={12} />
        </span>
      {/if}
      {#if hasAlarm}
        <span class="alarm-badge">
          <Icon name="alert-triangle" size={12} />
          {$t('device.alarm_badge')}
        </span>
      {/if}
      {#if hasHint && !hasAlarm}
        <span class="hint-badge" title={$t('hint.title')}>
          <Icon name="wrench" size={12} />
        </span>
      {/if}
    </div>

    <div class="card-body">
      <div class="temp-col">
        <div class="temp-block">
          <span class="temp-value" class:temp-alarm={tempOut}>{temp}</span>
          <span class="temp-unit">°C</span>
        </div>
        {#if range || tempOut}
          <div class="range-line">
            {#if range}
              <span class="range" title={$t('device.haccp_range')}>{range}</span>
            {/if}
            {#if tempOut}
              <span class="out-badge">{outFor ? $t('device.out_of_range_for', outFor) : $t('device.out_of_range')}</span>
            {/if}
          </div>
        {/if}
      </div>
      <div class="meta">
        <span class="status-tag {statusKey}">{$t(`common.${statusKey}`)}</span>
        <span class="last-seen">{timeAgo(device.last_seen)}</span>
        {#if showMode}
          <span class="mode">
            {#if device.compressor != null}
              <span class="mode-chip compressor" class:on={device.compressor} title="{$t('device.compressor')}: {device.compressor ? $t('device.on') : $t('device.off')}">
                <Icon name="zap" size={11} />
                {$t('device.compressor')}
              </span>
            {/if}
            {#if device.defrost != null}
              <span class="mode-chip defrost" class:on={device.defrost} title="{$t('device.defrost')}: {device.defrost ? $t('device.on') : $t('device.off')}">
                <Icon name="snowflake" size={11} />
                {$t('device.defrost')}
              </span>
            {/if}
          </span>
        {/if}
      </div>
    </div>

    {#if device.tenant_slug || device.site_name || device.location || device.model || device.firmware_version}
      <div class="card-footer">
        {#if device.tenant_slug}
          <span class="footer-item tenant-badge">
            <Icon name="building" size={12} />
            {device.tenant_name || device.tenant_slug}
          </span>
        {/if}
        {#if device.site_name || device.location}
          <span class="footer-item">
            <Icon name="map-pin" size={12} />
            {[device.site_name, device.location].filter(Boolean).join(' · ')}
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

  .card:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 2px;
  }

  .card.online:hover {
    box-shadow: var(--shadow-md), 0 0 20px rgba(52, 211, 153, 0.1);
  }

  .card.alarm,
  .card.temp-out {
    border-color: rgba(239, 68, 68, 0.25);
    box-shadow: 0 0 12px rgba(239, 68, 68, 0.08);
  }

  .card.alarm:hover,
  .card.temp-out:hover {
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

  .hint-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(74, 158, 255, 0.12);
    color: var(--accent-blue);
    padding: 3px;
    border-radius: var(--radius-full);
  }

  .door-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(251, 191, 36, 0.12);
    color: var(--accent-yellow);
    padding: 3px;
    border-radius: var(--radius-full);
    flex-shrink: 0;
  }

  .card-body {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .temp-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
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

  .range-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }

  .range {
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
  }

  .out-badge {
    color: var(--accent-red);
    background: rgba(239, 68, 68, 0.1);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    white-space: nowrap;
  }

  .meta {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
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

  /* Operating mode: a labelled chip per key, lit while the key is true */
  .mode {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }

  .mode-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-muted);
    color: var(--text-muted);
    background: transparent;
    white-space: nowrap;
  }

  .mode-chip.compressor.on {
    color: var(--accent-cyan);
    border-color: rgba(34, 211, 238, 0.35);
    background: rgba(34, 211, 238, 0.08);
  }

  .mode-chip.defrost.on {
    color: var(--accent-orange);
    border-color: rgba(249, 115, 22, 0.35);
    background: rgba(249, 115, 22, 0.08);
  }

  .card-footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border-muted);
    padding-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .footer-item {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .tenant-badge {
    color: var(--accent-cyan);
    font-weight: 600;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
