<script>
  /**
   * Geo statistics — the fleet's numbers cut by place.
   *
   * One endpoint answers every level: `GET /api/stats/geo?group_by=…`, with the
   * same filter set the fleet map uses, so the map and this table always answer
   * the same question. Grouping, sorting and the CSV are all done server-side —
   * `group_by` and `sort` are whitelists there, and the export re-runs the very
   * same query so the file can never disagree with the screen.
   *
   * The drill-down is derived from the filters rather than kept as its own
   * state: country → region → city → site is exactly "country_code set, then
   * region set, then city set". That means the filter bar and the breadcrumb are
   * two views of one object and can never fall out of step.
   *
   * A metric the backend could not compute comes back as null and is rendered as
   * an em dash — never as a comforting zero.
   */
  import { onMount } from 'svelte'
  import { getGeoStats, getMapFilters, exportGeoStatsCsv } from '../lib/api.js'
  import { isAdmin, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import MapFilters from '../components/map/MapFilters.svelte'

  const RANGE_PRESETS = [
    { days: 7,   labelKey: 'geostats.range_7d' },
    { days: 30,  labelKey: 'geostats.range_30d' },
    { days: 90,  labelKey: 'geostats.range_90d' },
    { days: 365, labelKey: 'geostats.range_365d' },
  ]

  // Every `key` here is in the backend's SORT_BY whitelist; anything else is a
  // 400 by design.
  const COLUMNS = [
    { key: 'device_count',   labelKey: 'geostats.col_devices' },
    { key: 'online_count',   labelKey: 'geostats.col_online' },
    { key: 'offline_count',  labelKey: 'geostats.col_offline' },
    { key: 'alarm_count',    labelKey: 'geostats.col_alarms_active' },
    { key: 'alarms_period',  labelKey: 'geostats.col_alarms_period' },
    { key: 'avg_air_temp',   labelKey: 'geostats.col_avg_temp',  digits: 2 },
    { key: 'uptime_pct',     labelKey: 'geostats.col_uptime',    digits: 1 },
    { key: 'energy_kwh',     labelKey: 'geostats.col_energy',    digits: 2 },
    { key: 'service_visits', labelKey: 'geostats.col_visits' },
  ]

  // ── State ──────────────────────────────────────────────

  let rows = []
  let meta = {}
  let totals = null
  let loading = true
  let exporting = false
  let error = null

  let filterOptions = {}
  let filters = {
    q: '', status: 'all', country_code: '', region: '', city: '',
    model: '', firmware_version: '', site_id: '', tenant_id: '', user_id: '',
  }

  // Labels captured on the way down: the API returns `key` (a country code, a
  // region name) and a display `label`, and only the row that was clicked knows
  // the pairing. Each entry stores the key it was captured for, so switching
  // country through the filter bar cannot leave the previous label behind.
  let crumbs = { country: null, region: null, city: null }   // { key, label }

  let dateFrom = ''
  let dateTo = ''

  let sort = 'device_count'
  let order = 'desc'

  // ── Derived ────────────────────────────────────────────

  $: level = filters.city
    ? 'site'
    : filters.region
      ? 'city'
      : filters.country_code
        ? 'region'
        : 'country'

  $: groupLabelKey = `geostats.level_${level}`

  $: activePreset = presetDays(dateFrom, dateTo)

  // ── Helpers ────────────────────────────────────────────

  /** Local calendar day as yyyy-mm-dd (toISOString() would shift across UTC). */
  function isoDay(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10)
  }

  function rangeParams() {
    const params = {}
    if (dateFrom) params.from = new Date(`${dateFrom}T00:00:00`).toISOString()
    if (dateTo) params.to = new Date(`${dateTo}T23:59:59.999`).toISOString()
    return params
  }

  function filterParams() {
    const params = {}
    const add = (key, value) => {
      if (value === undefined || value === null) return
      const str = String(value).trim()
      if (str !== '') params[key] = str
    }

    add('q', filters.q)
    if (filters.status && filters.status !== 'all') add('status', filters.status)
    add('country_code', filters.country_code)
    add('region', filters.region)
    add('city', filters.city)
    add('model', filters.model)
    add('firmware_version', filters.firmware_version)
    add('site_id', filters.site_id)
    add('tenant_id', filters.tenant_id)
    add('user_id', filters.user_id)

    return params
  }

  function queryParams() {
    return { ...filterParams(), ...rangeParams(), group_by: level, sort, order }
  }

  // ── Loading ────────────────────────────────────────────

  async function load() {
    loading = true
    try {
      const res = await getGeoStats(queryParams())
      rows = Array.isArray(res && res.data) ? res.data : []
      meta = (res && res.meta) || {}
      totals = meta.totals || null
      error = null
    } catch (e) {
      error = e.message
      rows = []
      meta = {}
      totals = null
    } finally {
      loading = false
    }
  }

  async function loadFilterOptions() {
    try {
      filterOptions = (await getMapFilters({})) || {}
    } catch {
      // Option lists are a convenience; the table must still render without them.
      filterOptions = {}
    }
  }

  // ── Drill-down ─────────────────────────────────────────

  function drillInto(row) {
    if (level === 'site') return
    // A null key is the "no country / no region recorded" bucket — there is
    // nothing to narrow to, so it stays a leaf.
    if (!row.key) return

    const entry = { key: row.key, label: row.label || row.key }

    if (level === 'country') {
      filters = { ...filters, country_code: row.key, region: '', city: '' }
      crumbs = { country: entry, region: null, city: null }
    } else if (level === 'region') {
      filters = { ...filters, region: row.key, city: '' }
      crumbs = { ...crumbs, region: entry, city: null }
    } else {
      filters = { ...filters, city: row.key }
      crumbs = { ...crumbs, city: entry }
    }
    load()
  }

  /** depth 0 = all, 1 = keep country, 2 = keep region. */
  function crumbTo(depth) {
    if (depth === 0) {
      filters = { ...filters, country_code: '', region: '', city: '' }
      crumbs = { country: null, region: null, city: null }
    } else if (depth === 1) {
      filters = { ...filters, region: '', city: '' }
      crumbs = { ...crumbs, region: null, city: null }
    } else {
      filters = { ...filters, city: '' }
      crumbs = { ...crumbs, city: null }
    }
    load()
  }

  /**
   * The captured display label, but only while it still belongs to the key that
   * is actually filtered — otherwise the raw key, which is always truthful.
   */
  function crumbText(kind, key) {
    const entry = crumbs[kind]
    return entry && entry.key === key && entry.label ? entry.label : key
  }

  // ── Sorting ────────────────────────────────────────────

  function toggleSort(key) {
    if (sort === key) {
      order = order === 'asc' ? 'desc' : 'asc'
    } else {
      sort = key
      order = key === 'label' ? 'asc' : 'desc'
    }
    load()
  }

  function ariaSort(key) {
    if (sort !== key) return 'none'
    return order === 'asc' ? 'ascending' : 'descending'
  }

  // ── Date range ─────────────────────────────────────────

  function applyPreset(days) {
    const now = new Date()
    dateTo = isoDay(now)
    dateFrom = isoDay(new Date(now.getTime() - days * 86400000))
    load()
  }

  /**
   * Which preset the current range corresponds to, or null for a hand-picked
   * one. DERIVED rather than remembered, so editing either date input drops the
   * highlight instead of leaving a chip lit next to dates it no longer matches.
   */
  function presetDays(from, to) {
    if (!from || !to) return null
    const now = Date.now()
    if (to !== isoDay(new Date(now))) return null
    const match = RANGE_PRESETS.find(p => from === isoDay(new Date(now - p.days * 86400000)))
    return match ? match.days : null
  }

  function applyRange() {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      toast.error($t('geostats.range_invalid'))
      return
    }
    load()
  }

  // ── Rendering ──────────────────────────────────────────

  function cellValue(row, column) {
    const value = row[column.key]
    if (value === null || value === undefined) return '—'
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    return column.digits === undefined ? String(n) : n.toFixed(column.digits)
  }

  // ── Actions ────────────────────────────────────────────

  // The filter bar owns country_code / region / city too, so a change there is
  // also a jump in the drill-down — `level` and the breadcrumb both derive from
  // `filters`, and crumbText() discards a label whose key no longer applies.
  function onFiltersChange() {
    load()
  }

  async function handleExport() {
    exporting = true
    try {
      await exportGeoStatsCsv(queryParams())
      toast.success($t('export.export_success'))
    } catch (e) {
      toast.error(e.message || $t('export.export_error'))
    } finally {
      exporting = false
    }
  }

  onMount(() => {
    applyPreset(30)
    loadFilterOptions()
  })
</script>

<div class="geostats-page">
  <PageHeader title={$t('pages.geo_stats')} subtitle={$t('pages.geo_stats_sub')}>
    <button class="hdr-btn" on:click={handleExport} disabled={exporting || loading}>
      <Icon name="download" size={14} />
      {exporting ? $t('export.exporting') : $t('export.export_csv')}
    </button>
  </PageHeader>

  <MapFilters
    bind:filters
    options={filterOptions}
    showTenant={$isSuperAdmin}
    showUser={$isAdmin}
    on:change={onFiltersChange}
  />

  <div class="range-bar">
    <div class="presets">
      {#each RANGE_PRESETS as preset (preset.days)}
        <button
          type="button"
          class="preset"
          class:active={activePreset === preset.days}
          aria-pressed={activePreset === preset.days}
          on:click={() => applyPreset(preset.days)}
        >
          {$t(preset.labelKey)}
        </button>
      {/each}
      {#if activePreset === null}
        <span class="preset-custom">{$t('geostats.range_custom')}</span>
      {/if}
    </div>

    <label class="date-field">
      <span class="date-label">{$t('geostats.from')}</span>
      <input type="date" bind:value={dateFrom} max={dateTo || undefined} />
    </label>

    <label class="date-field">
      <span class="date-label">{$t('geostats.to')}</span>
      <input type="date" bind:value={dateTo} min={dateFrom || undefined} />
    </label>

    <button type="button" class="apply-btn" on:click={applyRange}>
      <Icon name="search" size={14} />
      {$t('geostats.apply')}
    </button>
  </div>

  <nav class="crumbs" aria-label={$t('geostats.breadcrumb_all')}>
    <button type="button" class="crumb" class:current={level === 'country'} on:click={() => crumbTo(0)}>
      <Icon name="globe" size={14} />
      {$t('geostats.breadcrumb_all')}
    </button>
    {#if filters.country_code}
      <Icon name="chevron-right" size={13} />
      <button type="button" class="crumb" class:current={level === 'region'} on:click={() => crumbTo(1)}>
        {crumbText('country', filters.country_code)}
      </button>
    {/if}
    {#if filters.region}
      <Icon name="chevron-right" size={13} />
      <button type="button" class="crumb" class:current={level === 'city'} on:click={() => crumbTo(2)}>
        {crumbText('region', filters.region)}
      </button>
    {/if}
    {#if filters.city}
      <Icon name="chevron-right" size={13} />
      <span class="crumb current static">{crumbText('city', filters.city)}</span>
    {/if}
  </nav>

  {#if totals && !loading && !error}
    <div class="totals-strip">
      <div class="total-card">
        <span class="total-label">{$t('geostats.col_devices')}</span>
        <span class="total-value font-mono">{totals.device_count ?? 0}</span>
      </div>
      <div class="total-card">
        <span class="total-label">{$t('geostats.col_online')}</span>
        <span class="total-value font-mono online">{totals.online_count ?? 0}</span>
      </div>
      <div class="total-card">
        <span class="total-label">{$t('geostats.col_alarms_period')}</span>
        <span class="total-value font-mono alarm">{totals.alarms_period ?? 0}</span>
      </div>
      <div class="total-card">
        <span class="total-label">{$t('geostats.col_uptime')}</span>
        <!-- No trailing "%": the label already carries the unit ("Доступність, %"),
             and the table cells under that same header print the bare number. -->
        <span class="total-value font-mono">
          {totals.uptime_pct === null || totals.uptime_pct === undefined ? '—' : Number(totals.uptime_pct).toFixed(1)}
        </span>
      </div>
      <div class="total-card">
        <span class="total-label">{$t('geostats.col_energy')}</span>
        <span class="total-value font-mono">
          {totals.energy_kwh === null || totals.energy_kwh === undefined ? '—' : Number(totals.energy_kwh).toFixed(2)}
        </span>
      </div>
    </div>
  {/if}

  {#if meta.clamped}
    <div class="notice">
      <Icon name="info" size={14} />
      <span>{$t('geostats.clamped_hint')}</span>
    </div>
  {/if}

  {#if meta.truncated}
    <div class="notice warn">
      <Icon name="alert-triangle" size={14} />
      <span>{$t('geostats.truncated_hint', rows.length)}</span>
    </div>
  {/if}

  {#if loading}
    <Skeleton height="320px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('geostats.load_error')} message={error} />
  {:else if rows.length === 0}
    <EmptyState
      icon="bar-chart"
      title={$t('geostats.no_data')}
      message={$t('geostats.no_data_hint')}
    />
  {:else}
    <div class="table-wrap">
      <table class="stats-table">
        <thead>
          <tr>
            <th scope="col" class="th-label" aria-sort={ariaSort('label')}>
              <button type="button" class="th-btn" on:click={() => toggleSort('label')}>
                {$t(groupLabelKey)}
                {#if sort === 'label'}
                  <!-- A glyph, not a string: aria-sort above carries the meaning. -->
                  <span class="sort-arrow" aria-hidden="true">{order === 'asc' ? '↑' : '↓'}</span>
                {/if}
              </button>
            </th>
            {#each COLUMNS as column (column.key)}
              <th scope="col" class="th-num" aria-sort={ariaSort(column.key)}>
                <button type="button" class="th-btn num" on:click={() => toggleSort(column.key)}>
                  {$t(column.labelKey)}
                  {#if sort === column.key}
                    <span class="sort-arrow" aria-hidden="true">{order === 'asc' ? '↑' : '↓'}</span>
                  {/if}
                </button>
              </th>
            {/each}
          </tr>
        </thead>

        <tbody>
          {#each rows as row (row.key ?? row.label ?? '∅')}
            <tr>
              <td class="td-label">
                <!-- $t() is read inline so a locale switch re-renders the cell. -->
                {#if level !== 'site' && row.key}
                  <button type="button" class="drill-btn" on:click={() => drillInto(row)}>
                    <span class="drill-name">{row.label || row.key || $t('geostats.unknown')}</span>
                    <Icon name="chevron-right" size={13} />
                  </button>
                {:else}
                  <span class="drill-name static">{row.label || row.key || $t('geostats.unknown')}</span>
                {/if}
              </td>
              {#each COLUMNS as column (column.key)}
                <td class="td-num font-mono">{cellValue(row, column)}</td>
              {/each}
            </tr>
          {/each}
        </tbody>

        {#if totals}
          <tfoot>
            <tr>
              <td class="td-label total-row">{$t('geostats.total')}</td>
              {#each COLUMNS as column (column.key)}
                <td class="td-num font-mono total-row">{cellValue(totals, column)}</td>
              {/each}
            </tr>
          </tfoot>
        {/if}
      </table>
    </div>

    {#if level !== 'site'}
      <p class="hint">{$t('geostats.drill_hint')}</p>
    {/if}
  {/if}
</div>

<style>
  .geostats-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: fade-in 0.3s ease-out;
  }

  .hdr-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .hdr-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-accent);
  }

  .hdr-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Date range ── */

  .range-bar {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .presets {
    display: flex;
    gap: var(--space-1);
  }

  .preset {
    padding: var(--space-1) var(--space-3);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .preset:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .preset.active {
    color: var(--text-primary);
    border-color: var(--accent-blue);
    background: var(--bg-tertiary);
  }

  .preset-custom {
    align-self: center;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .date-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .date-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .date-field input {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .date-field input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .apply-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--accent-blue);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    color: #fff;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  /* ── Breadcrumb ── */

  .crumbs {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--text-muted);
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .crumb:hover {
    background: var(--bg-tertiary);
  }

  .crumb.current {
    color: var(--text-primary);
    font-weight: 600;
  }

  .crumb.static {
    cursor: default;
  }

  /* ── Totals strip ── */

  .totals-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3);
  }

  .total-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .total-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .total-value {
    color: var(--text-primary);
    font-size: var(--text-xl);
    font-weight: 600;
  }

  .total-value.online {
    color: var(--status-online);
  }

  .total-value.alarm {
    color: var(--status-alarm);
  }

  /* ── Notices ── */

  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .notice.warn {
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }

  /* ── Table ── */

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
  }

  .stats-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .stats-table th,
  .stats-table td {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    white-space: nowrap;
  }

  .stats-table thead th {
    position: sticky;
    top: 0;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-default);
    font-weight: 600;
  }

  .th-num,
  .td-num {
    text-align: right;
  }

  .th-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }

  .th-btn.num {
    justify-content: flex-end;
  }

  .th-btn:hover {
    color: var(--text-primary);
  }

  .sort-arrow {
    color: var(--accent-blue);
    font-size: 11px;
    line-height: 1;
  }

  .stats-table tbody tr {
    border-bottom: 1px solid var(--border-muted);
  }

  .stats-table tbody tr:hover {
    background: var(--bg-tertiary);
  }

  .td-label {
    color: var(--text-primary);
  }

  .td-num {
    color: var(--text-secondary);
  }

  .drill-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    background: none;
    border: none;
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .drill-btn:hover .drill-name {
    text-decoration: underline;
  }

  .drill-name.static {
    color: var(--text-primary);
  }

  .stats-table tfoot .total-row {
    background: var(--bg-tertiary);
    border-top: 1px solid var(--border-default);
    color: var(--text-primary);
    font-weight: 600;
  }

  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  @media (max-width: 640px) {
    .range-bar {
      align-items: stretch;
    }

    .presets {
      flex-wrap: wrap;
    }
  }
</style>
