<script>
  /**
   * Fleet map.
   *
   * Data comes from two endpoints on purpose:
   *
   *   GET /api/map/devices  — the thin, tenant-scoped GeoJSON the markers are
   *                           drawn from (one Feature per site, plus a synthetic
   *                           Feature per device that carries its own
   *                           coordinates but belongs to no site);
   *   GET /api/devices      — the full device rows the "without coordinates"
   *                           panel needs. The map payload only carries
   *                           `meta.ungeocoded_devices`, a count, while placing a
   *                           device needs its `id`, `name`, `mqtt_device_id` and
   *                           `status`.
   *
   * The list is deliberately NOT written into the `devices` store: that store is
   * the Dashboard's render source (`$devices.filter(...)`), and handing it a
   * FeatureCollection breaks the Dashboard on the next navigation.
   *
   * Leaflet lives entirely inside MapCanvas — this page never touches `L`, and
   * the Leaflet chrome/marker CSS lives with the component that creates the DOM.
   */
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import {
    getDevices,
    updateDevice,
    getMapDevices,
    getMapFilters,
    getAlarmHeatmap,
    getIsochrones,
  } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { canWrite, isAdmin, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import {
    deviceStatus, featureLatLng, featureSiteId, formatCoords, hasEffectiveCoords,
  } from '../lib/geo.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import MapCanvas from '../components/map/MapCanvas.svelte'
  import MapFilters from '../components/map/MapFilters.svelte'
  import RoutePlanner from '../components/map/RoutePlanner.svelte'

  const POLL_MS = 30000
  const HEAT_PERIODS = [7, 30, 90]
  const ISO_PRESETS = [
    { value: '10,20,30', labelKey: 'map.iso_preset_short' },
    { value: '15,30,60', labelKey: 'map.iso_preset_default' },
    { value: '30,60,120', labelKey: 'map.iso_preset_long' },
  ]

  // ── State ──────────────────────────────────────────────

  let error = null
  let loaded = false
  let refreshing = false
  let interval

  let features = []
  let mapMeta = {}
  let deviceList = []
  let filterOptions = {}

  let filters = {
    q: '', status: 'all', country_code: '', region: '', city: '',
    model: '', firmware_version: '', site_id: '', tenant_id: '', user_id: '',
  }

  // Viewport filtering is opt-in: a map that silently drops markers as you pan
  // is worse than one that shows everything.
  let bboxOnly = false
  let viewportBbox = null

  // Exactly one click mode may be armed at a time; Escape cancels all of them.
  let placing = null      // device awaiting a click-to-place
  let startMode = false   // next click sets the round's start point
  let isoPicking = false  // next click sets the isochrone centre

  let selectedFeature = null

  // Alarm heatmap
  let showHeat = false
  let heatPoints = null
  let heatMax = 1
  let heatDays = 30
  let heatMeta = {}
  let heatLoading = false

  // Coverage isochrones
  let isoOn = false
  let isoData = null
  let isoMeta = {}
  let isoMinutes = '15,30,60'
  let isoCenter = null
  let isoLoading = false

  // Service round
  let routeMode = false
  let selectedSiteIds = []
  let routeStart = null
  let routeGeometry = null

  let canvas

  const wsUnsubs = []
  const subscribedIds = new Set()
  const tr = (key, ...args) => get(t)(key, ...args)

  // ── Derived ────────────────────────────────────────────

  // A device inherits its site's coordinates, so "has a place on the map" is an
  // effective-coordinate question. Comparing `d.latitude` alone would list every
  // correctly site-located device as unplaced.
  $: withoutCoords = deviceList.filter(d => d.status === 'active' && !hasEffectiveCoords(d))
  $: hasMarkers = deviceList.some(hasEffectiveCoords)

  $: crosshair = !!placing || startMode || isoPicking

  $: routeSites = features
    .filter(f => f.properties && f.properties.site_id)
    .map(f => {
      const ll = featureLatLng(f)
      return {
        id: f.properties.site_id,
        name: f.properties.site_name || '—',
        city: f.properties.city || null,
        latitude: ll ? ll[0] : null,
        longitude: ll ? ll[1] : null,
      }
    })

  $: canvasSelected = routeMode
    ? selectedSiteIds
    : (selectedFeature && featureSiteId(selectedFeature) ? [featureSiteId(selectedFeature)] : [])

  $: showAside = routeMode || selectedFeature !== null

  $: selectedProps = (selectedFeature && selectedFeature.properties) || null
  $: selectedLatLng = selectedFeature ? featureLatLng(selectedFeature) : null
  $: selectedDevices = selectedProps && Array.isArray(selectedProps.devices)
    ? selectedProps.devices
    : []
  $: selectedTitle = selectedProps
    ? (selectedProps.site_name
       || (selectedDevices[0] && (selectedDevices[0].name || selectedDevices[0].mqtt_device_id))
       || '—')
    : ''
  $: selectedPlace = selectedProps
    ? [selectedProps.city, selectedProps.region, selectedProps.country].filter(Boolean).join(', ')
    : ''

  // ── Query building ─────────────────────────────────────

  /** Every map endpoint takes the same filter set, so they answer one question. */
  function queryParams(extra = {}) {
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
    if (bboxOnly && viewportBbox) add('bbox', viewportBbox.join(','))

    return { ...params, ...extra }
  }

  // ── Loading ────────────────────────────────────────────

  async function load({ silent = false } = {}) {
    if (!silent) refreshing = true
    try {
      const [mapRes, list] = await Promise.all([
        getMapDevices(queryParams()),
        getDevices(),
      ])
      features = (mapRes && mapRes.data && Array.isArray(mapRes.data.features))
        ? mapRes.data.features
        : []
      mapMeta = (mapRes && mapRes.meta) || {}
      deviceList = Array.isArray(list) ? list : []
      error = null
      loaded = true
      syncWsSubscriptions(deviceList)
      pruneSelection()
      if (showHeat) await loadHeat()
    } catch (e) {
      error = e.message
    } finally {
      refreshing = false
    }
  }

  async function loadFilterOptions() {
    try {
      filterOptions = (await getMapFilters(queryParams())) || {}
    } catch {
      // The option lists are a convenience: a failure here must not take the map
      // with it, and MapFilters renders nothing for a missing array.
      filterOptions = {}
    }
  }

  async function loadHeat() {
    heatLoading = true
    try {
      const to = new Date()
      const from = new Date(to.getTime() - heatDays * 86400000)
      const res = await getAlarmHeatmap(queryParams({
        from: from.toISOString(),
        to: to.toISOString(),
      }))
      heatPoints = Array.isArray(res && res.data) ? res.data : []
      heatMeta = (res && res.meta) || {}
      // L.heatLayer normalises against `max`; without the real one every dataset
      // renders as a single solid blob.
      heatMax = Number(heatMeta.max_weight) > 0 ? Number(heatMeta.max_weight) : 1
    } catch (e) {
      heatPoints = []
      heatMeta = {}
      heatMax = 1
      toast.error(e.message)
    } finally {
      heatLoading = false
    }
  }

  async function loadIsochrones(lat, lon) {
    isoLoading = true
    try {
      const res = await getIsochrones({ lat, lon, minutes: isoMinutes })
      isoData = (res && res.data) || null
      isoMeta = (res && res.meta) || {}
      isoCenter = { lat, lon }
      isoOn = true
    } catch (e) {
      isoData = null
      isoMeta = {}
      isoCenter = null
      toast.error(e.message || tr('map.iso_failed'))
    } finally {
      isoLoading = false
    }
  }

  function reload() {
    load()
    loadFilterOptions()
  }

  // ── Live updates ───────────────────────────────────────

  function syncWsSubscriptions(rows) {
    const newIds = new Set(rows.map(d => d.mqtt_device_id))
    for (const id of subscribedIds) {
      if (!newIds.has(id)) {
        unsubscribe(id)
        subscribedIds.delete(id)
      }
    }
    for (const id of newIds) {
      if (!subscribedIds.has(id)) {
        subscribe(id)
        subscribedIds.add(id)
      }
    }
  }

  /** Site counters are server-computed; recompute them after a live patch. */
  function recountFeature(feature) {
    const props = feature.properties
    if (!props) return
    const list = Array.isArray(props.devices) ? props.devices : []
    if (list.length === 0) return
    props.device_count = list.length
    props.online_count = list.filter(d => d.online).length
    props.offline_count = list.length - props.online_count
    props.alarm_count = list.filter(d => d.alarm_active).length
  }

  function patchLocal(mqttId, patch) {
    let touched = false

    const device = deviceList.find(d => d.mqtt_device_id === mqttId)
    if (device) {
      Object.assign(device, patch)
      touched = true
    }

    for (const feature of features) {
      const list = (feature.properties && feature.properties.devices) || []
      const entry = list.find(d => d.mqtt_device_id === mqttId)
      if (!entry) continue
      Object.assign(entry, patch)
      recountFeature(feature)
      touched = true
    }

    if (!touched) return
    deviceList = deviceList
    // A new array identity is what makes MapCanvas re-read the (mutated)
    // features and refresh the icons inside a collapsed cluster.
    features = [...features]
    if (selectedFeature) selectedFeature = selectedFeature
  }

  function setupWsListeners() {
    wsUnsubs.push(on('device_online', msg => patchLocal(msg.device_id, { online: true })))
    wsUnsubs.push(on('device_offline', msg => patchLocal(msg.device_id, { online: false, last_seen: msg.last_seen })))
    wsUnsubs.push(on('alarm', msg => patchLocal(msg.device_id, { alarm_active: !!msg.active })))
    wsUnsubs.push(on('state_update', (msg) => {
      const changes = msg.changes || {}
      const patch = {}
      if (changes['equipment.air_temp'] !== undefined) patch.air_temp = changes['equipment.air_temp']
      if (changes['protection.alarm_active'] !== undefined) patch.alarm_active = !!changes['protection.alarm_active']
      if (Object.keys(patch).length > 0) patchLocal(msg.device_id, patch)
    }))
    wsUnsubs.push(on('state_full', (msg) => {
      const state = msg.state || {}
      const patch = {
        air_temp: state['equipment.air_temp'] ?? null,
        alarm_active: !!state['protection.alarm_active'],
      }
      if (msg.meta && msg.meta.online !== undefined) patch.online = !!msg.meta.online
      patchLocal(msg.device_id, patch)
    }))
  }

  // ── Click modes ────────────────────────────────────────

  function clearClickModes() {
    placing = null
    startMode = false
    isoPicking = false
  }

  function startPlacing(device) {
    clearClickModes()
    placing = device
  }

  function armStartPicker() {
    if (startMode) { startMode = false; return }
    clearClickModes()
    startMode = true
  }

  function armIsoPicker() {
    if (isoPicking) { isoPicking = false; return }
    clearClickModes()
    isoPicking = true
  }

  async function onMapClick(event) {
    const { lat, lng } = event.detail || {}
    if (lat === null || lat === undefined || lng === null || lng === undefined) return

    if (placing) {
      const target = placing
      placing = null
      try {
        await updateDevice(target.id, { latitude: lat, longitude: lng })
        patchLocal(target.mqtt_device_id, { latitude: lat, longitude: lng })
        toast.success(tr('map.location_saved'))
        // The device may have just become a Feature of its own, so the marker
        // set has to come back from the server.
        await load({ silent: true })
      } catch (e) {
        toast.error(e.message)
      }
      return
    }

    if (startMode) {
      startMode = false
      routeStart = { lat, lon: lng }
      routeMode = true
      toast.success(tr('map.route_start_set'))
      return
    }

    if (isoPicking) {
      isoPicking = false
      await loadIsochrones(lat, lng)
    }
  }

  async function removeLocation(device) {
    const row = deviceList.find(d => d.mqtt_device_id === device.mqtt_device_id)
    const id = (row && row.id) || device.id
    if (!id) return
    try {
      await updateDevice(id, { latitude: null, longitude: null })
      patchLocal(device.mqtt_device_id, { latitude: null, longitude: null })
      toast.success(tr('map.location_removed'))
      await load({ silent: true })
    } catch (e) {
      toast.error(e.message)
    }
  }

  /** The full device row — the map payload carries no `id` for the panel actions. */
  function deviceRow(mqttId) {
    return deviceList.find(d => d.mqtt_device_id === mqttId) || null
  }

  function ownCoords(mqttId) {
    const row = deviceRow(mqttId)
    return !!(row && row.latitude !== null && row.latitude !== undefined
                  && row.longitude !== null && row.longitude !== undefined)
  }

  // ── Selection / route ──────────────────────────────────

  function toggleSiteSelection(siteId) {
    const id = String(siteId)
    const next = new Set(selectedSiteIds.map(String))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedSiteIds = [...next]
  }

  /**
   * Stable identity of a Feature across reloads. Site Features key on the site;
   * the synthetic per-device Features carry their device in `devices[0]`.
   */
  function keyOf(feature) {
    const siteId = featureSiteId(feature)
    if (siteId) return `site:${siteId}`
    const list = (feature.properties && feature.properties.devices) || []
    return list[0] ? `dev:${list[0].mqtt_device_id}` : null
  }

  /**
   * Drop selected ids the current filter set no longer returns, and re-resolve
   * the open selection panel against the freshly loaded Feature objects.
   * Reads `features` directly — the derived `routeSites` has not been recomputed
   * yet at the point load() calls this.
   */
  function pruneSelection() {
    const siteIds = new Set()
    for (const feature of features) {
      const siteId = featureSiteId(feature)
      if (siteId) siteIds.add(String(siteId))
    }

    if (selectedSiteIds.length > 0) {
      const kept = selectedSiteIds.filter(id => siteIds.has(String(id)))
      if (kept.length !== selectedSiteIds.length) selectedSiteIds = kept
    }

    if (selectedFeature) {
      const key = keyOf(selectedFeature)
      selectedFeature = key ? (features.find(f => keyOf(f) === key) || null) : null
    }
  }

  function onSelect(event) {
    const { feature, additive } = event.detail || {}
    if (!feature) return
    selectedFeature = feature

    const siteId = featureSiteId(feature)
    if (!siteId) return

    if (routeMode) {
      toggleSiteSelection(siteId)
    } else if (additive && $canWrite) {
      // Ctrl/⌘/Shift-click is the documented way to build a round straight off
      // the map, so it opens the planner rather than doing nothing visible.
      // Gated with $canWrite for the same reason the button is: POST
      // /api/map/route 403s a viewer.
      routeMode = true
      toggleSiteSelection(siteId)
    }
  }

  function toggleRouteMode() {
    if (!$canWrite) return
    routeMode = !routeMode
    if (!routeMode) {
      selectedSiteIds = []
      routeGeometry = null
      startMode = false
    }
  }

  function onRoute(event) {
    routeGeometry = (event.detail && event.detail.geometry) || null
  }

  function onRouteClear() {
    routeGeometry = null
  }

  function clearRouteStart() {
    routeStart = null
    startMode = false
  }

  // ── Layer toggles ──────────────────────────────────────

  // Always refetch on enable: while the layer was off, load() stopped refreshing
  // it, so whatever is cached belongs to an older filter set.
  async function toggleHeat() {
    showHeat = !showHeat
    if (showHeat) await loadHeat()
  }

  async function onHeatPeriodChange() {
    if (showHeat) await loadHeat()
  }

  async function toggleIso() {
    if (!$canWrite) return
    if (isoOn || isoPicking) {
      isoOn = false
      isoPicking = false
      isoData = null
      isoMeta = {}
      isoCenter = null
      return
    }
    const ll = selectedFeature ? featureLatLng(selectedFeature) : null
    if (ll) await loadIsochrones(ll[0], ll[1])
    else armIsoPicker()
  }

  async function onIsoMinutesChange() {
    if (isoCenter) await loadIsochrones(isoCenter.lat, isoCenter.lon)
  }

  // ── Map events ─────────────────────────────────────────

  function onBboxChange(event) {
    viewportBbox = event.detail || null
    if (bboxOnly) load({ silent: true })
  }

  function onBboxOnlyChange() {
    load()
  }

  // load() refreshes the heat layer itself when it is on — no second call here.
  function onFiltersChange() {
    reload()
  }

  function fitBounds() {
    if (canvas) canvas.fitToFeatures()
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape') return
    if (crosshair) clearClickModes()
    else if (selectedFeature) selectedFeature = null
  }

  onMount(() => {
    setupWsListeners()
    load()
    loadFilterOptions()
    interval = setInterval(() => load({ silent: true }), POLL_MS)
  })

  onDestroy(() => {
    clearInterval(interval)
    for (const id of subscribedIds) unsubscribe(id)
    subscribedIds.clear()
    for (const fn of wsUnsubs) fn()
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="map-page">
  <PageHeader title={$t('pages.map')} subtitle={$t('pages.map_sub')}>
    <button class="hdr-btn" on:click={reload} disabled={refreshing}>
      <Icon name="refresh" size={14} />
      {$t('common.refresh')}
    </button>
  </PageHeader>

  {#if error}
    <div class="map-error">
      <Icon name="x-circle" size={16} />
      <span>{$t('map.load_failed')}: {error}</span>
    </div>
  {/if}

  <MapFilters
    bind:filters
    options={filterOptions}
    showTenant={$isSuperAdmin}
    showUser={$isAdmin}
    on:change={onFiltersChange}
  />

  <div class="layer-bar">
    <button
      type="button"
      class="layer-btn"
      class:active={showHeat}
      on:click={toggleHeat}
      disabled={heatLoading}
    >
      <Icon name="activity" size={14} />
      {$t('map.heatmap')}
    </button>

    {#if showHeat}
      <label class="layer-field">
        <span class="layer-label">{$t('map.heat_period')}</span>
        <select bind:value={heatDays} on:change={onHeatPeriodChange}>
          {#each HEAT_PERIODS as days (days)}
            <option value={days}>{$t('map.heat_days', days)}</option>
          {/each}
        </select>
      </label>
      {#if !heatLoading && heatPoints && heatPoints.length === 0}
        <span class="layer-note">{$t('map.heat_empty')}</span>
      {/if}
    {/if}

    <!--
      Isochrones and the round planner are admin/technician only server-side
      (`maybeAuthorize('admin', 'technician')` on GET /api/map/isochrones and
      POST /api/map/route). Rendering them for a viewer only ever produces a
      toast reading "Insufficient permissions", so they are hidden the same way
      every other write control on this page is.
    -->
    {#if $canWrite}
      <span class="layer-sep" aria-hidden="true"></span>

      <button
        type="button"
        class="layer-btn"
        class:active={isoOn || isoPicking}
        on:click={toggleIso}
        disabled={isoLoading}
      >
        <Icon name="clock" size={14} />
        {$t('map.isochrones')}
      </button>

      {#if isoOn || isoPicking}
        <label class="layer-field">
          <span class="layer-label">{$t('map.iso_bands')}</span>
          <select bind:value={isoMinutes} on:change={onIsoMinutesChange}>
            {#each ISO_PRESETS as preset (preset.value)}
              <option value={preset.value}>{$t(preset.labelKey)}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if isoPicking}
        <span class="layer-note">{$t('map.iso_hint')}</span>
      {/if}

      <span class="layer-sep" aria-hidden="true"></span>

      <button
        type="button"
        class="layer-btn"
        class:active={routeMode}
        on:click={toggleRouteMode}
      >
        <Icon name="send" size={14} />
        {$t('map.route_mode')}
      </button>
    {/if}

    <label class="layer-check">
      <input type="checkbox" bind:checked={bboxOnly} on:change={onBboxOnlyChange} />
      {$t('map.bbox_only')}
    </label>

    <button type="button" class="layer-btn ghost" on:click={fitBounds}>
      <Icon name="search" size={14} />
      {$t('map.fit_bounds')}
    </button>
  </div>

  <!--
    The approximate-ring warning is repeated outside the map because a planning
    decision must never rest on a circle the user believes is a drive-time
    polygon — the badge inside the canvas can sit behind a popup.
  -->
  {#if isoOn && isoData && isoMeta.approximate}
    <div class="approx-warning">
      <Icon name="alert-triangle" size={15} />
      <span>{$t('map.iso_approximate_note', isoMeta.assumed_speed_kmh ?? '—')}</span>
    </div>
  {/if}

  {#if placing}
    <div class="mode-banner">
      <Icon name="map-pin" size={16} />
      <span>{$t('map.placing_hint', placing.name || placing.mqtt_device_id)}</span>
      <button class="mode-cancel" on:click={clearClickModes}>{$t('common.cancel')}</button>
    </div>
  {:else if startMode}
    <div class="mode-banner">
      <Icon name="map-pin" size={16} />
      <span>{$t('map.route_start_hint')}</span>
      <button class="mode-cancel" on:click={clearClickModes}>{$t('common.cancel')}</button>
    </div>
  {/if}

  {#if mapMeta.truncated}
    <div class="mode-banner warn">
      <Icon name="alert-triangle" size={16} />
      <span>{$t('map.truncated_hint', mapMeta.total_devices ?? 0)}</span>
    </div>
  {/if}

  <div class="map-layout" class:has-aside={showAside}>
    <MapCanvas
      bind:this={canvas}
      {features}
      selectedSiteIds={canvasSelected}
      height="max(360px, calc(100vh - 400px))"
      {crosshair}
      {showHeat}
      {heatPoints}
      {heatMax}
      overlayGeoJson={isoOn ? isoData : null}
      overlayApproximate={!!isoMeta.approximate}
      {routeGeometry}
      on:select={onSelect}
      on:mapclick={onMapClick}
      on:bboxchange={onBboxChange}
    />

    {#if showAside}
      <aside class="map-aside">
        {#if selectedFeature}
          <div class="selection">
            <div class="selection-head">
              <span class="selection-title">{selectedTitle}</span>
              <button
                class="selection-close"
                on:click={() => (selectedFeature = null)}
                aria-label={$t('common.close')}
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            {#if selectedPlace}
              <div class="selection-place">{selectedPlace}</div>
            {/if}

            {#if selectedLatLng}
              <div class="selection-coords font-mono">
                {formatCoords(selectedLatLng[0], selectedLatLng[1])}
              </div>
            {/if}

            <div class="selection-devices">
              {#each selectedDevices as device (device.mqtt_device_id)}
                <div class="sel-device">
                  <span class="map-marker map-marker--{deviceStatus(device)} map-marker--inline"></span>
                  <a class="sel-name" href={`#/device/${device.mqtt_device_id}`}>
                    {device.name || device.mqtt_device_id}
                  </a>
                  {#if $canWrite}
                    <button class="sel-action" on:click={() => startPlacing(deviceRow(device.mqtt_device_id) || device)}>
                      {$t('map.move')}
                    </button>
                    {#if ownCoords(device.mqtt_device_id)}
                      <button class="sel-action" on:click={() => removeLocation(device)}>
                        {$t('map.remove_location')}
                      </button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if routeMode}
          <div class="route-start">
            <button type="button" class="layer-btn" class:active={startMode} on:click={armStartPicker}>
              <Icon name="map-pin" size={14} />
              {$t('map.route_set_start')}
            </button>
            {#if routeStart}
              <span class="route-start-value font-mono">{formatCoords(routeStart.lat, routeStart.lon)}</span>
              <button type="button" class="layer-btn ghost" on:click={clearRouteStart}>
                <Icon name="x" size={14} />
                {$t('map.route_clear_start')}
              </button>
            {/if}
          </div>

          <RoutePlanner
            sites={routeSites}
            bind:selectedSiteIds
            start={routeStart}
            on:route={onRoute}
            on:clear={onRouteClear}
          />
        {/if}
      </aside>
    {/if}
  </div>

  <div class="map-footer">
    <div class="map-legend">
      <span class="legend-item"><span class="map-marker map-marker--online"></span>{$t('map.legend_online')}</span>
      <span class="legend-item"><span class="map-marker map-marker--offline"></span>{$t('map.legend_offline')}</span>
      <span class="legend-item"><span class="map-marker map-marker--alarm"></span>{$t('map.legend_alarm')}</span>
    </div>

    {#if loaded && !error}
      <div class="map-stats font-mono">
        <span>{$t('map.stat_sites', mapMeta.total_sites ?? 0)}</span>
        <span>{$t('map.stat_devices', mapMeta.total_devices ?? 0)}</span>
        {#if (mapMeta.ungeocoded_devices ?? 0) > 0}
          <span class="stat-warn">{$t('map.stat_ungeocoded', mapMeta.ungeocoded_devices)}</span>
        {/if}
      </div>
    {/if}

    {#if loaded && !error && !hasMarkers}
      <p class="map-hint">{$t('map.no_coords_hint')}</p>
    {:else if loaded && !error && features.length === 0}
      <p class="map-hint">{$t('map.no_results')}</p>
    {:else if !routeMode && $canWrite}
      <!-- The hint advertises Ctrl+click → round planner, which a viewer cannot
           use: POST /api/map/route is admin/technician only. -->
      <p class="map-hint">{$t('map.multi_select_hint')}</p>
    {/if}
  </div>

  {#if $canWrite && withoutCoords.length > 0}
    <div class="no-coords-panel">
      <div class="no-coords-title">
        {$t('map.without_coords', withoutCoords.length)}
      </div>
      <div class="no-coords-list">
        {#each withoutCoords as device (device.id)}
          <div class="no-coords-item">
            <span class="no-coords-name">{device.name || device.mqtt_device_id}</span>
            <button class="place-btn" on:click={() => startPlacing(device)}>
              <Icon name="map-pin" size={13} />
              {$t('map.place_on_map')}
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /*
    Leaflet chrome (popups, zoom control, markers, tile dimming) is styled by
    MapCanvas with un-anchored :global rules, so every map surface in the app
    gets the same skin. Nothing Leaflet-owned is styled here.
  */

  .map-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
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

  .map-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--status-alarm);
    border-radius: var(--radius-md);
    color: var(--status-alarm);
    font-size: var(--text-sm);
  }

  /* ── Layer toolbar ── */

  .layer-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .layer-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .layer-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .layer-btn.active {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #fff;
  }

  .layer-btn.ghost {
    border-style: dashed;
  }

  .layer-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .layer-field {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .layer-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .layer-field select {
    padding: var(--space-1) var(--space-2);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .layer-check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .layer-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .layer-sep {
    width: 1px;
    height: 20px;
    background: var(--border-default);
  }

  .approx-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-secondary);
    border: 1px dashed var(--accent-yellow);
    border-radius: var(--radius-md);
    color: var(--accent-yellow);
    font-size: var(--text-xs);
  }

  .mode-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-md);
    color: var(--accent-blue);
    font-size: var(--text-sm);
  }

  .mode-banner.warn {
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }

  .mode-cancel {
    margin-left: auto;
    padding: 2px 10px;
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .mode-cancel:hover {
    color: var(--text-primary);
    border-color: var(--border-accent);
  }

  /* ── Layout ── */

  .map-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4);
    align-items: start;
  }

  .map-layout.has-aside {
    grid-template-columns: minmax(0, 1fr) 320px;
  }

  .map-aside {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  /* ── Selection panel ── */

  .selection {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .selection-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .selection-title {
    flex: 1;
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selection-close {
    display: inline-flex;
    padding: 2px;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .selection-close:hover {
    color: var(--text-primary);
  }

  .selection-place,
  .selection-coords {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .selection-devices {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 260px;
    overflow-y: auto;
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-default);
  }

  .sel-device {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }

  .sel-device:hover {
    background: var(--bg-tertiary);
  }

  .sel-name {
    flex: 1;
    color: var(--text-primary);
    font-size: var(--text-sm);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sel-name:hover {
    color: var(--accent-blue);
  }

  .sel-action {
    padding: 2px 6px;
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .sel-action:hover {
    border-color: var(--accent-blue);
  }

  .route-start {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .route-start-value {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  /* ── Footer ── */

  .map-footer {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .map-legend {
    display: flex;
    gap: var(--space-4);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .map-stats {
    display: flex;
    gap: var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .stat-warn {
    color: var(--accent-yellow);
  }

  .map-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  /* ── "Without coordinates" panel ── */

  .no-coords-panel {
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .no-coords-title {
    margin-bottom: var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .no-coords-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .no-coords-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }

  .no-coords-name {
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .place-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  .place-btn:hover {
    border-color: var(--accent-blue);
  }

  @media (max-width: 1024px) {
    .map-layout.has-aside {
      grid-template-columns: 1fr;
    }
  }
</style>
