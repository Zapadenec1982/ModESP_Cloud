<script>
  import { onMount, onDestroy } from 'svelte'
  import { getAlarms } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { navigate } from '../lib/stores.js'
  import { timeAgo, alarmLabel, alarmSeverity } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let activeAlarms = []
  let historyAlarms = []
  let loading = true
  let error = null
  let wsUnsub

  async function load() {
    try {
      const [activeRes, histRes] = await Promise.all([
        getAlarms({ active: true }),
        getAlarms({ limit: 50 }),
      ])
      activeAlarms = activeRes.data || activeRes || []
      historyAlarms = (histRes.data || histRes || []).filter(a => !a.active)
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function severityVariant(code) {
    const s = alarmSeverity(code)
    if (s === 'critical') return 'danger'
    if (s === 'warning') return 'warning'
    return 'info'
  }

  onMount(() => {
    load()
    wsUnsub = on('alarm', () => load())
  })

  onDestroy(() => wsUnsub?.())
</script>

<div class="alarms-page">
  <PageHeader title={$t('pages.alarms')} subtitle={$t('pages.alarms_sub')} />

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="300px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('alarm.load_error')} message={error} />
  {:else}
    <!-- Active alarms -->
    <div class="section">
      <h2 class="section-title">
        <Icon name="alert-triangle" size={18} />
        {$t('alarm.active_alarms')}
        {#if activeAlarms.length > 0}
          <Badge variant="danger">{activeAlarms.length}</Badge>
        {/if}
      </h2>

      {#if activeAlarms.length === 0}
        <div class="no-alarms">
          <Icon name="check-circle" size={20} />
          <span>{$t('alarm.no_active')}</span>
        </div>
      {:else}
        <div class="active-list">
          {#each activeAlarms as alarm}
            <button
              class="alarm-row active"
              on:click={() => navigate(`/device/${alarm.device_id || alarm.mqtt_device_id}`)}
              aria-label="View device {alarm.device_id || alarm.mqtt_device_id} — {alarmLabel(alarm.alarm_code)}"
            >
              <div class="alarm-severity">
                <Badge variant={severityVariant(alarm.alarm_code)} pulse>
                  {alarmSeverity(alarm.alarm_code).toUpperCase()}
                </Badge>
              </div>
              <div class="alarm-info">
                <span class="alarm-type">{alarmLabel(alarm.alarm_code)}</span>
                <span class="alarm-device font-mono">{alarm.device_id || alarm.mqtt_device_id}</span>
              </div>
              <div class="alarm-time">{timeAgo(alarm.triggered_at || alarm.created_at)}</div>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- History -->
    <div class="section">
      <h2 class="section-title">
        <Icon name="clock" size={18} />
        {$t('alarm.history')}
      </h2>

      {#if historyAlarms.length === 0}
        <EmptyState icon="clock" title={$t('alarm.no_history')} message={$t('alarm.no_history_hint')} />
      {:else}
        <div class="history-table">
          <div class="table-header">
            <span class="th">{$t('alarm.col_device')}</span>
            <span class="th">{$t('alarm.col_type')}</span>
            <span class="th">{$t('alarm.col_severity')}</span>
            <span class="th">{$t('alarm.col_triggered')}</span>
            <span class="th">{$t('alarm.col_resolved')}</span>
          </div>
          {#each historyAlarms as alarm}
            <button
              class="alarm-row history"
              on:click={() => navigate(`/device/${alarm.device_id || alarm.mqtt_device_id}`)}
              aria-label="View device {alarm.device_id || alarm.mqtt_device_id} — {alarmLabel(alarm.alarm_code)}"
            >
              <span class="td font-mono">{alarm.device_id || alarm.mqtt_device_id}</span>
              <span class="td">{alarmLabel(alarm.alarm_code)}</span>
              <span class="td">
                <Badge variant={severityVariant(alarm.alarm_code)} small>
                  {alarmSeverity(alarm.alarm_code)}
                </Badge>
              </span>
              <span class="td text-muted">{timeAgo(alarm.triggered_at || alarm.created_at)}</span>
              <span class="td text-muted">{timeAgo(alarm.resolved_at)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .alarms-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .no-alarms {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    background: rgba(63, 185, 80, 0.06);
    border: 1px solid rgba(63, 185, 80, 0.2);
    border-radius: var(--radius-md);
    color: var(--accent-green);
    font-size: var(--text-sm);
  }

  .active-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .alarm-row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    transition: all var(--transition-fast);
    width: 100%;
    text-align: left;
  }

  .alarm-row.active {
    background: var(--bg-surface);
    border: 1px solid rgba(248, 81, 73, 0.3);
  }

  .alarm-row.active:hover {
    border-color: var(--accent-red);
    background: rgba(248, 81, 73, 0.06);
  }

  .alarm-row.history {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
  }

  .alarm-row.history:hover {
    background: var(--bg-tertiary);
  }

  .alarm-severity {
    flex-shrink: 0;
  }

  .alarm-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .alarm-type {
    font-weight: 500;
    color: var(--text-primary);
    font-size: var(--text-base);
  }

  .alarm-device {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .alarm-time {
    font-size: var(--text-sm);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* History table */
  .history-table {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .table-header {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
  }

  .th {
    flex: 1;
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .td {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .table-header { display: none; }
    .alarm-row.history {
      flex-wrap: wrap;
    }
    .td:nth-child(4), .td:nth-child(5) {
      font-size: var(--text-xs);
    }
  }
</style>
