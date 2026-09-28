<script>
  import { createEventDispatcher } from 'svelte'
  import Icon from '../ui/Icon.svelte'
  import { t } from '../../lib/i18n.js'

  export let online = 0
  // Offline = not online AND not pending — counted by the dashboard with the
  // very predicate its «Офлайн» filter uses, so the figure and the list it
  // opens agree (`total - online` used to include pending controllers the
  // filter left out). A pending controller has never been set up, so its
  // silence is not an outage: it is a small secondary count on the same tile.
  export let offline = 0
  export let total = 0
  export let alarms = 0
  export let hints = 0     // devices with an open maintenance hint (plan epic 2.4)
  export let pending = 0   // devices still waiting to be set up (status 'pending')
  export let filter = 'all' // the dashboard filter this bar reflects and sets

  const dispatch = createEventDispatcher()

  // Each tile is a filter button: tone drives the colour, lit says whether the
  // tone is shown at all (a zero alarm count stays grey), key is the filter.
  $: stats = [
    { key: 'online',  icon: 'wifi',           value: online,       label: $t('dashboard.fleet_online'),  tone: 'online',  lit: true },
    { key: 'offline', icon: 'wifi-off',       value: offline,      label: $t('dashboard.fleet_offline'), tone: 'offline', lit: offline > 0,
      extra: pending > 0 ? $t('dashboard.fleet_pending', pending) : '' },
    { key: 'all',     icon: 'grid',           value: total,        label: $t('dashboard.fleet_total'),   tone: 'total',   lit: true },
    { key: 'alarm',   icon: 'alert-triangle', value: alarms,       label: $t('dashboard.fleet_alarms'),  tone: 'alarm',   lit: alarms > 0 },
    { key: 'hints',   icon: 'wrench',         value: hints,        label: $t('dashboard.fleet_hints'),   tone: 'hint',    lit: hints > 0 },
  ]

  function select(key) {
    // Pressing the active tile again returns to «Всі», like a filter pill does
    filter = filter === key ? 'all' : key
    dispatch('select', filter)
  }
</script>

<div class="fleet-bar stagger-enter" role="group" aria-label={$t('dashboard.fleet_filter_hint')}>
  {#each stats as s (s.key)}
    <button
      type="button"
      class="stat {s.tone}"
      class:lit={s.lit}
      class:pressed={filter === s.key}
      aria-pressed={filter === s.key}
      title={$t('dashboard.fleet_filter_hint')}
      on:click={() => select(s.key)}
    >
      <div class="stat-icon" class:lit={s.lit}>
        <Icon name={s.icon} size={18} />
      </div>
      <div class="stat-content">
        <span class="stat-value" class:lit={s.lit}>{s.value}</span>
        <span class="stat-label">{s.label}</span>
        {#if s.extra}
          <span class="stat-extra">{s.extra}</span>
        {/if}
      </div>
      <div class="stat-accent" class:lit={s.lit} />
    </button>
  {/each}
</div>

<style>
  .fleet-bar {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: var(--space-3);
  }

  @media (max-width: 960px) {
    .fleet-bar {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 640px) {
    .fleet-bar {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .stat {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
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
    text-align: left;
    font-family: var(--font-sans);
    transition: border-color var(--transition-normal), box-shadow var(--transition-normal), transform var(--transition-fast);
  }

  .stat:hover {
    border-color: var(--border-default);
    transform: translateY(-1px);
  }

  .stat:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: 2px;
  }

  /* The tile whose filter is on: a blue frame, whatever its tone */
  .stat.pressed {
    border-color: var(--accent-blue);
    box-shadow: var(--shadow-glow-blue);
  }

  .stat.alarm.lit {
    border-color: rgba(239, 68, 68, 0.3);
    box-shadow: var(--shadow-glow-red);
  }

  .stat.offline.lit {
    border-color: rgba(251, 191, 36, 0.3);
  }

  .stat.hint.lit { border-color: rgba(74, 158, 255, 0.35); }

  .stat.pressed.alarm.lit,
  .stat.pressed.offline.lit,
  .stat.pressed.hint.lit {
    border-color: var(--accent-blue);
  }

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

  .stat:hover .stat-accent,
  .stat.pressed .stat-accent { opacity: 0.9; }

  .online  .stat-accent.lit { background: linear-gradient(90deg, var(--accent-green), var(--accent-cyan)); }
  .total   .stat-accent.lit { background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple)); }
  .alarm   .stat-accent.lit { background: linear-gradient(90deg, var(--accent-red), var(--accent-orange)); opacity: 0.8; }
  .offline .stat-accent.lit { background: linear-gradient(90deg, var(--accent-amber, #fbbf24), var(--accent-orange)); opacity: 0.7; }
  .hint    .stat-accent.lit { background: var(--accent-blue); }

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

  .online  .stat-icon.lit { color: var(--accent-green); background: rgba(52, 211, 153, 0.1); }
  .total   .stat-icon.lit { color: var(--accent-blue);  background: rgba(74, 158, 255, 0.1); }
  .alarm   .stat-icon.lit { color: var(--accent-red);   background: rgba(239, 68, 68, 0.12); }
  .offline .stat-icon.lit { color: var(--accent-amber, #fbbf24); background: rgba(251, 191, 36, 0.1); }
  .hint    .stat-icon.lit { color: var(--accent-blue);  background: rgba(74, 158, 255, 0.14); }

  .stat-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
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

  .alarm   .stat-value.lit { color: var(--accent-red); }
  .offline .stat-value.lit { color: var(--accent-amber, #fbbf24); }
  .hint    .stat-value.lit { color: var(--accent-blue); }

  .stat-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    margin-top: 2px;
  }

  .stat-extra {
    font-size: var(--text-xs);
    color: var(--accent-yellow);
    margin-top: 2px;
    white-space: nowrap;
  }
</style>
