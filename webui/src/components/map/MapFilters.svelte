<script>
  /**
   * Filter bar for the fleet map and the geo statistics page.
   *
   * Follows the shipped filter convention (`components/dashboard/DeviceFilter.svelte`):
   * the parent keeps ownership of the state with `bind:filters` and reloads on a
   * detail-less `change` event. Svelte 4 props are one-way, so a plain
   * `export let filters` mutated here would never reach the parent.
   *
   *   <MapFilters bind:filters {options} showTenant={$isSuperAdmin} on:change={load} />
   *
   * `options` comes from `GET /api/map/filters`, which returns `tenants` only for a
   * superadmin and `users` only for admin and above — every array is treated as
   * optional.
   */
  import { createEventDispatcher, onDestroy } from 'svelte'
  import { t } from '../../lib/i18n.js'
  import SearchInput from '../ui/SearchInput.svelte'
  import Icon from '../ui/Icon.svelte'

  /** Bound by the parent. Missing keys behave as "no filter". */
  export let filters = {}
  /** `data` from `GET /api/map/filters`. */
  export let options = {}
  export let showTenant = false
  export let showUser = false
  export let showStatus = true

  const dispatch = createEventDispatcher()
  const SEARCH_DEBOUNCE_MS = 350

  const DEFAULTS = {
    q: '', status: 'all', country_code: '', region: '', city: '',
    model: '', firmware_version: '', site_id: '', tenant_id: '', user_id: '',
  }

  // Fill the missing keys once, at init: a `<select>` bound to `undefined` shows a
  // blank row instead of the "all" option, and the first user pick then looks like
  // a change from nothing.
  for (const key of Object.keys(DEFAULTS)) {
    if (filters[key] === undefined) filters[key] = DEFAULTS[key]
  }

  let searchTimer = null
  let lastQuery = filters.q || ''

  $: statuses = [
    { value: 'all',     label: $t('map.filter_all') },
    { value: 'online',  label: $t('map.filter_online') },
    { value: 'offline', label: $t('map.filter_offline') },
    { value: 'alarm',   label: $t('map.filter_alarm') },
  ]

  // Free-text search is debounced; every other control dispatches immediately.
  $: if ((filters.q || '') !== lastQuery) {
    lastQuery = filters.q || ''
    queueSearchChange()
  }

  $: countries = Array.isArray(options.countries) ? options.countries : []
  $: regions = Array.isArray(options.regions) ? options.regions : []
  $: cities = Array.isArray(options.cities) ? options.cities : []
  $: models = Array.isArray(options.models) ? options.models : []
  $: firmwares = Array.isArray(options.firmware_versions) ? options.firmware_versions : []
  $: tenants = Array.isArray(options.tenants) ? options.tenants : []
  $: users = Array.isArray(options.users) ? options.users : []

  $: activeCount = countActive(filters)

  function countActive(f) {
    const keys = ['q', 'country_code', 'region', 'city', 'model', 'firmware_version', 'tenant_id', 'user_id', 'site_id']
    let n = keys.filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '').length
    if (f.status && f.status !== 'all') n += 1
    return n
  }

  function queueSearchChange() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => dispatch('change'), SEARCH_DEBOUNCE_MS)
  }

  function emitChange() {
    clearTimeout(searchTimer)
    dispatch('change')
  }

  function setStatus(value) {
    filters.status = value
    emitChange()
  }

  function reset() {
    filters = { ...filters, ...DEFAULTS }
    lastQuery = ''
    emitChange()
  }

  /** "Київська область · 12" — count is a number the API produced. */
  function withCount(label, count) {
    const n = Number(count)
    return Number.isFinite(n) && n > 0 ? `${label} · ${n}` : label
  }

  onDestroy(() => clearTimeout(searchTimer))
</script>

<div class="map-filters">
  <div class="row">
    <div class="search-wrap">
      <SearchInput bind:value={filters.q} placeholder={$t('map.search_placeholder')} />
    </div>

    {#if showStatus}
      <div class="pills">
        {#each statuses as s (s.value)}
          <button
            type="button"
            class="pill"
            class:active={(filters.status || 'all') === s.value}
            on:click={() => setStatus(s.value)}
          >
            {s.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if activeCount > 0}
      <button type="button" class="reset-btn" on:click={reset}>
        <Icon name="x" size={14} />
        {$t('map.filter_reset')}
      </button>
    {/if}
  </div>

  <div class="row selects">
    {#if countries.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_country')}</span>
        <select bind:value={filters.country_code} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each countries as c (c.code)}
            <option value={c.code}>{withCount(c.name || c.code, c.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if regions.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_region')}</span>
        <select bind:value={filters.region} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each regions as r (r.name)}
            <option value={r.name}>{withCount(r.name, r.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if cities.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_city')}</span>
        <select bind:value={filters.city} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each cities as c (c.name)}
            <option value={c.name}>{withCount(c.name, c.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if models.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_model')}</span>
        <select bind:value={filters.model} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each models as m (m.name)}
            <option value={m.name}>{withCount(m.name, m.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if firmwares.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_firmware')}</span>
        <select bind:value={filters.firmware_version} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each firmwares as f (f.version)}
            <option value={f.version}>{withCount(f.version, f.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if showTenant && tenants.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_tenant')}</span>
        <select bind:value={filters.tenant_id} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each tenants as tn (tn.id)}
            <option value={tn.id}>{withCount(tn.name || tn.slug, tn.count)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if showUser && users.length > 0}
      <label class="field">
        <span class="field-label">{$t('map.filter_user')}</span>
        <select bind:value={filters.user_id} on:change={emitChange}>
          <option value="">{$t('common.all')}</option>
          {#each users as u (u.id)}
            <option value={u.id}>{withCount(u.email, u.count)}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
</div>

<style>
  .map-filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .row.selects {
    align-items: flex-end;
  }

  .search-wrap {
    flex: 1;
    min-width: 200px;
  }

  .pills {
    display: flex;
    gap: var(--space-1);
  }

  .pill {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--text-muted);
    color: var(--text-primary);
  }

  .pill.active {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #fff;
  }

  .reset-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .reset-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .field-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .field select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    min-width: 150px;
    max-width: 240px;
  }

  .field select:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.15);
  }

  @media (max-width: 640px) {
    .search-wrap {
      min-width: unset;
      flex-basis: 100%;
    }

    .pills {
      overflow-x: auto;
    }

    .field select {
      min-width: 130px;
      max-width: 100%;
    }
  }
</style>
