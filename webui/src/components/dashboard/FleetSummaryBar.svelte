<script>
  import Icon from '../ui/Icon.svelte'

  export let online = 0
  export let total = 0
  export let alarms = 0
  export let avgTemp = null

  $: offlineCount = total - online
</script>

<div class="fleet-bar">
  <div class="stat">
    <div class="stat-icon online">
      <Icon name="wifi" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">{online}</span>
      <span class="stat-label">Online</span>
    </div>
  </div>

  <div class="stat">
    <div class="stat-icon total">
      <Icon name="grid" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">{total}</span>
      <span class="stat-label">Total</span>
    </div>
  </div>

  <div class="stat" class:alarm={alarms > 0}>
    <div class="stat-icon" class:alarm-icon={alarms > 0}>
      <Icon name="alert-triangle" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">{alarms}</span>
      <span class="stat-label">Alarms</span>
    </div>
  </div>

  <div class="stat">
    <div class="stat-icon temp">
      <Icon name="thermometer" size={18} />
    </div>
    <div class="stat-content">
      <span class="stat-value">
        {avgTemp != null ? avgTemp.toFixed(1) + '°' : '--'}
      </span>
      <span class="stat-label">Avg Temp</span>
    </div>
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
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    transition: border-color var(--transition-fast);
  }

  .stat.alarm {
    border-color: var(--accent-red);
    background: rgba(248, 81, 73, 0.06);
  }

  .stat-icon {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }

  .stat-icon.online { color: var(--accent-green); }
  .stat-icon.total { color: var(--accent-blue); }
  .stat-icon.temp { color: var(--accent-yellow); }
  .stat-icon.alarm-icon {
    color: var(--accent-red);
    background: rgba(248, 81, 73, 0.1);
  }

  .stat-content {
    display: flex;
    flex-direction: column;
  }

  .stat-value {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.2;
  }

  .stat.alarm .stat-value {
    color: var(--accent-red);
  }

  .stat-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
</style>
