<script>
  import { onMount } from 'svelte'
  import { getAuditLog } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let entries = []
  let loading = true
  let error = null
  let total = 0
  let page = 1
  let limit = 50

  // Filters
  let filterEntityType = ''
  let filterAction = ''

  // Derived unique values for filter dropdowns
  let entityTypes = []
  let actions = []

  $: totalPages = Math.max(1, Math.ceil(total / limit))
  $: showFrom = total > 0 ? (page - 1) * limit + 1 : 0
  $: showTo = Math.min(page * limit, total)

  async function load() {
    loading = true
    error = null
    try {
      const params = { page, limit }
      if (filterEntityType) params.entity_type = filterEntityType
      if (filterAction) params.action = filterAction
      const res = await getAuditLog(params)
      entries = res.data
      total = res.meta.total
      // Collect unique entity types and actions from first load
      if (entityTypes.length === 0 && entries.length > 0) {
        const allTypes = new Set()
        const allActions = new Set()
        entries.forEach(e => {
          if (e.entity_type) allTypes.add(e.entity_type)
          if (e.action) allActions.add(e.action)
        })
        entityTypes = [...allTypes].sort()
        actions = [...allActions].sort()
      }
    } catch (err) {
      error = err.message
    } finally {
      loading = false
    }
  }

  onMount(load)

  function applyFilters() {
    page = 1
    load()
  }

  function clearFilters() {
    filterEntityType = ''
    filterAction = ''
    page = 1
    load()
  }

  function goPage(p) {
    page = p
    load()
  }

  function formatTime(ts) {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
  }

  function methodColor(method) {
    if (method === 'POST') return 'info'
    if (method === 'PUT' || method === 'PATCH') return 'warning'
    if (method === 'DELETE') return 'danger'
    return 'neutral'
  }

  function statusColor(code) {
    if (code >= 200 && code < 300) return 'success'
    if (code >= 400 && code < 500) return 'warning'
    if (code >= 500) return 'danger'
    return 'neutral'
  }
</script>

<div class="audit-page">
  <PageHeader title={$t('pages.audit_log')} subtitle={$t('pages.audit_log_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  <!-- Filters -->
  <div class="filters">
    <label class="filter-group">
      <span class="filter-label">{$t('audit.filter_entity_type')}</span>
      <select bind:value={filterEntityType} on:change={applyFilters}>
        <option value="">{$t('audit.filter_all')}</option>
        {#each entityTypes as et}
          <option value={et}>{et}</option>
        {/each}
      </select>
    </label>
    <label class="filter-group">
      <span class="filter-label">{$t('audit.filter_action')}</span>
      <select bind:value={filterAction} on:change={applyFilters}>
        <option value="">{$t('audit.filter_all')}</option>
        {#each actions as a}
          <option value={a}>{a}</option>
        {/each}
      </select>
    </label>
    {#if filterEntityType || filterAction}
      <button class="clear-filters" on:click={clearFilters}>
        <Icon name="x" size={14} />
        Clear
      </button>
    {/if}
  </div>

  {#if loading}
    <Skeleton height="400px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else if entries.length === 0}
    <EmptyState icon="shield" title={$t('audit.no_entries')} message={$t('audit.no_entries_hint')} />
  {:else}
    <section class="section-card">
      <div class="section-header">
        <h2><Icon name="shield" size={18} /> {$t('audit.entries')}</h2>
        <span class="count-badge">{total}</span>
      </div>

      <!-- Table header -->
      <div class="table-header">
        <span class="th-time">{$t('audit.col_time')}</span>
        <span class="th-user">{$t('audit.col_user')}</span>
        <span class="th-action">{$t('audit.col_action')}</span>
        <span class="th-entity">{$t('audit.col_entity')}</span>
        <span class="th-method">{$t('audit.col_method')}</span>
        <span class="th-endpoint">{$t('audit.col_endpoint')}</span>
        <span class="th-status">{$t('audit.col_status')}</span>
        <span class="th-ip">{$t('audit.col_ip')}</span>
      </div>

      <!-- Rows -->
      <div class="entry-list">
        {#each entries as entry (entry.id)}
          <div class="entry-row" class:error-row={entry.status_code >= 400}>
            <span class="cell cell-time">{formatTime(entry.created_at)}</span>
            <span class="cell cell-user" title={entry.user_email || '—'}>
              {entry.user_email || '—'}
              {#if entry.user_role}
                <Badge variant="neutral" size="sm">{entry.user_role}</Badge>
              {/if}
            </span>
            <span class="cell cell-action">
              <code>{entry.action || '—'}</code>
            </span>
            <span class="cell cell-entity">
              {#if entry.entity_type}
                <span class="entity-type">{entry.entity_type}</span>
              {/if}
              {#if entry.entity_id}
                <code class="entity-id">{entry.entity_id.length > 12 ? entry.entity_id.slice(0, 8) + '…' : entry.entity_id}</code>
              {/if}
            </span>
            <span class="cell cell-method">
              <Badge variant={methodColor(entry.method)} size="sm">{entry.method}</Badge>
            </span>
            <span class="cell cell-endpoint" title={entry.endpoint}>
              <code>{entry.endpoint}</code>
            </span>
            <span class="cell cell-status">
              <Badge variant={statusColor(entry.status_code)} size="sm">{entry.status_code}</Badge>
            </span>
            <span class="cell cell-ip">{entry.ip || '—'}</span>
          </div>
        {/each}
      </div>

      <!-- Pagination -->
      {#if totalPages > 1}
        <div class="pagination">
          <span class="page-info">
            {$t('audit.showing').replace('{0}', showFrom).replace('{1}', showTo).replace('{2}', total)}
          </span>
          <div class="page-buttons">
            <button class="page-btn" disabled={page <= 1} on:click={() => goPage(page - 1)}>
              <Icon name="chevron-left" size={16} />
              {$t('audit.prev')}
            </button>
            <span class="page-current">{page} / {totalPages}</span>
            <button class="page-btn" disabled={page >= totalPages} on:click={() => goPage(page + 1)}>
              {$t('audit.next')}
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .audit-page {
    max-width: 1400px;
    margin: 0 auto;
  }

  /* ── Filters ── */

  .filters {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .filter-label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .filters select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    min-width: 140px;
  }

  .filters select:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.15);
  }

  .clear-filters {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .clear-filters:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  /* ── Section card ── */

  .section-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .section-header h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    flex: 1;
  }

  .count-badge {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }

  /* ── Table ── */

  .table-header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    background: var(--bg-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .th-time     { flex: 1.2; min-width: 120px; }
  .th-user     { flex: 1.5; min-width: 140px; }
  .th-action   { flex: 1.2; min-width: 100px; }
  .th-entity   { flex: 1.2; min-width: 100px; }
  .th-method   { flex: 0.6; min-width: 60px; }
  .th-endpoint { flex: 1.5; min-width: 120px; }
  .th-status   { flex: 0.5; min-width: 50px; text-align: center; }
  .th-ip       { flex: 0.8; min-width: 80px; }

  .entry-list {
    max-height: 600px;
    overflow-y: auto;
  }

  .entry-row {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    transition: background var(--transition-fast);
  }

  .entry-row:last-child { border-bottom: none; }
  .entry-row:hover { background: var(--bg-hover); }
  .entry-row.error-row { background: rgba(248, 81, 73, 0.04); }

  .cell { font-size: var(--text-sm); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell-time     { flex: 1.2; min-width: 120px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .cell-user     { flex: 1.5; min-width: 140px; display: flex; align-items: center; gap: var(--space-1); }
  .cell-action   { flex: 1.2; min-width: 100px; }
  .cell-action code { font-size: var(--text-xs); background: var(--bg-tertiary); padding: 2px 6px; border-radius: var(--radius-sm); font-family: var(--font-mono); }
  .cell-entity   { flex: 1.2; min-width: 100px; display: flex; align-items: center; gap: var(--space-1); }
  .cell-method   { flex: 0.6; min-width: 60px; }
  .cell-endpoint { flex: 1.5; min-width: 120px; }
  .cell-endpoint code { font-size: var(--text-xs); font-family: var(--font-mono); color: var(--text-muted); }
  .cell-status   { flex: 0.5; min-width: 50px; text-align: center; }
  .cell-ip       { flex: 0.8; min-width: 80px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }

  .entity-type {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 500;
  }

  .entity-id {
    font-size: 10px;
    background: var(--bg-tertiary);
    padding: 1px 4px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  /* ── Pagination ── */

  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .page-info {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .page-buttons {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .page-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .page-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .page-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .page-current {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    min-width: 60px;
    text-align: center;
  }

  /* ── Responsive ── */

  @media (max-width: 768px) {
    .table-header { display: none; }
    .entry-row { flex-wrap: wrap; gap: var(--space-2); padding: var(--space-3) var(--space-4); }
    .cell-time { flex: 1; min-width: 100%; }
    .cell-user { flex: 1; min-width: 100%; }
    .cell-endpoint, .cell-ip { display: none; }
    .cell-action { flex: 1; }
    .cell-entity { flex: 1; }
    .cell-method { flex: 0; min-width: auto; }
    .cell-status { flex: 0; min-width: auto; }
    .pagination { flex-direction: column; gap: var(--space-2); }
  }
</style>
