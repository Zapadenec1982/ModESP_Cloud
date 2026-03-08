<script>
  import { t } from '../lib/i18n.js'
  import { categoryLabel } from '../lib/meta.js'

  export let state = {}

  // Group keys by prefix: equipment.*, protection.*, thermostat.*, defrost.*, datalogger.*
  $: groups = groupState(state)

  function groupState(s) {
    const map = {}
    for (const [key, value] of Object.entries(s)) {
      const dot = key.indexOf('.')
      const group = dot > 0 ? key.slice(0, dot) : 'other'
      const name  = dot > 0 ? key.slice(dot + 1) : key
      if (!map[group]) map[group] = []
      map[group].push({ key, name, value })
    }
    // Sort groups
    const order = ['equipment', 'thermostat', 'protection', 'defrost', 'datalogger', 'other']
    return order
      .filter(g => map[g])
      .map(g => ({ group: g, items: map[g] }))
  }

  function formatValue(val) {
    if (val === true)  return $t('device.on')
    if (val === false) return $t('device.off')
    if (typeof val === 'number') {
      return Number.isInteger(val) ? val.toString() : val.toFixed(2)
    }
    return String(val)
  }

  function isAlarm(key) {
    return key.includes('alarm') && (key.endsWith('_alarm') || key === 'protection.alarm_active')
  }

  function isActive(key, value) {
    return isAlarm(key) && value === true
  }
</script>

<div class="state-view">
  {#each groups as { group, items }}
    <div class="group">
      <h3 class="group-title">{categoryLabel(group)}</h3>
      <div class="items">
        {#each items as { key, name, value }}
          <div class="item" class:alarm-active={isActive(key, value)}>
            <span class="item-name">{name}</span>
            <span class="item-value" class:bool-on={value === true} class:bool-off={value === false}>
              {formatValue(value)}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .state-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .group-title {
    font-size: var(--text-sm);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }

  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-1);
  }

  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }

  .item.alarm-active {
    background: rgba(239, 68, 68, 0.1);
    border-left: 3px solid var(--accent-red);
  }

  .item-name {
    color: var(--text-muted);
  }

  .item-value {
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  .bool-on {
    color: var(--accent-green);
  }

  .bool-off {
    color: var(--text-muted);
  }
</style>
