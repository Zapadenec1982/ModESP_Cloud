<script>
  import { onMount, onDestroy } from 'svelte'
  import { getAlarms, exportAlarmsCsv } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { navigate } from '../lib/stores.js'
  import { timeAgo, alarmLabel } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let activeAlarms = []
  let historyAlarms = []
  let loading = true
  let error = null
  let exportingCsv = false
  let loadingMore = false
  let hasMore = true
  let wsUnsub
  let severityFilter = null  // null = all, 'critical', 'warning', 'info'

  const PAGE_SIZE = 50

  // Date range filter
  let dateFrom = ''
  let dateTo = ''
  let appliedFrom = ''
  let appliedTo = ''

  function defaultDates() {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 86400000)
    return {
      from: weekAgo.toISOString().slice(0, 16),
      to: now.toISOString().slice(0, 16)
    }
  }

  async function load() {
    loading = true
    try {
      const activeParams = { active: true }
      if (severityFilter) activeParams.severity = severityFilter

      const histParams = { limit: PAGE_SIZE }
      if (severityFilter) histParams.severity = severityFilter
      if (appliedFrom) histParams.from = new Date(appliedFrom).toISOString()
      if (appliedTo) histParams.to = new Date(appliedTo).toISOString()

      const [activeRes, histRes] = await Promise.all([
        getAlarms(activeParams),
        getAlarms(histParams),
      ])
      activeAlarms = activeRes.data || activeRes || []
      historyAlarms = (histRes.data || histRes || []).filter(a => !a.active)
      hasMore = (histRes.data || histRes || []).length >= PAGE_SIZE
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return
    loadingMore = true
    try {
      const params = { limit: PAGE_SIZE, offset: historyAlarms.length + activeAlarms.length }
      if (severityFilter) params.severity = severityFilter
      if (appliedFrom) params.from = new Date(appliedFrom).toISOString()
      if (appliedTo) params.to = new Date(appliedTo).toISOString()

      const res = await getAlarms(params)
      const rows = (res.data || res || []).filter(a => !a.active)
      historyAlarms = [...historyAlarms, ...rows]
      hasMore = (res.data || res || []).length >= PAGE_SIZE
    } catch (e) {
      toast.error(e.message)
    } finally {
      loadingMore = false
    }
  }

  function setSeverityFilter(sev) {
    severityFilter = severityFilter === sev ? null : sev
    load()
  }

  function applyDateRange() {
    appliedFrom = dateFrom
    appliedTo = dateTo
    load()
  }

  function resetDateRange() {
    dateFrom = ''
    dateTo = ''
    appliedFrom = ''
    appliedTo = ''
    load()
  }

  function severityVariant(severity) {
    if (severity === 'critical') return 'danger'
    if (severity === 'warning') return 'warning'
    return 'info'
  }

  async function handleExportCsv() {
    exportingCsv = true
    try {
      const from = appliedFrom ? new Date(appliedFrom).toISOString() : new Date(Date.now() - 90 * 86400000).toISOString()
      const to = appliedTo ? new Date(appliedTo).toISOString() : new Date().toISOString()
      await exportAlarmsCsv(from, to, severityFilter)
      toast.success($t('export.export_success'))
    } catch (e) {
      toast.error(e.message || $t('export.export_error'))
    } finally {
      exportingCsv = false
    }
  }

  let pollInterval

  onMount(() => {
    load()
    wsUnsub = on('alarm', () => load())
    // Poll every 30s as fallback for missed WS events
    pollInterval = setInterval(() => { if (!loading) load() }, 30000)
  })

  onDestroy(() => {
    wsUnsub?.()
    clearInterval(pollInterval)
  })
</script>

<div class="alarms-page">
  <PageHeader title={$t('pages.alarms')} subtitle={$t('pages.alarms_sub')} />

  <!-- Severity filter pills -->
  <div class="filter-row">
    <div class="severity-pills">
      <button class:active={severityFilter === null} on:click={() => { severityFilter = null; load() }}>
        {$t('common.all')}
      </button>
      <button class="pill-critical" class:active={severityFilter === 'critical'} on:click={() => setSeverityFilter('critical')}>
        {$t('alarm.critical')}
      </button>
      <button class="pill-warning" class:active={severityFilter === 'warning'} on:click={() => setSeverityFilter('warning')}>
        {$t('alarm.warning')}
      </button>
      <button class="pill-info" class:active={severityFilter === 'info'} on:click={() => setSeverityFilter('info')}>
        {$t('alarm.info')}
      </button>
    </div>
    <button class="btn-export-csv" on:click={handleExportCsv} disabled={exportingCsv}>
      <Icon name="download" size={14} />
      {exportingCsv ? $t('export.exporting') : $t('export.export_csv')}
    </button>
  </div>

  <!-- Date range filter -->
  <div class="date-range-row">
    <div class="date-inputs">
      <label class="date-field">
        <span class="date-label">{$t('alarm.date_from')}</span>
        <input type="datetime-local" bind:value={dateFrom} />
      </label>
      <label class="date-field">
        <span class="date-label">{$t('alarm.date_to')}</span>
        <input type="datetime-local" bind:value={dateTo} />
      </label>
      <button class="btn-date-action" on:click={applyDateRange} disabled={!dateFrom && !dateTo}>
        <Icon name="search" size={14} />
        {$t('alarm.apply')}
      </button>
      {#if appliedFrom || appliedTo}
        <button class="btn-date-action btn-reset" on:click={resetDateRange}>
          <Icon name="x" size={14} />
          {$t('alarm.reset')}
        </button>
      {/if}
    </div>
  </div>

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
                <Badge variant={severityVariant(alarm.severity)} pulse>
                  {(alarm.severity || 'warning').toUpperCase()}
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
        {#if historyAlarms.length > 0}
          <span class="history-count">{$t('alarm.showing_count').replace('{count}', historyAlarms.length)}</span>
        {/if}
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
                <Badge variant={severityVariant(alarm.severity)} small>
                  {alarm.severity || 'warning'}
                </Badge>
              </span>
              <span class="td text-muted">{timeAgo(alarm.triggered_at || alarm.created_at)}</span>
              <span class="td text-muted">{alarm.cleared_at ? timeAgo(alarm.cleared_at) : '—'}</span>
            </button>
          {/each}
        </div>

        <!-- Load more -->
        {#if hasMore}
          <button class="btn-load-more" on:click={loadMore} disabled={loadingMore}>
            {#if loadingMore}
              <span class="spinner"></span>
            {:else}
              <Icon name="chevrons-down" size={16} />
            {/if}
            {loadingMore ? '...' : $t('alarm.load_more')}
          </button>
        {:else if historyAlarms.length >= PAGE_SIZE}
          <div class="no-more-hint">{$t('alarm.no_more')}</div>
        {/if}
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

  .filter-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .btn-export-csv {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .btn-export-csv:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-export-csv:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .severity-pills {
    display: flex;
    gap: var(--space-1);
  }

  .severity-pills button {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
    text-transform: capitalize;
  }

  .severity-pills button:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .severity-pills button.active {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .severity-pills .pill-critical.active {
    background: var(--accent-red, #ef4444);
    border-color: var(--accent-red, #ef4444);
  }

  .severity-pills .pill-warning.active {
    background: var(--accent-amber, #f59e0b);
    border-color: var(--accent-amber, #f59e0b);
    color: #000;
  }

  .severity-pills .pill-info.active {
    background: var(--accent-blue, #3b82f6);
    border-color: var(--accent-blue, #3b82f6);
  }

  /* Date range row */
  .date-range-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .date-inputs {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .date-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .date-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .date-field input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: var(--text-xs);
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
  }

  .date-field input:focus {
    border-color: var(--accent-blue);
  }

  /* Fix datetime-local picker colors for dark theme */
  .date-field input::-webkit-calendar-picker-indicator {
    filter: invert(0.7);
    cursor: pointer;
  }

  .btn-date-action {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
    height: fit-content;
  }

  .btn-date-action:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-date-action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-date-action.btn-reset {
    border-color: rgba(248, 81, 73, 0.3);
    color: var(--accent-red, #ef4444);
  }

  .btn-date-action.btn-reset:hover {
    background: rgba(248, 81, 73, 0.08);
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

  .history-count {
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-muted);
    margin-left: auto;
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

  /* Load more */
  .btn-load-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px dashed var(--border-default);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all 0.2s;
    width: 100%;
  }

  .btn-load-more:hover:not(:disabled) {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: rgba(88, 166, 255, 0.04);
  }

  .btn-load-more:disabled {
    cursor: wait;
  }

  .no-more-hint {
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding: var(--space-2);
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    .table-header { display: none; }
    .alarm-row.history {
      flex-wrap: wrap;
    }
    .td:nth-child(4), .td:nth-child(5) {
      font-size: var(--text-xs);
    }
    .date-inputs {
      width: 100%;
    }
    .date-field {
      flex: 1;
      min-width: 0;
    }
    .date-field input {
      width: 100%;
    }
  }
</style>
