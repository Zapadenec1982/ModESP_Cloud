<script>
  /**
   * Service-round planner: pick sites, ask the backend for an order, hand the
   * result to a phone.
   *
   * The parent owns both the selection and the drawn polyline:
   *
   *   <RoutePlanner bind:selectedSiteIds {sites} {start}
   *                 on:route={e => routeGeometry = e.detail.geometry}
   *                 on:clear={() => routeGeometry = null} />
   *   <MapCanvas {features} {selectedSiteIds} {routeGeometry} on:select={toggle} />
   *
   * `POST /api/map/route` answers 200 even with `OSRM_URL` empty, degrading to a
   * nearest-neighbour order with `legs: null` and `meta.optimized: false`. That is
   * a usable answer, not a failure, so the panel stays visible and labels the
   * result "orientation only" instead of hiding the feature. Set `enabled={false}`
   * to remove it altogether.
   */
  import { createEventDispatcher } from 'svelte'
  import { t } from '../../lib/i18n.js'
  import { formatDuration } from '../../lib/format.js'
  import Icon from '../ui/Icon.svelte'
  import { googleRouteUrl, isValidCoords, planRoute } from '../../lib/geo.js'

  /** `[{ id, name, city, latitude, longitude }]` — usually derived from map features. */
  export let sites = []
  /** Bound by the parent and shared with `MapCanvas.selectedSiteIds`. */
  export let selectedSiteIds = []
  /** `{ lat, lon }` — the technician's home base, when known. */
  export let start = null
  /** `false` hides the whole panel. */
  export let enabled = true
  /** The backend caps `site_ids` at 25; keep the two numbers in step. */
  export let maxStops = 25
  /** Injection point for pages that already own an API wrapper. */
  export let routeFn = planRoute

  const dispatch = createEventDispatcher()

  let roundtrip = false
  let loading = false
  let error = null
  let result = null   // { order, legs, geometry, total_distance_m, total_duration_s, google_maps_url }
  let meta = {}

  $: routable = (sites || []).filter((s) => s && isValidCoords(s.latitude, s.longitude))
  $: unroutable = (sites || []).filter((s) => s && !isValidCoords(s.latitude, s.longitude))
  $: selected = new Set((selectedSiteIds || []).map(String))
  $: selectedCount = routable.filter((s) => selected.has(String(s.id))).length
  $: tooMany = selectedCount > maxStops
  $: canBuild = selectedCount > 0 && !tooMany && !loading
  // "Degraded" means no upstream router was involved at all: the backend answers
  // 200 with `geometry: null, legs: null` when OSRM is unset, times out or 5xxs,
  // and the order is then a plain haversine nearest-neighbour walk.
  $: degraded = !!result && (result.geometry == null || !Array.isArray(result.legs))
  $: stops = buildStops(result, routable, start)
  $: handoffUrl = result
    ? (result.google_maps_url || googleRouteUrl(
        stops.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
        { origin: start ? { latitude: start.lat, longitude: start.lon } : null },
      ))
    : null

  /** Resolve `order: [site_id…]` back to site rows, in visiting order. */
  function buildStops(res, pool, origin) {
    if (!res || !Array.isArray(res.order)) return []
    const byId = new Map(pool.map((s) => [String(s.id), s]))
    const legs = Array.isArray(res.legs) ? res.legs : null
    const fromBase = !!(origin && isValidCoords(origin.lat, origin.lon))
    const out = []
    res.order.forEach((id, index) => {
      const site = byId.get(String(id))
      if (!site) return
      // With a start point the first leg is base → stop 1, so leg i lands on stop i.
      // Without one the walk begins at stop 1, which has no incoming leg.
      const legIndex = fromBase ? index : index - 1
      const leg = legs && legIndex >= 0 && legIndex < legs.length ? legs[legIndex] : null
      out.push({
        id: site.id,
        name: site.name,
        city: site.city,
        latitude: site.latitude,
        longitude: site.longitude,
        distance_m: leg ? leg.distance_m : null,
        duration_s: leg ? leg.duration_s : null,
      })
    })
    return out
  }

  function toggle(siteId) {
    const id = String(siteId)
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedSiteIds = [...next]
    dispatch('change', selectedSiteIds)
  }

  function selectAll() {
    selectedSiteIds = routable.slice(0, maxStops).map((s) => s.id)
    dispatch('change', selectedSiteIds)
  }

  function clearSelection() {
    selectedSiteIds = []
    result = null
    meta = {}
    error = null
    dispatch('change', selectedSiteIds)
    dispatch('clear')
  }

  async function build() {
    if (!canBuild) return
    loading = true
    error = null
    try {
      const ids = routable.filter((s) => selected.has(String(s.id))).map((s) => s.id)
      const response = await routeFn({ site_ids: ids, start, roundtrip })
      result = response.data
      meta = response.meta || {}
      if (!result) {
        error = $t('map.route_failed')
        dispatch('clear')
        return
      }
      // Computed here, not read from the `$:` above — reactive statements run
      // after this function returns, so `stops` still holds the previous route.
      const orderedStops = buildStops(result, routable, start)
      dispatch('route', {
        geometry: result.geometry || null,
        order: result.order || [],
        legs: Array.isArray(result.legs) ? result.legs : null,
        total_distance_m: result.total_distance_m ?? null,
        total_duration_s: result.total_duration_s ?? null,
        google_maps_url: result.google_maps_url || null,
        degraded: result.geometry == null || !Array.isArray(result.legs),
        meta,
        stops: orderedStops,
      })
    } catch (e) {
      result = null
      meta = {}
      error = e.message || $t('map.route_failed')
      dispatch('clear')
    } finally {
      loading = false
    }
  }

  // Reactive so a language switch re-renders the units: `formatDuration` reads the
  // dictionary through `get(t)`, which Svelte cannot see from a plain function.
  $: km = (metres) => {
    const n = Number(metres)
    if (!Number.isFinite(n)) return null
    return `${(n / 1000).toFixed(1)} ${$t('map.unit_km')}`
  }

  $: seconds = (value) => {
    void $t
    const n = Number(value)
    return Number.isFinite(n) ? formatDuration(Math.round(n)) : null
  }
</script>

{#if enabled}
  <div class="route-planner">
    <div class="header">
      <Icon name="map-pin" size={15} />
      <span class="title">{$t('map.route_planner')}</span>
      <span class="count">{selectedCount}/{maxStops}</span>
    </div>

    {#if routable.length === 0}
      <p class="hint">{$t('map.route_no_sites')}</p>
    {:else}
      <div class="picker">
        {#each routable as site (site.id)}
          <label class="site-row" class:picked={selected.has(String(site.id))}>
            <input
              type="checkbox"
              checked={selected.has(String(site.id))}
              on:change={() => toggle(site.id)}
            />
            <span class="site-name">{site.name}</span>
            {#if site.city}<span class="site-city">{site.city}</span>{/if}
          </label>
        {/each}
      </div>

      {#if unroutable.length > 0}
        <p class="hint">{$t('map.route_skipped_no_coords', unroutable.length)}</p>
      {/if}

      <div class="controls">
        <label class="check">
          <input type="checkbox" bind:checked={roundtrip} />
          {$t('map.route_roundtrip')}
        </label>

        <button type="button" class="link-btn" on:click={selectAll}>{$t('map.route_select_all')}</button>
        <button type="button" class="link-btn" on:click={clearSelection}>{$t('map.route_clear')}</button>

        <button type="button" class="build-btn" disabled={!canBuild} on:click={build}>
          {#if loading}
            <span class="spinner" aria-hidden="true"></span>
            {$t('map.route_building')}
          {:else}
            <Icon name="send" size={14} />
            {$t('map.route_build')}
          {/if}
        </button>
      </div>

      {#if tooMany}
        <p class="hint hint-warn">
          <Icon name="alert-triangle" size={13} />
          {$t('map.route_max_stops', maxStops)}
        </p>
      {/if}

      {#if error}
        <p class="hint hint-error">
          <Icon name="x-circle" size={13} />
          {error}
        </p>
      {/if}

      {#if result && stops.length > 0}
        <div class="result">
          {#if degraded}
            <p class="hint hint-warn">
              <Icon name="alert-triangle" size={13} />
              {$t('map.route_orientation_only')}
            </p>
          {/if}

          <ol class="stops">
            {#if start && isValidCoords(start.lat, start.lon)}
              <li class="stop stop-start">
                <span class="stop-index">0</span>
                <span class="stop-name">{$t('map.route_start')}</span>
              </li>
            {/if}
            <!-- keyed by position: a roundtrip may legitimately repeat a site id -->
            {#each stops as stop, i (`${stop.id}:${i}`)}
              <li class="stop">
                <span class="stop-index">{i + 1}</span>
                <span class="stop-name">{stop.name}</span>
                {#if stop.city}<span class="stop-city">{stop.city}</span>{/if}
                <span class="stop-metrics">
                  {#if stop.distance_m != null}<span>{km(stop.distance_m)}</span>{/if}
                  {#if stop.duration_s != null}<span>{seconds(stop.duration_s)}</span>{/if}
                </span>
              </li>
            {/each}
          </ol>

          <div class="totals">
            <span class="totals-label">{$t('map.route_total')}</span>
            {#if result.total_distance_m != null}
              <span class="totals-value">{km(result.total_distance_m)}</span>
            {/if}
            {#if result.total_duration_s != null}
              <span class="totals-value">{seconds(result.total_duration_s)}</span>
            {/if}
          </div>

          {#if handoffUrl}
            <a class="handoff" href={handoffUrl} target="_blank" rel="noopener">
              <Icon name="link" size={14} />
              {$t('map.route_open_google')}
            </a>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .route-planner {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
  }

  .title {
    flex: 1;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .count {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 220px;
    overflow-y: auto;
  }

  .site-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .site-row:hover {
    background: var(--bg-tertiary);
  }

  .site-row.picked {
    background: var(--bg-tertiary);
  }

  .site-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .site-city {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .link-btn {
    padding: 0;
    background: none;
    border: none;
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .build-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    padding: var(--space-2) var(--space-4);
    background: var(--accent-blue);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    color: #fff;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .build-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-default);
  }

  .stops {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .stop {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .stop-start {
    background: transparent;
    color: var(--text-secondary);
  }

  .stop-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent-blue);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .stop-start .stop-index {
    background: var(--text-muted);
    /* The base rule hardcodes #fff, which lands at 2.6:1 on the light-theme
       --text-muted (#94a3b8) — below WCAG AA. Same override MapCanvas applies
       to .map-cluster--offline for the same reason. */
    color: var(--text-primary);
  }

  .stop-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stop-city {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .stop-metrics {
    display: flex;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .totals {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .totals-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .totals-value {
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .handoff {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-size: var(--text-sm);
    text-decoration: none;
    transition: border-color var(--transition-fast);
  }

  .handoff:hover {
    border-color: var(--accent-blue);
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

  .hint-error {
    color: var(--status-alarm);
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
</style>
