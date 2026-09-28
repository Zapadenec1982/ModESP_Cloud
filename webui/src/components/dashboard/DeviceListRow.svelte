<script>
  import { createEventDispatcher } from 'svelte'
  import { navigate } from '../../lib/stores.js'
  import { timeAgo, durationSince } from '../../lib/format.js'
  import { tempState, haccpRangeLabel } from '../../lib/haccp.js'
  import { t } from '../../lib/i18n.js'
  import StatusDot from '../ui/StatusDot.svelte'
  import Icon from '../ui/Icon.svelte'

  export let device
  export let selectable = false
  export let selected = false
  // The dashboard's clock tick, see DeviceCard
  export let now = Date.now()

  const dispatch = createEventDispatcher()

  $: temp = device.air_temp != null ? Number(device.air_temp).toFixed(1) : '--'
  $: status = device.status === 'pending' ? 'pending'
    : device.online ? 'online' : 'offline'
  $: hasAlarm = (device.alarms_open || 0) > 0
  // Same three axes as the card: connectivity, temperature against the HACCP
  // range, operating mode. The figure is red for temperature only.
  $: range = haccpRangeLabel(device)
  $: tempOut = tempState(device) === 'out_of_range' || !!device.temp_alarm_since
  $: outFor = device.temp_alarm_since ? durationSince(device.temp_alarm_since, now) : ''
  $: showMode = device.online && device.status !== 'pending' && (device.compressor != null || device.defrost != null)
  // Second line under the name: organisation (superadmin) · site · free-text location
  $: where = [device.tenant_name, device.site_name, device.location].filter(Boolean).join(' · ')

  // One handler on the row <button>: a click anywhere inside the checkbox cell
  // toggles selection, anything else opens the device. Keeping the toggle here
  // (instead of on a nested <div on:click>) keeps the only interactive element
  // a real, keyboard-reachable button.
  function handleClick(e) {
    if (selectable && (e.target.type === 'checkbox' || e.target.closest('.cell-check'))) {
      dispatch('toggle', device.id)
      return
    }
    navigate(`/device/${device.mqtt_device_id}`)
  }
</script>

<button class="row" class:selected on:click={handleClick}>
  {#if selectable}
    <div class="cell cell-check">
      <input type="checkbox" checked={selected} tabindex="-1" />
    </div>
  {/if}
  <div class="cell cell-status">
    <StatusDot {status} size="sm" />
  </div>
  <div class="cell cell-name">
    <span class="name truncate">{device.name || device.mqtt_device_id}</span>
    {#if where}
      <span class="location truncate" class:tenant-label={!!device.tenant_name}>{where}</span>
    {/if}
  </div>
  {#if showMode}
    <div class="cell cell-mode">
      {#if device.compressor != null}
        <span class="mode-chip compressor" class:on={device.compressor} title="{$t('device.compressor')}: {device.compressor ? $t('device.on') : $t('device.off')}">
          <Icon name="zap" size={12} />
        </span>
      {/if}
      {#if device.defrost != null}
        <span class="mode-chip defrost" class:on={device.defrost} title="{$t('device.defrost')}: {device.defrost ? $t('device.on') : $t('device.off')}">
          <Icon name="snowflake" size={12} />
        </span>
      {/if}
    </div>
  {/if}
  {#if tempOut}
    <div class="cell cell-out">{outFor ? $t('device.out_of_range_for', outFor) : $t('device.out_of_range')}</div>
  {/if}
  <div class="cell cell-temp">
    <span class="temp-line">
      <span class="temp-value" class:alarm={tempOut}>{temp}</span>
      <span class="temp-unit">°C</span>
    </span>
    {#if range}
      <span class="range" title={$t('device.haccp_range')}>{range}</span>
    {/if}
  </div>
  <div class="cell cell-id font-mono">{device.mqtt_device_id}</div>
  <div class="cell cell-seen">{timeAgo(device.last_seen)}</div>
  {#if device.door_open}
    <div class="cell cell-door" title={$t('device.door_open')}>
      <Icon name="door-open" size={14} />
    </div>
  {/if}
  {#if hasAlarm}
    <div class="cell cell-alarm" title={$t('device.alarm_badge')}>
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
    box-sizing: border-box;
    text-align: left;
  }

  .row:hover {
    background: var(--bg-tertiary);
    border-color: var(--text-muted);
  }

  .row:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 2px;
  }

  .row.selected {
    background: var(--bg-tertiary);
    border-color: var(--accent-blue);
  }

  .cell { flex-shrink: 0; }

  .cell-check {
    width: 24px;
    display: flex;
    justify-content: center;
    cursor: pointer;
  }

  .cell-check input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-blue);
    cursor: pointer;
  }

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

  .tenant-label {
    color: var(--accent-cyan);
  }

  .cell-mode {
    display: flex;
    gap: 4px;
  }

  .mode-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-muted);
    color: var(--text-muted);
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

  .cell-out {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--accent-red);
    background: rgba(239, 68, 68, 0.1);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .cell-temp {
    width: 96px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }

  .temp-line { white-space: nowrap; }

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

  .range {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
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

  .cell-door {
    width: 20px;
    color: var(--accent-yellow);
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .cell-id, .cell-seen, .cell-out { display: none; }
    .cell-temp { width: 72px; }
  }
</style>
