<script>
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import L from 'leaflet'
  import 'leaflet/dist/leaflet.css'
  import { getDevices, updateDevice } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { devices, canWrite } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Icon from '../components/ui/Icon.svelte'

  let mapEl
  let map = null
  let error = null
  let loaded = false
  let deviceList = []
  let placing = null   // device currently being placed by map click
  let fitted = false
  let interval

  const markers = new Map()      // mqtt_device_id → L.Marker
  const wsUnsubs = []
  const subscribedIds = new Set()

  const tr = (key) => get(t)(key)

  $: withoutCoords = deviceList.filter(
    d => (d.latitude == null || d.longitude == null) && d.status === 'active'
  )
  $: hasMarkers = deviceList.some(d => d.latitude != null && d.longitude != null)

  function statusOf(d) {
    if (d.alarm_active) return 'alarm'
    return d.online ? 'online' : 'offline'
  }

  function makeIcon(status) {
    return L.divIcon({
      className: 'map-marker-wrap',
      html: `<span class="map-marker map-marker--${status}"></span>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -10],
    })
  }

  // Popup content is built with DOM APIs so device names are never
  // interpreted as HTML.
  function buildPopup(mqttId) {
    const d = deviceList.find(x => x.mqtt_device_id === mqttId)
    const wrap = document.createElement('div')
    wrap.className = 'map-popup'
    if (!d) return wrap

    const name = document.createElement('div')
    name.className = 'map-popup-name'
    name.textContent = d.name || d.mqtt_device_id
    wrap.appendChild(name)

    const meta = document.createElement('div')
    meta.className = 'map-popup-meta'
    const temp = d.air_temp != null ? `${Number(d.air_temp).toFixed(1)} °C` : '—'
    const statusLabel = tr(`map.legend_${statusOf(d)}`)
    meta.textContent = `${temp} · ${statusLabel}`
    wrap.appendChild(meta)

    if (d.location) {
      const loc = document.createElement('div')
      loc.className = 'map-popup-loc'
      loc.textContent = d.location
      wrap.appendChild(loc)
    }

    const actions = document.createElement('div')
    actions.className = 'map-popup-actions'

    const open = document.createElement('a')
    open.href = `#/device/${d.mqtt_device_id}`
    open.textContent = tr('map.open_device')
    actions.appendChild(open)

    const google = document.createElement('a')
    google.href = `https://www.google.com/maps/dir/?api=1&destination=${d.latitude},${d.longitude}`
    google.target = '_blank'
    google.rel = 'noopener'
    google.textContent = tr('map.route_google')
    actions.appendChild(google)

    const apple = document.createElement('a')
    apple.href = `https://maps.apple.com/?daddr=${d.latitude},${d.longitude}&dirflg=d`
    apple.target = '_blank'
    apple.rel = 'noopener'
    apple.textContent = tr('map.route_apple')
    actions.appendChild(apple)

    if (get(canWrite)) {
      const move = document.createElement('button')
      move.type = 'button'
      move.textContent = tr('map.move')
      move.addEventListener('click', () => startPlacing(d))
      actions.appendChild(move)

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = tr('map.remove_location')
      remove.addEventListener('click', () => removeLocation(d))
      actions.appendChild(remove)
    }

    wrap.appendChild(actions)
    return wrap
  }

  function renderMarkers() {
    if (!map) return
    const seen = new Set()
    for (const d of deviceList) {
      if (d.latitude == null || d.longitude == null) continue
      seen.add(d.mqtt_device_id)
      const status = statusOf(d)
      let m = markers.get(d.mqtt_device_id)
      if (!m) {
        m = L.marker([d.latitude, d.longitude], { icon: makeIcon(status) })
        m.bindPopup(() => buildPopup(d.mqtt_device_id), { minWidth: 220 })
        m.addTo(map)
        markers.set(d.mqtt_device_id, m)
      } else {
        m.setLatLng([d.latitude, d.longitude])
        m.setIcon(makeIcon(status))
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        m.remove()
        markers.delete(id)
      }
    }
    if (!fitted && markers.size > 0) {
      const bounds = L.latLngBounds([...markers.values()].map(m => m.getLatLng()))
      map.fitBounds(bounds.pad(0.2), { maxZoom: 14 })
      fitted = true
    }
  }

  async function load() {
    try {
      const data = await getDevices()
      deviceList = data
      devices.set(data)
      error = null
      loaded = true
      renderMarkers()
      syncWsSubscriptions(data)
    } catch (e) {
      error = e.message
    }
  }

  function syncWsSubscriptions(deviceListNow) {
    const newIds = new Set(deviceListNow.map(d => d.mqtt_device_id))
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

  function patchLocal(mqttId, patch) {
    const d = deviceList.find(x => x.mqtt_device_id === mqttId)
    if (!d) return
    Object.assign(d, patch)
    deviceList = deviceList
    renderMarkers()
  }

  function setupWsListeners() {
    wsUnsubs.push(on('device_online', (msg) => patchLocal(msg.device_id, { online: true })))
    wsUnsubs.push(on('device_offline', (msg) => patchLocal(msg.device_id, { online: false, last_seen: msg.last_seen })))
    wsUnsubs.push(on('alarm', (msg) => patchLocal(msg.device_id, { alarm_active: !!msg.active })))
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

  function startPlacing(d) {
    placing = d
    if (map) map.closePopup()
  }

  function cancelPlacing() {
    placing = null
  }

  async function onMapClick(e) {
    if (!placing) return
    const ll = e.latlng.wrap()
    const latitude = Math.round(Math.max(-90, Math.min(90, ll.lat)) * 1e6) / 1e6
    const longitude = Math.round(ll.lng * 1e6) / 1e6
    const target = placing
    placing = null
    try {
      await updateDevice(target.id, { latitude, longitude })
      patchLocal(target.mqtt_device_id, { latitude, longitude })
      toast.success(tr('map.location_saved'))
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function removeLocation(d) {
    if (map) map.closePopup()
    try {
      await updateDevice(d.id, { latitude: null, longitude: null })
      patchLocal(d.mqtt_device_id, { latitude: null, longitude: null })
      toast.success(tr('map.location_removed'))
    } catch (err) {
      toast.error(err.message)
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape' && placing) cancelPlacing()
  }

  onMount(() => {
    map = L.map(mapEl)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map)
    map.setView([49.0, 31.4], 6)
    map.on('click', onMapClick)
    setTimeout(() => map && map.invalidateSize(), 0)

    setupWsListeners()
    load()
    interval = setInterval(load, 30000)
  })

  onDestroy(() => {
    clearInterval(interval)
    for (const id of subscribedIds) unsubscribe(id)
    subscribedIds.clear()
    for (const fn of wsUnsubs) fn()
    if (map) {
      map.remove()
      map = null
    }
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="map-page">
  <PageHeader title={$t('pages.map')} subtitle={$t('pages.map_sub')} />

  {#if error}
    <div class="map-error">
      <Icon name="x-circle" size={16} />
      <span>{$t('map.load_failed')}: {error}</span>
    </div>
  {/if}

  {#if placing}
    <div class="placing-banner">
      <Icon name="map-pin" size={16} />
      <span>{$t('map.placing_hint').replace('{0}', placing.name || placing.mqtt_device_id)}</span>
      <button class="placing-cancel" on:click={cancelPlacing}>{$t('common.cancel')}</button>
    </div>
  {/if}

  <div class="map-container" class:placing bind:this={mapEl}></div>

  <div class="map-footer">
    <div class="map-legend">
      <span class="legend-item"><span class="map-marker map-marker--online"></span>{$t('map.legend_online')}</span>
      <span class="legend-item"><span class="map-marker map-marker--offline"></span>{$t('map.legend_offline')}</span>
      <span class="legend-item"><span class="map-marker map-marker--alarm"></span>{$t('map.legend_alarm')}</span>
    </div>
    {#if loaded && !hasMarkers && !error}
      <p class="no-coords-hint">{$t('map.no_coords_hint')}</p>
    {/if}
  </div>

  {#if $canWrite && withoutCoords.length > 0}
    <div class="no-coords-panel">
      <div class="no-coords-title">
        {$t('map.without_coords').replace('{0}', String(withoutCoords.length))}
      </div>
      <div class="no-coords-list">
        {#each withoutCoords as d (d.id)}
          <div class="no-coords-item">
            <span class="no-coords-name">{d.name || d.mqtt_device_id}</span>
            <button class="place-btn" on:click={() => startPlacing(d)}>
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
  .map-page {
    animation: fade-in 0.3s ease-out;
  }

  .map-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--status-alarm);
    border-radius: var(--radius-md);
    color: var(--status-alarm);
    font-size: var(--text-sm);
  }

  .placing-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-md);
    color: var(--accent-blue);
    font-size: var(--text-sm);
  }

  .placing-cancel {
    margin-left: auto;
    padding: 2px 10px;
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .placing-cancel:hover {
    color: var(--text-primary);
    border-color: var(--border-accent);
  }

  .map-container {
    height: calc(100vh - 260px);
    min-height: 360px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-secondary);
    z-index: 0;
  }

  .map-container.placing :global(.leaflet-grab),
  .map-container.placing :global(.leaflet-interactive) {
    cursor: crosshair !important;
  }

  .map-footer {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-top: var(--space-3);
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

  .no-coords-hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .no-coords-panel {
    margin-top: var(--space-4);
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
    font-size: var(--text-xs);
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  .place-btn:hover {
    border-color: var(--accent-blue);
  }

  /* ── Markers (Leaflet divIcon HTML — needs :global) ── */
  .map-page :global(.map-marker),
  .map-page .map-marker {
    display: block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }

  .map-page :global(.map-marker--online),
  .map-page .map-marker--online {
    background: var(--status-online);
  }

  .map-page :global(.map-marker--offline),
  .map-page .map-marker--offline {
    background: var(--status-offline);
  }

  .map-page :global(.map-marker--alarm),
  .map-page .map-marker--alarm {
    background: var(--status-alarm);
    animation: pulse 1.2s ease-in-out infinite;
  }

  /* ── Leaflet chrome themed to the app ── */
  .map-page :global(.leaflet-popup-content-wrapper),
  .map-page :global(.leaflet-popup-tip) {
    background: var(--bg-secondary);
    color: var(--text-primary);
    box-shadow: var(--shadow-lg);
  }

  .map-page :global(.leaflet-popup-content) {
    margin: var(--space-3);
    font-family: var(--font-sans);
  }

  .map-page :global(.leaflet-container a.leaflet-popup-close-button) {
    color: var(--text-secondary);
  }

  .map-page :global(.leaflet-bar a) {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-color: var(--border-default);
  }

  .map-page :global(.leaflet-bar a:hover) {
    background: var(--bg-tertiary);
  }

  .map-page :global(.map-popup-name) {
    font-weight: 600;
    font-size: var(--text-sm);
    margin-bottom: 2px;
  }

  .map-page :global(.map-popup-meta) {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }

  .map-page :global(.map-popup-loc) {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    margin-top: 2px;
  }

  .map-page :global(.map-popup-actions) {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .map-page :global(.map-popup-actions a),
  .map-page :global(.map-popup-actions button) {
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

  .map-page :global(.map-popup-actions a:hover),
  .map-page :global(.map-popup-actions button:hover) {
    background: var(--border-default);
  }

  /* Dim OSM tiles in dark theme */
  :global([data-theme='dark']) .map-page :global(.leaflet-tile) {
    filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.4);
  }

  @media (max-width: 768px) {
    .map-container {
      height: calc(100vh - 300px);
      min-height: 280px;
    }
  }
</style>
