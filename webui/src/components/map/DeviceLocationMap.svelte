<script>
  /**
   * Single-point mini-map: the device `location` tab, a site card, an alarm detail.
   *
   * Import it lazily — a static import pulls Leaflet (~150 KB) into the entry chunk
   * for every user on every page:
   *
   *   {#await import('../components/map/DeviceLocationMap.svelte') then { default: DeviceLocationMap }}
   *     <svelte:component this={DeviceLocationMap} {latitude} {longitude} />
   *   {/await}
   */
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'
  import MapCanvas from './MapCanvas.svelte'
  import {
    POINT_ZOOM, formatAddress, formatCoords, isValidCoords, precisionKey, routeLinks,
  } from '../../lib/geo.js'

  export let latitude = null
  export let longitude = null
  /** Point name shown above the address — device or site name. */
  export let label = ''
  export let height = '280px'
  /** 'online' | 'offline' | 'alarm' — drives the marker colour. */
  export let status = 'offline'
  /** Site-shaped object: `{ address_line, postal_code, city, region, country }`. */
  export let address = null
  /** `sites.geo_precision`, rendered as a small badge when present. */
  export let precision = null
  /** 'device' | 'site' — where the coordinates came from (see geo.effectiveCoords). */
  export let source = null
  export let interactive = true
  export let showRoutes = true

  let canvas

  $: hasCoords = isValidCoords(latitude, longitude)
  $: coordText = formatCoords(latitude, longitude)
  $: addressText = formatAddress(address)
  $: links = showRoutes ? routeLinks(latitude, longitude) : []

  // The point can change under us (device reassigned to another site, coordinates
  // edited in the same view) — recentre instead of remounting the map.
  $: if (canvas && hasCoords) canvas.panTo(latitude, longitude, POINT_ZOOM)

  $: features = hasCoords
    ? [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
        properties: {
          device_id: 'self',
          name: label,
          online: status === 'online',
          alarm_active: status === 'alarm',
        },
      }]
    : []
</script>

<div class="location-map">
  {#if hasCoords}
    <MapCanvas
      bind:this={canvas}
      {features}
      {height}
      {interactive}
      clustered={false}
      popups={false}
      autoFit={false}
      center={[Number(latitude), Number(longitude)]}
      zoom={POINT_ZOOM}
    />
  {:else}
    <div class="no-coords" style="height: {height};">
      <Icon name="map-pin" size={22} />
      <p>{$t('map.no_coordinates')}</p>
    </div>
  {/if}

  <div class="details">
    {#if label}
      <div class="point-name">{label}</div>
    {/if}

    {#if addressText}
      <div class="address">{addressText}</div>
    {/if}

    {#if coordText}
      <div class="coords">
        <span class="coords-value">{coordText}</span>
        {#if precision}
          <span class="badge">{$t(precisionKey(precision))}</span>
        {/if}
        {#if source === 'site'}
          <span class="source-note">{$t('map.coords_from_site')}</span>
        {:else if source === 'device'}
          <span class="source-note">{$t('map.coords_from_device')}</span>
        {/if}
      </div>
    {/if}

    {#if links.length > 0}
      <div class="routes">
        <span class="routes-label">{$t('map.route_to')}</span>
        {#each links as link (link.key)}
          <a class="route-link" href={link.url} target="_blank" rel="noopener">
            <Icon name="map-pin" size={13} />
            {$t(link.labelKey)}
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .location-map {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .no-coords {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 140px;
    border: 1px dashed var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
    color: var(--text-muted);
  }

  .no-coords p {
    margin: 0;
    font-size: var(--text-sm);
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .point-name {
    color: var(--text-primary);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .address {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .coords {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .coords-value {
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .badge {
    padding: 1px var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .source-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .routes {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .routes-label {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .route-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-size: var(--text-xs);
    text-decoration: none;
    transition: border-color var(--transition-fast);
  }

  .route-link:hover {
    border-color: var(--accent-blue);
  }
</style>
