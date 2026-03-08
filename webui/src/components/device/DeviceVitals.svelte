<script>
  import Icon from '../ui/Icon.svelte'
  import { formatDuration } from '../../lib/format.js'

  export let state = {}

  $: temp = state['equipment.air_temp']
  $: setpoint = state['thermostat.setpoint']
  $: compressorOn = state['thermostat.compressor_on']
  $: compressorRuntime = state['thermostat.compressor_runtime']
  $: defrostActive = state['defrost.active']
  $: defrostPhase = state['defrost.phase']
</script>

<div class="vitals">
  <div class="vital">
    <Icon name="thermometer" size={18} />
    <div class="vital-data">
      <span class="vital-value" class:alarm={state['protection.alarm_active']}>
        {temp != null ? temp.toFixed(1) : '--'}
        <span class="vital-unit">°C</span>
      </span>
      <span class="vital-label">Temperature</span>
    </div>
  </div>

  <div class="vital">
    <Icon name="settings" size={18} />
    <div class="vital-data">
      <span class="vital-value">
        {setpoint != null ? setpoint.toFixed(1) : '--'}
        <span class="vital-unit">°C</span>
      </span>
      <span class="vital-label">Setpoint</span>
    </div>
  </div>

  <div class="vital">
    <Icon name="zap" size={18} />
    <div class="vital-data">
      <span class="vital-value" class:on={compressorOn}>
        {compressorOn ? 'ON' : 'OFF'}
        {#if compressorOn && compressorRuntime}
          <span class="vital-detail">{formatDuration(compressorRuntime)}</span>
        {/if}
      </span>
      <span class="vital-label">Compressor</span>
    </div>
  </div>

  <div class="vital">
    <Icon name="snowflake" size={18} />
    <div class="vital-data">
      <span class="vital-value" class:on={defrostActive}>
        {defrostActive ? (defrostPhase || 'Active') : 'OFF'}
      </span>
      <span class="vital-label">Defrost</span>
    </div>
  </div>
</div>

<style>
  .vitals {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3);
  }

  @media (max-width: 768px) {
    .vitals {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .vital {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    color: var(--text-muted);
  }

  .vital-data {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .vital-value {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono);
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .vital-value.alarm { color: var(--accent-red); }
  .vital-value.on { color: var(--accent-green); }

  .vital-unit {
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--text-muted);
  }

  .vital-detail {
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-secondary);
  }

  .vital-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
