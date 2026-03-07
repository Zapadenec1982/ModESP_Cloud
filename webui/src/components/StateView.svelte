<script>
  export let state = {};

  // Group keys by prefix: equipment.*, protection.*, thermostat.*, defrost.*, datalogger.*
  $: groups = groupState(state);

  function groupState(s) {
    const map = {};
    for (const [key, value] of Object.entries(s)) {
      const dot = key.indexOf('.');
      const group = dot > 0 ? key.slice(0, dot) : 'other';
      const name  = dot > 0 ? key.slice(dot + 1) : key;
      if (!map[group]) map[group] = [];
      map[group].push({ key, name, value });
    }
    // Sort groups
    const order = ['equipment', 'thermostat', 'protection', 'defrost', 'datalogger', 'other'];
    return order
      .filter(g => map[g])
      .map(g => ({ group: g, items: map[g] }));
  }

  function formatValue(val) {
    if (val === true)  return 'ON';
    if (val === false) return 'OFF';
    if (typeof val === 'number') {
      return Number.isInteger(val) ? val.toString() : val.toFixed(2);
    }
    return String(val);
  }

  function isAlarm(key) {
    return key.includes('alarm') && (key.endsWith('_alarm') || key === 'protection.alarm_active');
  }

  function isActive(key, value) {
    return isAlarm(key) && value === true;
  }
</script>

<div class="state-view">
  {#each groups as { group, items }}
    <div class="group">
      <h3 class="group-title">{group}</h3>
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
    gap: 1.5rem;
  }

  .group-title {
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #636e72;
    margin-bottom: 0.5rem;
  }

  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.25rem;
  }

  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    background: #f8f9fa;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .item.alarm-active {
    background: #ffe0d6;
    border-left: 3px solid #e17055;
  }

  .item-name {
    color: #636e72;
  }

  .item-value {
    font-weight: 600;
    font-family: 'SF Mono', 'Consolas', monospace;
  }

  .bool-on {
    color: #00b894;
  }

  .bool-off {
    color: #b2bec3;
  }
</style>
