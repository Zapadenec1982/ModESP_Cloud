<script>
  /**
   * Reusable Leaflet canvas — the single place in the app that instantiates a map.
   *
   * Everything that draws on a map goes through here: the fleet map, the device
   * location mini-map, the address picker and the round planner. That keeps one
   * init path, one cleanup path, one set of Leaflet theme rules and — most
   * importantly — one popup builder that never touches innerHTML.
   *
   * SECURITY: site names, cities, regions, addresses and device names are all
   * tenant-writable and flow straight into marker popups. Every popup, badge and
   * divIcon below is assembled with document.createElement + textContent. Never
   * introduce a template string into an L.divIcon({ html }), a bindPopup(String),
   * a bindTooltip(String) or an onEachFeature popup here — Svelte's escaping does
   * not reach content that Leaflet injects.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte'
  import { get } from 'svelte/store'
  import L from '../../lib/leaflet.js'
  import { t } from '../../lib/i18n.js'
  import { effectiveTheme } from '../../lib/theme.js'
  import {
    TILE_URL, TILE_ATTRIBUTION, TILE_MAX_ZOOM, DEFAULT_CENTER, DEFAULT_ZOOM,
    boundsToBbox, clampLat, cssVar, deviceStatus, featureDeviceCount, featureKey,
    featureLatLng, featureStatus, isValidCoords, roundCoord, routeLinks, statusRank,
  } from '../../lib/geo.js'

  /** GeoJSON Point features, e.g. `data.features` from `GET /api/map/devices`. */
  export let features = []
  /** Any CSS length. The container is `width: 100%` and this tall. */
  export let height = '560px'
  /** Group markers into a `L.MarkerClusterGroup`. */
  export let clustered = true
  /** Site ids (or feature keys) drawn with a selection ring. */
  export let selectedSiteIds = []
  /** `false` locks panning/zooming — used by the read-only mini-maps. */
  export let interactive = true
  /** `[[lat, lon, weight], …]` from `GET /api/map/alarm-heatmap`. */
  export let heatPoints = null
  /** `meta.max_weight` from the same endpoint. Without it the layer is one blob. */
  export let heatMax = 1
  export let showHeat = false
  /** GeoJSON FeatureCollection drawn under the markers (isochrones). */
  export let overlayGeoJson = null
  /** Draw the isochrone rings dashed and show the "approximate" badge. */
  export let overlayApproximate = false
  /** GeoJSON LineString of a planned route. */
  export let routeGeometry = null
  /** `{ lat, lng }` of a single stand-alone pin (address picker, mini-map). */
  export let pin = null
  /** Let the user drag the pin; each drop fires `pinmove`. */
  export let pinDraggable = false
  /** Crosshair cursor + clicks on clusters/markers are forwarded as `mapclick`. */
  export let crosshair = false
  /** Fit the view to the features once, on the first non-empty render. */
  export let autoFit = true
  /** Bind popups to the markers. */
  export let popups = true
  export let center = DEFAULT_CENTER
  export let zoom = DEFAULT_ZOOM

  const dispatch = createEventDispatcher()
  const tr = (key, ...args) => get(t)(key, ...args)

  let mapEl
  let map = null
  let markerLayer = null      // MarkerClusterGroup | FeatureGroup
  let heatLayer = null
  let overlayLayer = null
  let routeLayer = null
  let pinMarker = null
  let pinMarkerDraggable = false
  let ready = false
  let fitted = false
  let bboxTimer = null
  let resizeObs = null
  let themeUnsub = null
  /** Cleared while re-styling after a theme flip so the view does not jump. */
  let refitRoute = true

  const markers = new Map()       // key → L.Marker
  const featureByKey = new Map()  // key → GeoJSON Feature

  // Reactive sync. The props are passed as arguments purely so Svelte tracks them —
  // each function reads the live prop values itself.
  $: syncFeatures(ready, features, selectedSiteIds, popups)
  $: syncHeat(ready, showHeat, heatPoints, heatMax)
  $: syncOverlay(ready, overlayGeoJson, overlayApproximate)
  $: syncRoute(ready, routeGeometry)
  $: syncPin(ready, pin, pinDraggable)
  $: syncCrosshair(ready, crosshair)

  // ── Icons ──────────────────────────────────────────────

  function makeMarkerIcon(status, feature, selected) {
    const el = document.createElement('span')
    el.className = `map-marker map-marker--${status}`
    if (selected) el.classList.add('map-marker--selected')

    const count = featureDeviceCount(feature)
    if (count > 1) {
      el.classList.add('map-marker--multi')
      const badge = document.createElement('span')
      badge.className = 'map-marker-count'
      // A number this component computed — never interpolated tenant data.
      badge.textContent = count > 999 ? '999+' : String(count)
      el.appendChild(badge)
    }

    return L.divIcon({
      className: 'map-marker-wrap',
      html: el,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -10],
    })
  }

  /**
   * Cluster badge coloured by the WORST status inside it (alarm > offline > online)
   * and labelled with the total number of devices those markers represent, so the
   * number means the same thing whether it sits on a cluster or on a single site.
   */
  function makeClusterIcon(cluster) {
    const children = typeof cluster.getAllChildMarkers === 'function'
      ? cluster.getAllChildMarkers()
      : []

    let worst = 'online'
    let total = 0
    for (const m of children) {
      total += Number.isFinite(m.__deviceCount) ? m.__deviceCount : 1
      if (statusRank(m.__status) > statusRank(worst)) worst = m.__status || 'offline'
    }
    if (total === 0) total = children.length

    const el = document.createElement('div')
    el.className = `map-cluster map-cluster--${worst}`
    const label = document.createElement('span')
    label.textContent = total > 999 ? '999+' : String(total)
    el.appendChild(label)

    const size = total < 10 ? 32 : total < 100 ? 38 : 44
    return L.divIcon({ className: 'map-cluster-wrap', html: el, iconSize: L.point(size, size) })
  }

  function makePinIcon() {
    const el = document.createElement('span')
    el.className = 'map-pin-marker'
    return L.divIcon({
      className: 'map-pin-wrap',
      html: el,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    })
  }

  // ── Popups (DOM only — see the security note at the top) ─

  function textRow(parent, className, text) {
    if (text === null || text === undefined || text === '') return null
    const el = document.createElement('div')
    el.className = className
    el.textContent = String(text)
    parent.appendChild(el)
    return el
  }

  function statusChip(parent, status, count) {
    const chip = document.createElement('span')
    chip.className = 'map-popup-chip'
    const dot = document.createElement('span')
    dot.className = `map-marker map-marker--${status} map-marker--inline`
    chip.appendChild(dot)
    const label = document.createElement('span')
    label.textContent = String(count)
    chip.appendChild(label)
    chip.setAttribute('aria-label', `${tr(`map.legend_${status}`)}: ${count}`)
    parent.appendChild(chip)
  }

  function deviceRow(parent, device) {
    const row = document.createElement('a')
    row.className = 'map-popup-device'
    if (device.mqtt_device_id) row.href = `#/device/${encodeURIComponent(device.mqtt_device_id)}`

    const dot = document.createElement('span')
    dot.className = `map-marker map-marker--${deviceStatus(device)} map-marker--inline`
    row.appendChild(dot)

    const name = document.createElement('span')
    name.className = 'map-popup-device-name'
    name.textContent = device.name || device.mqtt_device_id || '—'
    row.appendChild(name)

    const temp = document.createElement('span')
    temp.className = 'map-popup-device-temp'
    temp.textContent = device.air_temp != null && Number.isFinite(Number(device.air_temp))
      ? `${Number(device.air_temp).toFixed(1)} °C`
      : '—'
    row.appendChild(temp)

    parent.appendChild(row)
  }

  function buildPopup(key) {
    const wrap = document.createElement('div')
    wrap.className = 'map-popup'

    const feature = featureByKey.get(key)
    if (!feature) return wrap
    const p = feature.properties || {}
    const latLng = featureLatLng(feature)

    textRow(wrap, 'map-popup-name', p.site_name || p.name || p.mqtt_device_id || '—')

    const place = [p.city, p.region, p.country].filter((v) => typeof v === 'string' && v.trim() !== '')
    textRow(wrap, 'map-popup-loc', place.join(', '))
    if (p.address_line) textRow(wrap, 'map-popup-loc', p.address_line)

    const devices = Array.isArray(p.devices) ? p.devices : []
    const total = featureDeviceCount(feature)

    const counters = document.createElement('div')
    counters.className = 'map-popup-meta'
    if (p.site_id) {
      textRow(counters, 'map-popup-total', tr('map.device_count', total))
      const chips = document.createElement('div')
      chips.className = 'map-popup-chips'
      statusChip(chips, 'online', Number(p.online_count) || 0)
      statusChip(chips, 'offline', Number(p.offline_count) || 0)
      statusChip(chips, 'alarm', Number(p.alarm_count) || 0)
      counters.appendChild(chips)
    } else {
      const status = featureStatus(feature)
      const temp = p.air_temp != null && Number.isFinite(Number(p.air_temp))
        ? `${Number(p.air_temp).toFixed(1)} °C`
        : '—'
      textRow(counters, 'map-popup-total', `${temp} · ${tr(`map.legend_${status}`)}`)
    }
    wrap.appendChild(counters)

    if (devices.length > 0) {
      const list = document.createElement('div')
      list.className = 'map-popup-devices'
      for (const device of devices.slice(0, 8)) deviceRow(list, device)
      if (devices.length > 8) {
        textRow(list, 'map-popup-more', tr('map.and_more', devices.length - 8))
      }
      wrap.appendChild(list)
    }

    const actions = document.createElement('div')
    actions.className = 'map-popup-actions'

    if (!p.site_id && p.mqtt_device_id) {
      const open = document.createElement('a')
      open.href = `#/device/${encodeURIComponent(p.mqtt_device_id)}`
      open.textContent = tr('map.open_device')
      actions.appendChild(open)
    }

    if (latLng) {
      for (const link of routeLinks(latLng[0], latLng[1])) {
        const a = document.createElement('a')
        a.href = link.url
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = tr(link.labelKey)
        actions.appendChild(a)
      }
    }

    if (actions.childNodes.length > 0) wrap.appendChild(actions)
    return wrap
  }

  // ── Marker layer ───────────────────────────────────────

  function selectionSet() {
    const set = new Set()
    for (const id of selectedSiteIds || []) {
      if (id === null || id === undefined) continue
      const raw = String(id)
      set.add(raw)
      set.add(`site:${raw}`)
      set.add(`dev:${raw}`)
    }
    return set
  }

  function onMarkerClick(key, event) {
    const marker = markers.get(key)
    if (crosshair) {
      // While placing, a marker must not swallow the click — the popup opened by
      // Leaflet's own handler in this same event is closed before the next paint.
      if (marker) marker.closePopup()
      emitMapClick(event.latlng)
      return
    }
    const original = event && event.originalEvent
    const additive = !!(original && (original.ctrlKey || original.metaKey || original.shiftKey))
    // Multi-select is a picking gesture, not a "tell me about this point" one.
    if (additive && marker) marker.closePopup()
    dispatch('select', { feature: featureByKey.get(key) || null, additive })
  }

  function syncFeatures() {
    if (!ready || !map || !markerLayer) return

    const selected = selectionSet()
    const seen = new Set()
    const refreshed = []

    for (const feature of features || []) {
      const latLng = featureLatLng(feature)
      if (!latLng) continue
      const key = featureKey(feature)
      if (!key) continue

      seen.add(key)
      featureByKey.set(key, feature)

      const status = featureStatus(feature)
      const isSelected = selected.has(key)
      let marker = markers.get(key)

      if (!marker) {
        marker = L.marker(latLng, {
          icon: makeMarkerIcon(status, feature, isSelected),
          riseOnHover: true,
        })
        marker.__key = key
        marker.__status = status
        marker.__selected = isSelected
        marker.__lat = latLng[0]
        marker.__lon = latLng[1]
        marker.__deviceCount = featureDeviceCount(feature)
        if (popups) marker.bindPopup(() => buildPopup(key), { minWidth: 240, maxHeight: 320 })
        marker.on('click', (e) => onMarkerClick(key, e))
        markerLayer.addLayer(marker)
        markers.set(key, marker)
        continue
      }

      if (marker.__lat !== latLng[0] || marker.__lon !== latLng[1]) {
        // setLatLng alone does not re-bucket a marker inside a cluster.
        markerLayer.removeLayer(marker)
        marker.setLatLng(latLng)
        markerLayer.addLayer(marker)
        marker.__lat = latLng[0]
        marker.__lon = latLng[1]
      }

      const count = featureDeviceCount(feature)
      if (marker.__status !== status || marker.__selected !== isSelected || marker.__deviceCount !== count) {
        marker.__status = status
        marker.__selected = isSelected
        marker.__deviceCount = count
        marker.setIcon(makeMarkerIcon(status, feature, isSelected))
        refreshed.push(marker)
      }
    }

    for (const [key, marker] of markers) {
      if (seen.has(key)) continue
      // m.remove() is a no-op for a marker held by a rendered cluster.
      markerLayer.removeLayer(marker)
      markers.delete(key)
      featureByKey.delete(key)
    }

    // Without this a device going into alarm inside a collapsed cluster shows nothing.
    if (refreshed.length > 0 && typeof markerLayer.refreshClusters === 'function') {
      markerLayer.refreshClusters(refreshed)
    }

    if (autoFit && !fitted && markers.size > 0) fitToFeatures()
  }

  /** Fit the view to the current markers. Exposed for parents that reload data. */
  export function fitToFeatures() {
    if (!map || !markerLayer || markers.size === 0) return
    const bounds = typeof markerLayer.getBounds === 'function'
      ? markerLayer.getBounds()
      : L.latLngBounds([...markers.values()].map((m) => m.getLatLng()))
    if (!bounds || !bounds.isValid()) return
    map.fitBounds(bounds.pad(0.2), { maxZoom: 14 })
    fitted = true
  }

  /** Recompute the container size — call after the map becomes visible again. */
  export function invalidate() {
    if (map) map.invalidateSize()
  }

  /** Centre on a point without changing the zoom policy. */
  export function panTo(lat, lon, targetZoom = null) {
    if (!map || !isValidCoords(lat, lon)) return
    if (targetZoom != null) map.setView([lat, lon], targetZoom)
    else map.panTo([lat, lon])
  }

  // ── Heat / overlay / route / pin layers ────────────────

  function syncHeat() {
    if (!ready || !map) return
    if (heatLayer) {
      map.removeLayer(heatLayer)
      heatLayer = null
    }
    if (!showHeat || !Array.isArray(heatPoints) || heatPoints.length === 0) return
    // leaflet.heat registers itself on the global L; degrade rather than throw.
    if (typeof L.heatLayer !== 'function') return

    const points = heatPoints
      .filter((p) => Array.isArray(p) && isValidCoords(p[0], p[1]))
      .map((p) => [Number(p[0]), Number(p[1]), Number(p[2]) > 0 ? Number(p[2]) : 1])
    if (points.length === 0) return

    const max = Number(heatMax) > 0 ? Number(heatMax) : 1
    heatLayer = L.heatLayer(points, { radius: 24, blur: 18, max, minOpacity: 0.25 })
    heatLayer.addTo(map)
  }

  function syncOverlay() {
    if (!ready || !map) return
    if (overlayLayer) {
      map.removeLayer(overlayLayer)
      overlayLayer = null
    }
    if (!overlayGeoJson) return

    const stroke = cssVar('--accent-cyan', '#22d3ee')
    overlayLayer = L.geoJSON(overlayGeoJson, {
      // No onEachFeature popup: the properties come from an upstream provider and
      // building one here would mean interpolating text we do not control.
      style: (feature) => {
        const approximate = overlayApproximate ||
          !!(feature && feature.properties && feature.properties.approximate)
        return {
          color: stroke,
          weight: 1.5,
          opacity: 0.9,
          fillColor: stroke,
          fillOpacity: 0.1,
          dashArray: approximate ? '5 5' : null,
        }
      },
    })
    overlayLayer.addTo(map)
    if (typeof overlayLayer.bringToBack === 'function') overlayLayer.bringToBack()
  }

  function syncRoute() {
    if (!ready || !map) return
    if (routeLayer) {
      map.removeLayer(routeLayer)
      routeLayer = null
    }
    if (!routeGeometry) return

    routeLayer = L.geoJSON(routeGeometry, {
      style: { color: cssVar('--accent-blue', '#4a9eff'), weight: 4, opacity: 0.85 },
    })
    routeLayer.addTo(map)
    if (!refitRoute) return
    const bounds = routeLayer.getBounds()
    if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.15))
  }

  function pinLatLng() {
    if (!pin) return null
    const lat = pin.lat !== undefined ? pin.lat : pin.latitude
    const lng = pin.lng !== undefined ? pin.lng : pin.longitude
    return isValidCoords(lat, lng) ? [Number(lat), Number(lng)] : null
  }

  function syncPin() {
    if (!ready || !map) return
    const latLng = pinLatLng()

    if (!latLng) {
      if (pinMarker) {
        map.removeLayer(pinMarker)
        pinMarker = null
      }
      return
    }

    // Leaflet only attaches Marker.Drag when the marker was created draggable,
    // so a change of `pinDraggable` means a fresh marker.
    if (pinMarker && pinMarkerDraggable !== !!pinDraggable) {
      map.removeLayer(pinMarker)
      pinMarker = null
    }

    if (!pinMarker) {
      pinMarkerDraggable = !!pinDraggable
      pinMarker = L.marker(latLng, {
        icon: makePinIcon(),
        draggable: pinMarkerDraggable,
        autoPan: true,
        keyboard: true,
        zIndexOffset: 1000,
      })
      pinMarker.on('dragend', () => {
        const ll = pinMarker.getLatLng().wrap()
        dispatch('pinmove', {
          lat: roundCoord(clampLat(ll.lat)),
          lng: roundCoord(ll.lng),
        })
      })
      pinMarker.addTo(map)
    } else {
      pinMarker.setLatLng(latLng)
    }
  }

  function syncCrosshair() {
    if (!ready || !markerLayer) return
    // A cluster swallows map clicks; disabling zoom-to-bounds lets the forwarder
    // below turn a click on a cluster into a placement instead.
    if (markerLayer.options && 'zoomToBoundsOnClick' in markerLayer.options) {
      markerLayer.options.zoomToBoundsOnClick = !crosshair
    }
  }

  // ── Map events ─────────────────────────────────────────

  function emitMapClick(latlng) {
    if (!latlng) return
    const ll = typeof latlng.wrap === 'function' ? latlng.wrap() : latlng
    dispatch('mapclick', {
      lat: roundCoord(clampLat(ll.lat)),
      lng: roundCoord(ll.lng),
    })
  }

  function emitBbox() {
    clearTimeout(bboxTimer)
    bboxTimer = setTimeout(() => {
      if (!map) return
      const bbox = boundsToBbox(map.getBounds())
      if (bbox) dispatch('bboxchange', bbox)
    }, 400)
  }

  function restyleVectors() {
    syncOverlay()
    refitRoute = false
    syncRoute()
    refitRoute = true
  }

  onMount(() => {
    map = L.map(mapEl, {
      zoomControl: interactive,
      attributionControl: true,
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      touchZoom: interactive,
      tap: interactive,
    })

    L.tileLayer(TILE_URL, {
      maxZoom: TILE_MAX_ZOOM,
      attribution: TILE_ATTRIBUTION,
    }).addTo(map)

    const start = Array.isArray(center) && isValidCoords(center[0], center[1])
      ? center
      : DEFAULT_CENTER
    map.setView(start, Number.isFinite(Number(zoom)) ? Number(zoom) : DEFAULT_ZOOM)

    markerLayer = clustered && typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup({
          iconCreateFunction: makeClusterIcon,
          showCoverageOnHover: false,
          maxClusterRadius: 56,
          spiderfyOnMaxZoom: true,
          chunkedLoading: true,
        })
      : L.featureGroup()
    map.addLayer(markerLayer)

    if (typeof markerLayer.on === 'function') {
      markerLayer.on('clusterclick', (e) => {
        if (crosshair) emitMapClick(e.latlng)
      })
    }

    map.on('click', (e) => emitMapClick(e.latlng))
    map.on('moveend', emitBbox)

    // A map mounted inside a hidden tab renders grey until its size is recomputed.
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => map && map.invalidateSize())
      resizeObs.observe(mapEl)
    }
    setTimeout(() => map && map.invalidateSize(), 0)

    // Vector colours are resolved CSS tokens, so they need re-reading on a theme flip.
    themeUnsub = effectiveTheme.subscribe(() => {
      if (ready) restyleVectors()
    })

    ready = true
    syncFeatures()
    syncHeat()
    syncOverlay()
    syncRoute()
    syncPin()
    syncCrosshair()
  })

  onDestroy(() => {
    ready = false
    clearTimeout(bboxTimer)
    if (themeUnsub) themeUnsub()
    if (resizeObs) resizeObs.disconnect()

    if (markerLayer) {
      markerLayer.clearLayers()
      if (map) map.removeLayer(markerLayer)
      markerLayer = null
    }
    markers.clear()
    featureByKey.clear()

    for (const layer of [heatLayer, overlayLayer, routeLayer, pinMarker]) {
      if (layer && map) map.removeLayer(layer)
    }
    heatLayer = overlayLayer = routeLayer = pinMarker = null

    if (map) {
      map.off()
      map.remove()
      map = null
    }
  })
</script>

<div class="map-canvas">
  <div
    class="map-canvas-inner"
    class:crosshair
    style="height: {height};"
    bind:this={mapEl}
  ></div>

  <div class="map-canvas-overlay">
    {#if overlayApproximate && overlayGeoJson}
      <span class="approx-badge">{$t('map.isochrone_approximate')}</span>
    {/if}
    <slot name="overlay" />
  </div>
</div>

<style>
  .map-canvas {
    position: relative;
  }

  .map-canvas-inner {
    width: 100%;
    min-height: 180px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-secondary);
    z-index: 0;
  }

  .map-canvas-inner.crosshair :global(.leaflet-grab),
  .map-canvas-inner.crosshair :global(.leaflet-interactive) {
    cursor: crosshair !important;
  }

  .map-canvas-overlay {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 900;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    pointer-events: none;
  }

  .map-canvas-overlay > :global(*) {
    pointer-events: auto;
  }

  .approx-badge {
    padding: 3px var(--space-2);
    background: var(--bg-secondary);
    border: 1px dashed var(--accent-yellow);
    border-radius: var(--radius-sm);
    color: var(--accent-yellow);
    font-size: var(--text-xs);
    box-shadow: var(--shadow-sm);
  }

  /* ══════════════════════════════════════════════════════
     Leaflet chrome, themed to the app.

     These rules are deliberately un-anchored `:global()`: Leaflet builds its DOM
     outside the component tree, and the same skin has to reach every map surface
     — fleet map, device mini-map, address picker, public status page — not just
     the one page that happens to wrap its map in `.map-page`.
     ══════════════════════════════════════════════════════ */

  /* ── Status markers (divIcon content) ── */
  :global(.map-marker) {
    display: block;
    position: relative;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }

  :global(.map-marker--online) {
    background: var(--status-online);
  }

  :global(.map-marker--offline) {
    background: var(--status-offline);
  }

  :global(.map-marker--alarm) {
    background: var(--status-alarm);
    animation: pulse 1.2s ease-in-out infinite;
  }

  :global(.map-marker--selected) {
    box-shadow: 0 0 0 3px var(--accent-blue), 0 1px 4px rgba(0, 0, 0, 0.5);
  }

  :global(.map-marker--inline) {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-width: 1px;
    box-shadow: none;
    flex-shrink: 0;
  }

  :global(.map-marker-count) {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    padding: 0 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 13px;
    white-space: nowrap;
  }

  /* ── Cluster badge ── */
  :global(.map-cluster) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    color: #fff;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  :global(.map-cluster--online) {
    background: var(--status-online);
  }

  :global(.map-cluster--offline) {
    background: var(--status-offline);
    color: var(--text-primary);
  }

  :global(.map-cluster--alarm) {
    background: var(--status-alarm);
    animation: pulse 1.4s ease-in-out infinite;
  }

  /* ── Stand-alone pin (address picker, mini-map) ── */
  :global(.map-pin-marker) {
    display: block;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid var(--accent-blue);
    background: var(--bg-secondary);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  }

  :global(.map-pin-wrap) {
    cursor: grab;
  }

  /* ── Popups ── */
  :global(.leaflet-popup-content-wrapper),
  :global(.leaflet-popup-tip) {
    background: var(--bg-secondary);
    color: var(--text-primary);
    box-shadow: var(--shadow-lg);
  }

  :global(.leaflet-popup-content) {
    margin: var(--space-3);
    font-family: var(--font-sans);
  }

  :global(.leaflet-container a.leaflet-popup-close-button) {
    color: var(--text-secondary);
  }

  :global(.leaflet-bar a) {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-color: var(--border-default);
  }

  :global(.leaflet-bar a:hover) {
    background: var(--bg-tertiary);
  }

  :global(.leaflet-container .leaflet-control-attribution) {
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 10px;
  }

  :global(.leaflet-container .leaflet-control-attribution a) {
    color: var(--accent-blue);
  }

  :global(.map-popup-name) {
    font-weight: 600;
    font-size: var(--text-sm);
    margin-bottom: 2px;
    color: var(--text-primary);
  }

  :global(.map-popup-meta) {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }

  :global(.map-popup-total) {
    margin-top: 2px;
  }

  :global(.map-popup-chips) {
    display: flex;
    gap: var(--space-3);
    margin-top: 4px;
  }

  :global(.map-popup-chip) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  :global(.map-popup-loc) {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    margin-top: 2px;
  }

  :global(.map-popup-devices) {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-default);
    max-height: 150px;
    overflow-y: auto;
  }

  :global(.map-popup-device) {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px 4px;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  :global(.map-popup-device:hover) {
    background: var(--bg-tertiary);
  }

  :global(.map-popup-device-name) {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.map-popup-device-temp) {
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  :global(.map-popup-more) {
    color: var(--text-muted);
    font-size: var(--text-xs);
    padding: 2px 4px;
  }

  :global(.map-popup-actions) {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  :global(.map-popup-actions a),
  :global(.map-popup-actions button) {
    display: block;
    width: 100%;
    padding: 5px 8px;
    background: var(--bg-tertiary);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-size: var(--text-xs);
    font-family: var(--font-sans);
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
  }

  :global(.map-popup-actions a:hover),
  :global(.map-popup-actions button:hover) {
    background: var(--border-default);
  }

  /* Dim the OSM raster tiles so they sit in the dark palette. */
  :global([data-theme='dark'] .leaflet-tile) {
    filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.4);
  }
</style>
