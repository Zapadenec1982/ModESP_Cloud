<script>
  import { onMount } from 'svelte'
  import { getEnergySummary, getTelemetry } from '../../lib/api.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'
  import EmptyState from '../ui/EmptyState.svelte'

  export let deviceId
  export let device = {}

  let summary = null
  let loading = true
  let error = null
  let period = '7d'

  const PERIODS = {
    '24h': { hours: 24, label: () => $t('energy.period_day') },
    '7d':  { hours: 168, label: () => $t('energy.period_week') },
    '30d': { hours: 720, label: () => $t('energy.period_month') },
  }

  // Check if device has power profile (either from model or overrides)
  $: hasPowerProfile = device && (
    device.model_id ||
    device.compressor_kw ||
    device.model_compressor_kw
  )

  $: effectivePower = {
    compressor: device?.compressor_kw ?? device?.model_compressor_kw ?? 0,
    evap_fan: device?.evap_fan_kw ?? device?.model_evap_fan_kw ?? 0,
    cond_fan: device?.cond_fan_kw ?? device?.model_cond_fan_kw ?? 0,
    defrost: device?.defrost_heater_kw ?? device?.model_defrost_heater_kw ?? 0,
    standby: device?.standby_kw ?? device?.model_standby_kw ?? 0,
  }

  $: source = device?.model_energy_source || 'estimated'

  async function loadSummary() {
    if (!hasPowerProfile) { loading = false; return }
    loading = true
    error = null
    try {
      const hours = PERIODS[period].hours
      const to = new Date().toISOString()
      const from = new Date(Date.now() - hours * 3600000).toISOString()
      summary = await getEnergySummary(deviceId, from, to)
    } catch (e) {
      error = e.message
    }
    loading = false
  }

  onMount(loadSummary)

  $: period, loadSummary()

  function formatKwh(val) {
    if (val == null) return '—'
    if (val < 1) return val.toFixed(3)
    if (val < 100) return val.toFixed(1)
    return Math.round(val).toString()
  }

  function formatCost(val, currency) {
    if (val == null) return ''
    return `${currency === 'UAH' ? '₴' : currency} ${val.toFixed(2)}`
  }
</script>

{#if !hasPowerProfile}
  <EmptyState
    icon="zap"
    title={$t('energy.no_profile')}
    hint={$t('energy.no_profile_hint')}
  />
{:else if loading}
  <div class="loading">
    <div class="spinner" />
  </div>
{:else if error}
  <EmptyState icon="alert-triangle" title={$t('common.error')} hint={error} />
{:else if summary}
  <div class="energy-tab">
    <!-- Period selector -->
    <div class="period-bar">
      {#each Object.entries(PERIODS) as [key, p]}
        <button
          class="period-btn"
          class:active={period === key}
          on:click={() => period = key}
        >{p.label()}</button>
      {/each}
    </div>

    <!-- Summary cards -->
    <div class="summary-cards">
      <div class="card total">
        <div class="card-value">{formatKwh(summary.total_kwh)}</div>
        <div class="card-unit">kWh</div>
        {#if summary.estimated_cost != null}
          <div class="card-cost">{formatCost(summary.estimated_cost, summary.currency)}</div>
        {/if}
        <div class="card-label">{$t('energy.total')}</div>
      </div>

      <div class="card">
        <div class="card-value">{formatKwh(summary.daily_avg_kwh)}</div>
        <div class="card-unit">kWh</div>
        {#if summary.estimated_cost != null && summary.daily_avg_kwh}
          <div class="card-cost">{formatCost(summary.daily_avg_kwh * (summary.estimated_cost / summary.total_kwh), summary.currency)}</div>
        {/if}
        <div class="card-label">{$t('energy.daily_avg')}</div>
      </div>
    </div>

    <!-- Breakdown -->
    {#if summary.breakdown}
      <div class="breakdown">
        <h4>{$t('energy.breakdown')}</h4>
        {#each [
          { key: 'compressor', icon: 'activity', color: 'var(--accent-blue)' },
          { key: 'defrost', icon: 'thermometer', color: 'var(--status-alarm)' },
          { key: 'fans', icon: 'wind', color: 'var(--accent-teal, #2dd4bf)' },
          { key: 'standby', icon: 'power', color: 'var(--text-muted)' },
        ] as item}
          {@const data = summary.breakdown[item.key]}
          {#if data && data.kwh > 0}
            <div class="breakdown-row">
              <div class="breakdown-label">
                <Icon name={item.icon} size={14} />
                <span>{$t(`energy.${item.key}`)}</span>
              </div>
              <div class="breakdown-bar-wrap">
                <div class="breakdown-bar" style="width: {data.pct}%; background: {item.color};" />
              </div>
              <div class="breakdown-value">
                <span class="breakdown-kwh">{formatKwh(data.kwh)}</span>
                <span class="breakdown-pct">{data.pct}%</span>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Source indicator -->
    <div class="source-indicator">
      <Icon name="zap" size={12} />
      <span>{source === 'metered' ? $t('energy.metered') : $t('energy.estimated')}</span>
      {#if effectivePower.compressor > 0}
        <span class="source-detail">• {$t('energy.compressor')} {effectivePower.compressor} {$t('energy.unit_kw')} | {$t('energy.fans')} {Math.round((effectivePower.evap_fan + effectivePower.cond_fan) * 1000)} {$t('energy.unit_w')}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .energy-tab { display: flex; flex-direction: column; gap: var(--space-4); }

  .loading {
    display: flex; justify-content: center; padding: var(--space-6);
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .period-bar {
    display: flex; gap: var(--space-2);
  }
  .period-btn {
    padding: var(--space-1) var(--space-3);
    border-radius: 6px;
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--text-xs);
    transition: all var(--transition-fast);
  }
  .period-btn.active {
    background: var(--accent-blue);
    color: white;
    border-color: var(--accent-blue);
  }

  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3);
  }
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: 10px;
    padding: var(--space-4);
    text-align: center;
  }
  .card.total { border-color: var(--accent-blue); }
  .card-value {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }
  .card-unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: 2px;
  }
  .card-cost {
    font-size: var(--text-sm);
    color: var(--accent-blue);
    margin-top: var(--space-1);
    font-family: var(--font-mono);
  }
  .card-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .breakdown {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: 10px;
    padding: var(--space-4);
  }
  .breakdown h4 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-weight: 500;
  }
  .breakdown-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }
  .breakdown-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 120px;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .breakdown-bar-wrap {
    flex: 1;
    height: 8px;
    background: var(--bg-tertiary, rgba(255,255,255,0.05));
    border-radius: 4px;
    overflow: hidden;
  }
  .breakdown-bar {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
  }
  .breakdown-value {
    min-width: 80px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .breakdown-kwh { color: var(--text-primary); }
  .breakdown-pct { color: var(--text-muted); margin-left: var(--space-1); }

  .source-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding-top: var(--space-2);
  }
  .source-detail { opacity: 0.7; }

  @media (max-width: 480px) {
    .summary-cards { grid-template-columns: 1fr 1fr; }
    .breakdown-label { min-width: 90px; }
  }
</style>
