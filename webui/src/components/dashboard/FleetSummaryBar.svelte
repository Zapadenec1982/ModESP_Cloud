<script>
  import Icon from '../ui/Icon.svelte'
  import { t } from '../../lib/i18n.js'

  export let online = 0
  export let total = 0
  export let alarms = 0
  export let avgTemp = null

  $: offlineCount = total - online
</script>

<div class="fleet-bar stagger-enter">
  <div class="stat">
    <div class="stat-icon online">
      <Icon name="wifi" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">{online}</span>
      <span class="stat-label">{$t('dashboard.fleet_online')}</span>
    </div>
    <div class="stat-accent online" />
  </div>

  <div class="stat">
    <div class="stat-icon total">
      <Icon name="grid" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">{total}</span>
      <span class="stat-label">{$t('dashboard.fleet_total')}</span>
    </div>
    <div class="stat-accent total" />
  </div>

  <div class="stat" class:alarm-active={alarms > 0}>
    <div class="stat-icon" class:alarm={alarms > 0}>
      <Icon name="alert-triangle" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value" class:alarm-text={alarms > 0}>{alarms}</span>
      <span class="stat-label">{$t('dashboard.fleet_alarms')}</span>
    </div>
    <div class="stat-accent" class:alarm={alarms > 0} />
  </div>

  <div class="stat">
    <div class="stat-icon temp">
      <Icon name="thermometer" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value temp-val">
        {avgTemp != null ? avgTemp.toFixed(1) : '--'}
        <span class="stat-unit">°C</span>
      </span>
      <span class="stat-label">{$t('dashboard.fleet_avg_temp')}</span>
    </div>
    <div class="stat-accent temp" />
  </div>
</div>

<style>
  .fleet-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3);
  }

  @media (max-width: 640px) {
    .fleet-bar {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .stat {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    overflow: hidden;
    transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
  }

  .stat:hover {
    border-color: var(--border-default);
  }

  .stat.alarm-active {
    border-color: rgba(239, 68, 68, 0.3);
    box-shadow: var(--shadow-glow-red);
  }

  /* Subtle gradient accent bar at bottom */
  .stat-accent {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    opacity: 0.4;
    background: var(--border-default);
    transition: opacity var(--transition-normal);
  }

  .stat:hover .stat-accent { opacity: 0.8; }

  .stat-accent.online { background: linear-gradient(90deg, var(--accent-green), var(--accent-cyan)); }
  .stat-accent.total { background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple)); }
  .stat-accent.alarm { background: linear-gradient(90deg, var(--accent-red), var(--accent-orange)); opacity: 0.8; }
  .stat-accent.temp { background: linear-gradient(90deg, var(--accent-cyan), var(--accent-blue)); }

  .stat-icon {
    width: 38px;
    height: 38px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    transition: color var(--transition-fast);
  }

  .stat-icon.online { color: var(--accent-green); background: rgba(52, 211, 153, 0.1); }
  .stat-icon.total  { color: var(--accent-blue);  background: rgba(74, 158, 255, 0.1); }
  .stat-icon.temp   { color: var(--accent-cyan);  background: rgba(34, 211, 238, 0.1); }
  .stat-icon.alarm  { color: var(--accent-red);   background: rgba(239, 68, 68, 0.12); }

  .stat-content {
    display: flex;
    flex-direction: column;
  }

  .stat-value {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.1;
    font-family: var(--font-mono);
    display: flex;
    align-items: baseline;
    gap: 2px;
  }

  .stat-value.alarm-text {
    color: var(--accent-red);
  }

  .stat-unit {
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--text-muted);
  }

  .stat-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    margin-top: 2px;
  }
</style>
