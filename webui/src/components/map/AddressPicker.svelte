<script>
  /**
   * Structured address editor with server-proxied geocoding.
   *
   * Two shapes, because the two things that need it store different columns:
   *   mode="full"  — the `sites` address object:
   *                  { country_code, country, region, city, address_line,
   *                    postal_code, latitude, longitude }
   *   mode="point" — a technician's home base, which is only
   *                  { latitude, longitude, display_name } → users.base_*
   *
   * Geocoding is ENV-gated on the server: with `GEOCODER_PROVIDER=none` the proxy
   * answers `200 { data: [], meta: { enabled: false } }`. This component therefore
   * never depends on it — every field stays typeable, the map stays clickable, and
   * the autocomplete just disappears with an explanatory hint. Pass
   * `geocodingEnabled={false}` to hide it up front; `meta.enabled === false` from
   * the first search does the same at runtime, and a THROWN request shows the
   * separate "unreachable" hint instead (that one is worth retrying).
   *
   * Import it lazily so Leaflet stays out of the entry chunk.
   */
  import { createEventDispatcher, onDestroy } from 'svelte'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'
  import MapCanvas from './MapCanvas.svelte'
  import {
    POINT_ZOOM, emptyAddress, formatCoords, geoReverse, geoSearchFull, isValidCoords,
    precisionKey, roundCoord,
  } from '../../lib/geo.js'

  export let mode = 'full'
  /** Bound by the parent — see the shapes above. */
  export let value = null
  export let disabled = false
  export let height = '240px'
  /** Set false when the deployment has no geocoder; hides the autocomplete. */
  export let geocodingEnabled = true
  export let showMap = true
  /**
   * mode="point" only: i18n key for the free-text label field. Defaults to the
   * technician home-base wording; pass `null` where the caller has nowhere to
   * store a label (a per-device coordinate override) so the field is not shown
   * at all rather than shown and silently discarded.
   */
  export let labelKey = 'site.base_address'
  /**
   * Injection points for pages that already own an API wrapper. `searchFn` may
   * return either a plain array or the `{ data, meta }` envelope — runSearch()
   * accepts both, so lib/api.js's same-named wrappers can be swapped in without
   * silently yielding zero results.
   */
  export let searchFn = geoSearchFull
  export let reverseFn = geoReverse

  const dispatch = createEventDispatcher()
  const SEARCH_DEBOUNCE_MS = 400
  const MIN_QUERY = 3

  let canvas
  let query = ''
  let results = []
  let open = false
  let highlighted = -1
  let searching = false
  let searched = false
  let reversing = false
  /** Set when a request failed — the geocoder is up but unreachable right now. */
  let unavailable = false
  /**
   * Set when the SERVER reported the geocoder as switched off
   * (`meta.enabled === false`). Distinct from `unavailable`: "not configured" and
   * "configured but unreachable" are different messages to the user, and only the
   * second one is worth retrying.
   */
  let serverDisabled = false
  let searchTimer = null
  let blurTimer = null
  let requestSeq = 0

  // A parent that binds without initialising gets a usable object back.
  $: if (!value) value = mode === 'point'
    ? { latitude: null, longitude: null, display_name: '' }
    : emptyAddress()

  $: hasCoords = !!value && isValidCoords(value.latitude, value.longitude)
  $: coordText = value ? formatCoords(value.latitude, value.longitude) : null
  $: pin = hasCoords ? { lat: Number(value.latitude), lng: Number(value.longitude) } : null
  $: showAutocomplete = geocodingEnabled && !serverDisabled && !unavailable && !disabled
  $: mapCenter = hasCoords ? [Number(value.latitude), Number(value.longitude)] : undefined

  function commit() {
    // New object identity so `bind:value` and every `$:` in the parent re-run.
    value = { ...value }
    dispatch('change', value)
  }

  /**
   * Bring the map to a point that was chosen somewhere other than the map itself
   * (autocomplete result, typed coordinates) — otherwise the pin lands outside the
   * default country-wide view and looks like nothing happened. Deliberately NOT
   * called from `setPoint`, where recentring would fight the user's own click.
   */
  function recentre() {
    if (canvas && isValidCoords(value.latitude, value.longitude)) {
      canvas.panTo(value.latitude, value.longitude, POINT_ZOOM)
    }
  }

  // ── Autocomplete ─────────────────────────────────────────

  function onQueryInput() {
    clearTimeout(searchTimer)
    highlighted = -1
    if (query.trim().length < MIN_QUERY) {
      results = []
      searched = false
      open = false
      return
    }
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS)
  }

  async function runSearch() {
    const q = query.trim()
    if (q.length < MIN_QUERY) return
    const seq = ++requestSeq
    searching = true
    try {
      const found = await searchFn(q, 6)
      if (seq !== requestSeq) return   // a newer keystroke already won

      // Both shapes: a bare array, or the `{ data, meta }` envelope.
      const list = Array.isArray(found)
        ? found
        : (found && Array.isArray(found.data) ? found.data : [])
      const meta = (found && !Array.isArray(found) && found.meta) || null

      // A disabled geocoder answers 200 with an empty list, which is otherwise
      // indistinguishable from "no matches" — and telling the user their address
      // was not found would be a lie. Hide the box instead.
      if (meta && meta.enabled === false) {
        serverDisabled = true
        results = []
        searched = false
        open = false
        return
      }

      results = list
      searched = true
      open = results.length > 0
    } catch {
      if (seq !== requestSeq) return
      // Disabled and unreachable are indistinguishable by design — degrade to
      // manual entry either way rather than blocking the form.
      unavailable = true
      results = []
      open = false
    } finally {
      if (seq === requestSeq) searching = false
    }
  }

  function applyResult(result) {
    if (!result) return
    const lat = roundCoord(result.latitude)
    const lon = roundCoord(result.longitude)

    if (mode === 'point') {
      value.latitude = lat
      value.longitude = lon
      value.display_name = result.display_name || ''
    } else {
      const a = result.address || {}
      value.latitude = lat
      value.longitude = lon
      if (a.country_code) value.country_code = String(a.country_code).toUpperCase().slice(0, 2)
      if (a.country) value.country = a.country
      if (a.region) value.region = a.region
      if (a.city) value.city = a.city
      if (a.address_line) value.address_line = a.address_line
      if (a.postal_code) value.postal_code = a.postal_code
      if (result.precision) value.geo_precision = result.precision
    }

    query = result.display_name || query
    results = []
    open = false
    highlighted = -1
    commit()
    recentre()
  }

  function onQueryKeydown(event) {
    if (!open || results.length === 0) {
      if (event.key === 'Escape') open = false
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      highlighted = (highlighted + 1) % results.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      highlighted = highlighted <= 0 ? results.length - 1 : highlighted - 1
    } else if (event.key === 'Enter') {
      event.preventDefault()
      applyResult(results[highlighted >= 0 ? highlighted : 0])
    } else if (event.key === 'Escape') {
      open = false
      highlighted = -1
    }
  }

  function onQueryBlur() {
    // A click on a result fires mousedown → blur → click; keep the list alive.
    blurTimer = setTimeout(() => { open = false }, 160)
  }

  function onQueryFocus() {
    clearTimeout(blurTimer)
    if (results.length > 0) open = true
  }

  // ── Map picking ──────────────────────────────────────────

  async function setPoint(lat, lng) {
    if (disabled) return
    value.latitude = roundCoord(lat)
    value.longitude = roundCoord(lng)
    commit()
    if (!geocodingEnabled || serverDisabled || unavailable) return

    reversing = true
    try {
      const raw = await reverseFn(value.latitude, value.longitude)
      // Same two shapes as searchFn: a bare result object, or `{ data, meta }`.
      const found = raw && typeof raw === 'object' && 'data' in raw && 'meta' in raw
        ? raw.data
        : raw
      if (!found) return
      if (mode === 'point') {
        value.display_name = found.display_name || value.display_name || ''
      } else {
        const a = found.address || {}
        if (a.country_code) value.country_code = String(a.country_code).toUpperCase().slice(0, 2)
        if (a.country) value.country = a.country
        if (a.region) value.region = a.region
        if (a.city) value.city = a.city
        if (a.address_line) value.address_line = a.address_line
        if (a.postal_code) value.postal_code = a.postal_code
        if (found.precision) value.geo_precision = found.precision
      }
      commit()
    } catch {
      unavailable = true
    } finally {
      reversing = false
    }
  }

  function onMapClick(event) {
    setPoint(event.detail.lat, event.detail.lng)
  }

  function onPinMove(event) {
    setPoint(event.detail.lat, event.detail.lng)
  }

  function clearCoords() {
    if (disabled) return
    value.latitude = null
    value.longitude = null
    commit()
  }

  /** Manual lat/lon typing — a blank or unparseable field clears the coordinate. */
  function onCoordInput(field, raw) {
    const parsed = raw === '' || raw === null ? null : Number(raw)
    value[field] = Number.isFinite(parsed) ? parsed : null
    commit()
    recentre()
  }

  onDestroy(() => {
    clearTimeout(searchTimer)
    clearTimeout(blurTimer)
  })
</script>

<div class="address-picker">
  {#if showAutocomplete}
    <div class="search-block">
      <label class="field">
        <span class="field-label">{$t('site.search_address')}</span>
        <div class="search-row">
          <Icon name="search" size={15} />
          <input
            type="text"
            class="text-input search-input"
            autocomplete="off"
            placeholder={$t('site.search_placeholder')}
            bind:value={query}
            on:input={onQueryInput}
            on:keydown={onQueryKeydown}
            on:blur={onQueryBlur}
            on:focus={onQueryFocus}
            {disabled}
          />
          {#if searching}<span class="spinner" aria-hidden="true"></span>{/if}
        </div>
      </label>

      {#if open && results.length > 0}
        <ul class="results" role="listbox">
          {#each results as result, i (result.display_name + ':' + i)}
            <li role="presentation">
              <button
                type="button"
                class="result"
                class:highlighted={i === highlighted}
                role="option"
                aria-selected={i === highlighted}
                on:mousedown|preventDefault={() => applyResult(result)}
                on:mouseenter={() => (highlighted = i)}
              >
                <span class="result-name">{result.display_name}</span>
                {#if result.precision}
                  <span class="result-badge">{$t(precisionKey(result.precision))}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else if searched && !searching && query.trim().length >= MIN_QUERY}
        <p class="hint">{$t('site.no_results')}</p>
      {/if}
    </div>
  {:else if !geocodingEnabled || serverDisabled}
    <p class="hint">
      <Icon name="info" size={13} />
      {$t('site.geocoding_disabled')}
    </p>
  {:else if unavailable}
    <p class="hint hint-warn">
      <Icon name="alert-triangle" size={13} />
      {$t('site.geocoding_unavailable')}
    </p>
  {/if}

  {#if mode === 'full'}
    <div class="grid">
      <label class="field span-2">
        <span class="field-label">{$t('site.address_line')}</span>
        <input
          type="text" class="text-input" maxlength="256" {disabled}
          bind:value={value.address_line} on:change={commit}
        />
      </label>

      <label class="field">
        <span class="field-label">{$t('site.city')}</span>
        <input
          type="text" class="text-input" maxlength="128" {disabled}
          bind:value={value.city} on:change={commit}
        />
      </label>

      <label class="field">
        <span class="field-label">{$t('site.postal_code')}</span>
        <input
          type="text" class="text-input" maxlength="16" {disabled}
          bind:value={value.postal_code} on:change={commit}
        />
      </label>

      <label class="field">
        <span class="field-label">{$t('site.region')}</span>
        <input
          type="text" class="text-input" maxlength="128" {disabled}
          bind:value={value.region} on:change={commit}
        />
      </label>

      <label class="field">
        <span class="field-label">{$t('site.country')}</span>
        <input
          type="text" class="text-input" maxlength="64" {disabled}
          bind:value={value.country} on:change={commit}
        />
      </label>

      <label class="field">
        <span class="field-label">{$t('site.country_code')}</span>
        <input
          type="text" class="text-input" maxlength="2" placeholder="UA" {disabled}
          bind:value={value.country_code} on:change={commit}
        />
      </label>
    </div>
  {:else if labelKey}
    <label class="field">
      <span class="field-label">{$t(labelKey)}</span>
      <input
        type="text" class="text-input" maxlength="256" {disabled}
        bind:value={value.display_name} on:change={commit}
      />
    </label>
  {/if}

  <div class="coord-row">
    <label class="field coord-field">
      <span class="field-label">{$t('site.latitude')}</span>
      <input
        type="number" class="text-input" step="0.000001" min="-90" max="90" {disabled}
        value={value.latitude ?? ''}
        on:change={(e) => onCoordInput('latitude', e.currentTarget.value)}
      />
    </label>

    <label class="field coord-field">
      <span class="field-label">{$t('site.longitude')}</span>
      <input
        type="number" class="text-input" step="0.000001" min="-180" max="180" {disabled}
        value={value.longitude ?? ''}
        on:change={(e) => onCoordInput('longitude', e.currentTarget.value)}
      />
    </label>

    {#if hasCoords && !disabled}
      <button type="button" class="clear-btn" on:click={clearCoords}>
        <Icon name="x" size={13} />
        {$t('site.clear_coords')}
      </button>
    {/if}
  </div>

  {#if showMap}
    <MapCanvas
      bind:this={canvas}
      {height}
      features={[]}
      {pin}
      pinDraggable={!disabled}
      crosshair={!disabled && !hasCoords}
      clustered={false}
      popups={false}
      autoFit={false}
      center={mapCenter}
      zoom={hasCoords ? POINT_ZOOM : undefined}
      on:mapclick={onMapClick}
      on:pinmove={onPinMove}
    />

    <p class="hint">
      {#if reversing}
        <span class="spinner" aria-hidden="true"></span>
        {$t('site.searching')}
      {:else if hasCoords}
        <Icon name="map-pin" size={13} />
        {coordText} — {$t('site.drag_marker_hint')}
      {:else}
        <Icon name="map-pin" size={13} />
        {$t('site.pick_on_map')}
      {/if}
    </p>
  {/if}
</div>

<style>
  .address-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .search-block {
    position: relative;
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

  .text-input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    box-sizing: border-box;
    transition: border-color var(--transition-fast);
  }

  .text-input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .text-input::placeholder {
    color: var(--text-muted);
  }

  .text-input:disabled {
    color: var(--text-muted);
    cursor: not-allowed;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-left: var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }

  .search-row:focus-within {
    border-color: var(--accent-blue);
  }

  .search-input {
    border: none;
    background: none;
    padding-left: 0;
  }

  .search-input:focus {
    border: none;
  }

  .results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1200;
    margin: var(--space-1) 0 0;
    padding: var(--space-1);
    list-style: none;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-lg);
  }

  .result {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .result.highlighted {
    background: var(--bg-tertiary);
  }

  .result-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-badge {
    flex-shrink: 0;
    padding: 1px var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .span-2 {
    grid-column: span 2;
  }

  .coord-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .coord-field {
    flex: 1;
    min-width: 130px;
  }

  .clear-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .clear-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .hint {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .hint-warn {
    color: var(--accent-yellow);
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: var(--space-2);
    border: 2px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .span-2 {
      grid-column: span 1;
    }
  }
</style>
