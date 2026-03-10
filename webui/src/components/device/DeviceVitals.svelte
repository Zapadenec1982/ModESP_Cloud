<script>
  import Icon from '../ui/Icon.svelte'
  import { formatDuration } from '../../lib/format.js'
  import { t } from '../../lib/i18n.js'

  export let state = {}

  $: temp = state['equipment.air_temp']
  // Firmware publishes effective_setpoint (after night-mode adjustments);
  // thermostat.setpoint is a writable parameter, not a publish key
  $: setpoint = state['thermostat.effective_setpoint'] ?? state['thermostat.setpoint']
  // Firmware publishes equipment.compressor (bool), not thermostat.compressor_on
  $: compressorOn = state['equipment.compressor'] ?? state['thermostat.compressor_on']
  // Runtime is published as thermostat.comp_on_time (seconds)
  $: compressorRuntime = state['thermostat.comp_on_time'] ?? state['thermostat.compressor_runtime']
  $: defrostActive = state['defrost.active']
  $: defrostPhase = state['defrost.phase'] ?? state['defrost.state']
</script>

<div class="vitals stagger-enter">
  <div class="vital" class:alarm={state['protection.alarm_active']}>
    <div class="vital-icon temp-icon">
      <Icon name="thermometer" size={20} />
    </div>
    <div class="vital-data">
      <span class="vital-value" class:alarm={state['protection.alarm_active']}>
        {temp != null ? Number(temp).toFixed(1) : '--'}
        <span class="vital-unit">°C</span>
      </span>
      <span class="vital-label">{$t('device.temperature')}</span>
    </div>
    <div class="vital-accent temp" />
  </div>

  <div class="vital">
    <div class="vital-icon setpoint-icon">
      <Icon name="settings" size={20} />
    </div>
    <div class="vital-data">
      <span class="vital-value">
        {setpoint != null ? Number(setpoint).toFixed(1) : '--'}
        <span class="vital-unit">°C</span>
      </span>
      <span class="vital-label">{$t('device.setpoint')}</span>
    </div>
    <div class="vital-accent setpoint" />
  </div>

  <div class="vital">
    <div class="vital-icon" class:compressor-on={compressorOn}>
      <Icon name="zap" size={20} />
    </div>
    <div class="vital-data">
      <span class="vital-value" class:on={compressorOn}>
        {compressorOn ? $t('device.on') : $t('device.off')}
        {#if compressorOn && compressorRuntime}
          <span class="vital-detail">{formatDuration(compressorRuntime)}</span>
        {/if}
      </span>
      <span class="vital-label">{$t('device.compressor')}</span>
    </div>
    <div class="vital-accent" class:compressor-active={compressorOn} />
  </div>

  <div class="vital">
    <div class="vital-icon" class:defrost-on={defrostActive}>
      <Icon name="snowflake" size={20} />
    </div>
    <div class="vital-data">
      <span class="vital-value" class:on={defrostActive}>
        {defrostActive ? (defrostPhase || $t('common.active')) : $t('device.off')}
      </span>
      <span class="vital-label">{$t('device.defrost')}</span>
    </div>
    <div class="vital-accent" class:defrost-active={defrostActive} />
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
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
    overflow: hidden;
    transition: border-color var(--transition-normal);
  }

  .vital.alarm {
    border-color: rgba(239, 68, 68, 0.3);
    box-shadow: var(--shadow-glow-red);
  }

  .vital-accent {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--border-muted);
    opacity: 0.3;
  }

  .vital-accent.temp { background: linear-gradient(90deg, var(--accent-cyan), var(--accent-blue)); opacity: 0.5; }
  .vital-accent.setpoint { background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple)); opacity: 0.4; }
  .vital-accent.compressor-active { background: linear-gradient(90deg, var(--accent-green), var(--accent-cyan)); opacity: 0.6; }
  .vital-accent.defrost-active { background: linear-gradient(90deg, var(--accent-cyan), #fff); opacity: 0.5; }

  .vital-icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    transition: all var(--transition-fast);
  }

  .temp-icon     { color: var(--accent-cyan);  background: rgba(34, 211, 238, 0.1); }
  .setpoint-icon { color: var(--accent-blue);  background: rgba(74, 158, 255, 0.1); }
  .compressor-on { color: var(--accent-green); background: rgba(52, 211, 153, 0.12); }
  .defrost-on    { color: var(--accent-cyan);  background: rgba(34, 211, 238, 0.12); }

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
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
</style>
