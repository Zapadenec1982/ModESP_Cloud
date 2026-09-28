<script>
  /**
   * Trade points (торгові точки).
   *
   * The admin surface for `sites`: without it a site can only come into
   * existence through migration 021's backfill or the CSV import, an address can
   * never be corrected, the geocode sweep has no trigger and no progress
   * readout, and — the part that matters most — the public status link of
   * Part 2 §7.7 can never be minted, which leaves PublicSite.svelte unreachable.
   *
   * The table is a directory: name, address, counters. Everything about one
   * site — its equipment, open alarms and orders, contacts — lives on the site
   * page (`#/sites/:id`), which the name links to; the counters link to the
   * dashboard and the alarms page narrowed to the site. Coordinates and their
   * provenance moved from the table into the editor.
   *
   * Read is open to every authenticated role: `GET /api/sites` narrows by RBAC
   * (a technician sees only sites where they can see a device, or hold a
   * user_sites grant) rather than by role. Every mutation below is admin-only
   * server-side, so the controls that write are behind `$isAdmin`.
   *
   * Leaflet is never imported here — AddressPicker is loaded lazily inside the
   * editor modal, so opening the list costs nothing.
   */
  import { onMount } from 'svelte'
  import { querystring } from 'svelte-spa-router'
  import {
    getSites, createSite, updateSite, deleteSite, geocodeSite,
    getGeocodeStatus, geocodePendingSites,
  } from '../lib/api.js'
  import { isAdmin, canWrite } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { emptyAddress, formatCoords, precisionKey, geoSourceKey } from '../lib/geo.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import SearchInput from '../components/ui/SearchInput.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import SiteReportModal from '../components/SiteReportModal.svelte'
  import SitePublicLinks from '../components/SitePublicLinks.svelte'

  const SEARCH_DEBOUNCE_MS = 300

  let sites = []
  let loading = true
  let search = ''
  let searchTimer = null

  // Geocode progress (admin only — GET /api/sites/geocode-status is maybeAuthorize('admin')).
  let geoStatus = null      // { pending, geocoded, failed }
  let geoMeta = {}          // { geocoder_enabled, bulk_enabled, sweep_in_progress }
  let sweeping = false
  let geoExpanded = false   // the compact line grows into the actions on demand

  // Editor modal
  let showEditor = false
  let editing = null        // the site row being edited, or null for "create"
  let form = blankForm()
  let address = emptyAddress()
  let saving = false

  // Delete confirmation
  let deleting = null
  let deleteBusy = false

  // Report dialog and public links panel (both shared with the site page)
  let reportSite = null
  let linksSite = null

  function blankForm() {
    return { name: '', notes: '', haccp_excursion_min: '', contact_name: '', contact_phone: '', contact_email: '' }
  }

  // ── Loading ────────────────────────────────────────────

  async function load() {
    loading = true
    try {
      sites = await getSites(search.trim() ? { search: search.trim() } : {})
    } catch (e) {
      toast.error(e.message)
      sites = []
    } finally {
      loading = false
    }
  }

  async function loadGeoStatus() {
    if (!$isAdmin) return
    try {
      const res = await getGeocodeStatus()
      geoStatus = res.data
      geoMeta = res.meta || {}
    } catch {
      // A missing progress panel must never take the list down with it.
      geoStatus = null
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, SEARCH_DEBOUNCE_MS)
  }

  // Compared against the previous value rather than a bare `$: search, …`, which
  // would fire once at init and race the onMount() load.
  let lastSearch = ''
  $: if (search !== lastSearch) { lastSearch = search; onSearchInput() }

  // ── Editor ─────────────────────────────────────────────

  function openCreate() {
    editing = null
    form = blankForm()
    address = emptyAddress()
    showEditor = true
  }

  function openEdit(site) {
    editing = site
    form = {
      name: site.name || '',
      notes: site.notes || '',
      haccp_excursion_min: site.haccp_excursion_min ?? '',
      contact_name: site.contact_name || '',
      contact_phone: site.contact_phone || '',
      contact_email: site.contact_email || '',
    }
    address = {
      country_code: site.country_code || '',
      country:      site.country || '',
      region:       site.region || '',
      city:         site.city || '',
      address_line: site.address_line || '',
      postal_code:  site.postal_code || '',
      latitude:     site.latitude ?? null,
      longitude:    site.longitude ?? null,
    }
    showEditor = true
  }

  function closeEditor() {
    showEditor = false
    editing = null
  }

  function onEditorKey(e) {
    if (e.key === 'Escape') closeEditor()
  }

  function onEditorBackdrop(e) {
    if (e.target === e.currentTarget) closeEditor()
  }

  /** '' → null: the columns are nullable and an empty string is not an address. */
  function orNull(value, max) {
    const s = typeof value === 'string' ? value.trim() : value
    if (s === '' || s === undefined) return null
    return typeof s === 'string' && max ? s.slice(0, max) : s
  }

  function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  $: canSave = form.name.trim().length > 0 && !saving

  async function save() {
    if (!canSave) return

    const lat = numOrNull(address.latitude)
    const lon = numOrNull(address.longitude)
    // The backend accepts one without the other, but a site with half a pin is
    // undrawable and unroutable — reject it here rather than store it.
    if ((lat === null) !== (lon === null)) {
      toast.error($t('site.coords_incomplete'))
      return
    }

    const payload = {
      name:         form.name.trim().slice(0, 256),
      country_code: orNull(address.country_code, 2),
      country:      orNull(address.country, 64),
      region:       orNull(address.region, 128),
      city:         orNull(address.city, 128),
      address_line: orNull(address.address_line, 256),
      postal_code:  orNull(address.postal_code, 16),
      latitude:     lat,
      longitude:    lon,
      notes:        orNull(form.notes, 4000),
      haccp_excursion_min: form.haccp_excursion_min === '' || form.haccp_excursion_min === null ? null : Number(form.haccp_excursion_min),
      contact_name:  orNull(form.contact_name, 120),
      contact_phone: orNull(form.contact_phone, 40),
      contact_email: orNull(form.contact_email, 160),
    }

    saving = true
    try {
      if (editing) {
        await updateSite(editing.id, payload)
        toast.success($t('site.updated'))
      } else {
        await createSite(payload)
        toast.success($t('site.created'))
      }
      closeEditor()
      await Promise.all([load(), loadGeoStatus()])
    } catch (e) {
      toast.error(e.message || $t('site.save_error'))
    } finally {
      saving = false
    }
  }

  // ── Geocoding ──────────────────────────────────────────

  async function regeocode(site) {
    try {
      const res = await geocodeSite(site.id)
      // meta.geocoder is the only thing that tells "off" from "no match" from
      // "done" — without it a no-op looks identical to a success.
      const outcome = (res.meta && res.meta.geocoder) || 'ok'
      if (outcome === 'disabled') toast.warning($t('site.geocode_disabled'))
      else if (outcome === 'failed') toast.error($t('site.geocode_failed'))
      else toast.success($t('site.geocode_ok'))
      await Promise.all([load(), loadGeoStatus()])
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function runSweep(retryFailed = false) {
    sweeping = true
    try {
      const res = await geocodePendingSites({ retryFailed })
      if (res.reason === 'bulk_disabled') toast.warning($t('site.geocode_bulk_disabled'))
      else if (res.reason === 'sweep_in_progress') toast.warning($t('site.geocode_sweep_running'))
      else toast.success($t('site.geocode_queued', res.queued ?? 0))
      await loadGeoStatus()
    } catch (e) {
      toast.error(e.message)
    } finally {
      sweeping = false
    }
  }

  // ── Delete ─────────────────────────────────────────────

  function askDelete(site) {
    deleting = site
  }

  async function confirmDelete(force) {
    if (!deleting) return
    deleteBusy = true
    try {
      await deleteSite(deleting.id, { force })
      toast.success($t('site.deleted'))
      deleting = null
      await Promise.all([load(), loadGeoStatus()])
    } catch (e) {
      // 409 site_has_devices is not an error the user needs to read as a failure —
      // it is the prompt for the "detach and delete" button, which stays visible.
      if (e.status === 409) toast.warning($t('site.has_devices', e.body?.device_count ?? '?'))
      else toast.error(e.message)
    } finally {
      deleteBusy = false
    }
  }

  // ── Rendering helpers ──────────────────────────────────

  function addressLine(site) {
    return [site.address_line, site.city, site.region, site.country]
      .filter(v => typeof v === 'string' && v.trim() !== '')
      .join(', ')
  }

  /** The one-line hint behind the small flag next to an address. */
  function geoFlagTitle(site) {
    if (site.geo_source === 'failed') return $t('site.geo_error_hint', site.geo_error || $t('site.geocode_failed'))
    if (site.geo_source === 'manual') return $t('site.geo_source_manual')
    return ''
  }

  onMount(async () => {
    await Promise.all([load(), loadGeoStatus()])
    // `#/sites?edit=<id>` — the site page's "edit" link lands straight in the editor.
    const wanted = new URLSearchParams($querystring || '').get('edit')
    if (wanted && $isAdmin) {
      const site = sites.find(s => s.id === wanted)
      if (site) openEdit(site)
    }
  })
</script>

<div class="sites-page">
  <PageHeader title={$t('pages.sites')} subtitle={$t('pages.sites_sub')}>
    {#if $isAdmin}
      <button class="hdr-btn" on:click={() => (window.location.hash = '#/pending?import=1')}>
        <Icon name="upload" size={14} />
        {$t('pending.import_csv')}
      </button>
      <button class="hdr-btn" on:click={openCreate}>
        <Icon name="plus" size={14} />
        {$t('site.new_site')}
      </button>
    {/if}
  </PageHeader>

  <div class="toolbar">
    <SearchInput bind:value={search} placeholder={$t('users.search_sites')} />
  </div>

  {#if $isAdmin && geoStatus}
    <!-- One line by default; the sweep controls unfold on demand. -->
    <div class="geo-line" class:expanded={geoExpanded}>
      <div class="geo-summary">
        <Icon name="globe" size={14} />
        <span>{$t('site.geocode_summary', geoStatus.pending, geoStatus.geocoded, geoStatus.failed)}</span>
        {#if geoStatus.failed > 0}<span class="geo-dot bad" title={$t('site.geocode_failed_count')}></span>{/if}
        <button class="geo-toggle" on:click={() => (geoExpanded = !geoExpanded)} aria-expanded={geoExpanded}>
          {geoExpanded ? $t('site.geocode_collapse') : $t('site.geocode_expand')}
          <Icon name={geoExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
      </div>
      {#if geoExpanded}
        <div class="geo-actions">
          {#if geoMeta.sweep_in_progress}
            <span class="geo-note">{$t('site.geocode_sweep_running')}</span>
          {:else if !geoMeta.bulk_enabled}
            <span class="geo-note">{$t('site.geocode_bulk_disabled')}</span>
          {:else}
            <button class="tbl-btn" on:click={() => runSweep(false)} disabled={sweeping || geoStatus.pending === 0}>
              {$t('site.geocode_run')}
            </button>
            <button class="tbl-btn" on:click={() => runSweep(true)} disabled={sweeping || geoStatus.failed === 0}>
              {$t('site.geocode_retry_failed')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if loading}
    <Skeleton height="320px" />
  {:else if sites.length === 0}
    <EmptyState
      icon="map-pin"
      title={$t('site.no_sites')}
      message={$t('site.no_sites_hint')}
    />
  {:else}
    <div class="table-wrap">
      <table class="sites-table">
        <thead>
          <tr>
            <th>{$t('site.name')}</th>
            <th>{$t('site.address')}</th>
            <th class="num">{$t('site.device_count')}</th>
            <th class="num">{$t('site.online_count')}</th>
            <th class="num">{$t('site.alarm_count')}</th>
            {#if $canWrite}<th class="actions-col"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each sites as site (site.id)}
            <tr>
              <td class="name-cell">
                <a class="name-link" href="#/sites/{site.id}" title={$t('site.open_site')}>{site.name}</a>
                {#if site.contact_name}
                  <span class="contact-line truncate" title={[site.contact_name, site.contact_phone].filter(Boolean).join(' · ')}>
                    <Icon name="user" size={11} /> {site.contact_name}
                  </span>
                {/if}
              </td>
              <td class="addr-cell">
                <span class="addr-text">
                  {#if addressLine(site)}
                    {addressLine(site)}
                  {:else}
                    <span class="muted">{$t('site.no_address')}</span>
                  {/if}
                  {#if site.geo_source === 'failed' || site.geo_source === 'manual'}
                    <!-- Coordinates left the table; only what needs attention keeps a flag. -->
                    <span class="geo-flag" class:bad={site.geo_source === 'failed'} title={geoFlagTitle(site)}>
                      <Icon name={site.geo_source === 'failed' ? 'alert-triangle' : 'map-pin'} size={12} />
                    </span>
                  {/if}
                </span>
              </td>
              <td class="num font-mono">
                {#if site.device_count > 0}
                  <a class="count-link" href="#/?site={site.id}" title={$t('site.show_on_dashboard')}>{site.device_count}</a>
                {:else}
                  <span class="muted">0</span>
                {/if}
              </td>
              <td class="num font-mono ok">{site.online_count}</td>
              <td class="num font-mono">
                {#if site.alarm_count > 0}
                  <a class="count-link bad" href="#/alarms?site={site.id}" title={$t('site.show_alarms')}>{site.alarm_count}</a>
                {:else}
                  <span class="muted">0</span>
                {/if}
              </td>
              {#if $canWrite}
                <td class="actions-col">
                  <button class="tbl-btn" on:click={() => (reportSite = site)} title={$t('export.haccp_report')}
                    aria-label="{$t('export.haccp_report')} {site.name}" disabled={site.device_count === 0}>
                    <Icon name="download" size={14} />
                  </button>
                  {#if $isAdmin}
                  <button class="tbl-btn" on:click={() => openEdit(site)} title={$t('site.edit_site')}
                    aria-label="{$t('site.edit_site')} {site.name}">
                    <Icon name="edit" size={14} />
                  </button>
                  <button class="tbl-btn" on:click={() => regeocode(site)} title={$t('site.geocode')}
                    aria-label="{$t('site.geocode')} {site.name}" disabled={!geoMeta.geocoder_enabled}>
                    <Icon name="globe" size={14} />
                  </button>
                  <button class="tbl-btn" on:click={() => (linksSite = site)} title={$t('site.public_links')}
                    aria-label="{$t('site.public_links')} {site.name}">
                    <Icon name="link" size={14} />
                  </button>
                  <button class="tbl-btn danger" on:click={() => askDelete(site)} title={$t('common.delete')}
                    aria-label="{$t('common.delete')} {site.name}">
                    <Icon name="trash" size={14} />
                  </button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<!-- ── Editor modal ──────────────────────────────────────── -->
{#if showEditor}
  <div class="modal-backdrop" role="presentation" on:click={onEditorBackdrop} on:keydown={onEditorKey}>
    <div class="modal modal-wide" role="dialog" aria-modal="true"
      aria-label={editing ? $t('site.edit_site') : $t('site.new_site')}>
      <div class="modal-header">
        <h2>{editing ? $t('site.edit_site') : $t('site.new_site')}</h2>
        <button class="modal-close" on:click={closeEditor} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <div class="form-group">
          <label for="site-name">{$t('site.name')}</label>
          <input id="site-name" type="text" maxlength="256" bind:value={form.name}
            placeholder={$t('site.name_placeholder')} />
        </div>

        <!-- Lazily imported: AddressPicker pulls in MapCanvas and therefore
             Leaflet, which must stay out of the entry chunk. -->
        {#await import('../components/map/AddressPicker.svelte')}
          <Skeleton height="320px" />
        {:then { default: AddressPicker }}
          <AddressPicker mode="full" bind:value={address} disabled={saving} height="260px" />
        {:catch}
          <p class="hint">{$t('map.load_failed')}</p>
        {/await}

        {#if editing}
          <!-- Where the stored position came from — what the table used to show. -->
          <div class="geo-details">
            <span class="geo-details-title">{$t('site.geo_details')}</span>
            <span class="geo-badge geo-{editing.geo_source}">{$t(geoSourceKey(editing.geo_source))}</span>
            {#if editing.geo_precision}
              <span class="muted">{$t('site.precision')}: {$t(precisionKey(editing.geo_precision))}</span>
            {/if}
            {#if editing.latitude !== null && editing.longitude !== null}
              <span class="muted font-mono">{formatCoords(editing.latitude, editing.longitude)}</span>
            {:else}
              <span class="muted">{$t('site.coords_none')}</span>
            {/if}
            {#if editing.geo_source === 'failed' && editing.geo_error}
              <span class="bad">{$t('site.geo_error_hint', editing.geo_error)}</span>
            {/if}
          </div>
        {/if}

        <fieldset class="contacts">
          <legend>{$t('site.contacts')}</legend>
          <div class="form-row">
            <div class="form-group grow">
              <label for="site-contact-name">{$t('site.contact_name')}</label>
              <input id="site-contact-name" type="text" maxlength="120" bind:value={form.contact_name}
                placeholder={$t('site.contact_name_placeholder')} />
            </div>
            <div class="form-group grow">
              <label for="site-contact-phone">{$t('site.contact_phone')}</label>
              <input id="site-contact-phone" type="tel" maxlength="40" bind:value={form.contact_phone} />
            </div>
            <div class="form-group grow">
              <label for="site-contact-email">{$t('site.contact_email')}</label>
              <input id="site-contact-email" type="email" maxlength="160" bind:value={form.contact_email} />
            </div>
          </div>
          <p class="hint">{$t('site.contact_hint')}</p>
        </fieldset>

        <div class="form-group">
          <label for="site-notes">{$t('site.notes')}</label>
          <textarea id="site-notes" rows="2" maxlength="4000" bind:value={form.notes}></textarea>
        </div>
        <div class="form-group">
          <label for="site-haccp-excursion">{$t('site.haccp_excursion_min')}</label>
          <input id="site-haccp-excursion" type="number" min="1" max="1440" bind:value={form.haccp_excursion_min} placeholder={$t('site.haccp_excursion_placeholder')} />
          <p class="hint">{$t('site.haccp_excursion_hint')}</p>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeEditor} disabled={saving}>{$t('common.cancel')}</button>
        <button class="btn btn-primary" on:click={save} disabled={!canSave}>
          {saving ? $t('common.loading') : $t('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Delete confirmation ───────────────────────────────── -->
{#if deleting}
  <div class="modal-backdrop" role="presentation"
    on:click={(e) => { if (e.target === e.currentTarget) deleting = null }}
    on:keydown={(e) => { if (e.key === 'Escape') deleting = null }}>
    <div class="modal" role="dialog" aria-modal="true" aria-label={$t('common.delete')}>
      <div class="modal-header">
        <h2>{$t('common.delete')}</h2>
        <button class="modal-close" on:click={() => (deleting = null)} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <p>{$t('site.delete_confirm', deleting.name)}</p>
        {#if deleting.device_count > 0}
          <p class="hint hint-warn">{$t('site.has_devices', deleting.device_count)}</p>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={() => (deleting = null)} disabled={deleteBusy}>
          {$t('common.cancel')}
        </button>
        {#if deleting.device_count > 0}
          <button class="btn btn-danger" on:click={() => confirmDelete(true)} disabled={deleteBusy}>
            {$t('site.detach_devices')}
          </button>
        {:else}
          <button class="btn btn-danger" on:click={() => confirmDelete(false)} disabled={deleteBusy}>
            {$t('common.delete')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- ── HACCP / service report for the whole site ─────────── -->
{#if reportSite}
  <SiteReportModal site={reportSite} on:close={() => (reportSite = null)} />
{/if}

<!-- ── Public links panel ────────────────────────────────── -->
{#if linksSite}
  <div class="modal-backdrop" role="presentation"
    on:click={(e) => { if (e.target === e.currentTarget) linksSite = null }}
    on:keydown={(e) => { if (e.key === 'Escape') linksSite = null }}>
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-label={$t('site.public_links')}>
      <div class="modal-header">
        <div>
          <h2>{$t('site.public_links')}</h2>
          <span class="modal-subtitle">{linksSite.name}</span>
        </div>
        <button class="modal-close" on:click={() => (linksSite = null)} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <SitePublicLinks site={linksSite} />
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={() => (linksSite = null)}>{$t('common.close')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sites-page {
    padding: var(--space-5);
    max-width: 1400px;
    margin: 0 auto;
  }

  .toolbar {
    margin-bottom: var(--space-4);
    max-width: 420px;
  }

  .hdr-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--accent-blue);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    color: #fff;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: filter var(--transition-fast);
  }

  .hdr-btn:hover {
    filter: brightness(1.1);
  }

  /* ── Geocode progress ──────────────────────────────── */

  .geo-line {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .geo-summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .geo-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-red);
  }

  .geo-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    padding: 2px var(--space-2);
    background: transparent;
    border: none;
    color: var(--accent-blue);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .geo-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-muted);
  }

  .geo-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  /* ── Table ─────────────────────────────────────────── */

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .sites-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .sites-table th {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-default);
    white-space: nowrap;
  }

  .sites-table td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-primary);
    vertical-align: top;
  }

  .sites-table tbody tr:hover {
    background: var(--bg-tertiary);
  }

  .num {
    text-align: right;
  }

  .ok {
    color: var(--accent-green);
  }

  .bad {
    color: var(--accent-red);
  }

  .muted {
    color: var(--text-muted);
  }

  .name-cell {
    font-weight: 500;
    white-space: nowrap;
  }

  .name-link {
    color: var(--text-primary);
    text-decoration: none;
    border-bottom: 1px dotted var(--border-default);
  }

  .name-link:hover {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
  }

  .contact-line {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 240px;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }

  .addr-cell {
    min-width: 220px;
  }

  .addr-text {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .geo-flag {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    cursor: help;
  }

  .geo-flag.bad {
    color: var(--accent-red);
  }

  .count-link {
    color: var(--accent-blue);
    text-decoration: none;
    border-bottom: 1px dotted transparent;
  }

  .count-link:hover {
    border-bottom-color: currentColor;
  }

  .count-link.bad {
    color: var(--accent-red);
    font-weight: 600;
  }

  .geo-badge {
    display: inline-block;
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-default);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .geo-badge.geo-geocoded,
  .geo-badge.geo-manual {
    border-color: var(--accent-green);
    color: var(--accent-green);
  }

  .geo-badge.geo-failed {
    border-color: var(--accent-red);
    color: var(--accent-red);
  }

  .geo-details {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .geo-details-title {
    color: var(--text-secondary);
    font-weight: 500;
  }

  .actions-col {
    text-align: right;
    white-space: nowrap;
  }

  .tbl-btn {
    padding: var(--space-1) var(--space-2);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .tbl-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .tbl-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tbl-btn.danger:hover:not(:disabled) {
    color: var(--accent-red);
    border-color: var(--accent-red);
  }

  /* ── Modals ────────────────────────────────────────── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 460px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .modal-wide {
    max-width: 720px;
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-subtitle {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-row {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .form-group.grow {
    flex: 1;
    min-width: 160px;
  }

  .form-group label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-group input,
  .form-group textarea {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
    resize: vertical;
    transition: border-color var(--transition-fast);
  }

  .form-group input:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .contacts {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
  }

  .contacts legend {
    padding: 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint-warn {
    color: var(--accent-yellow);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    border: 1px solid transparent;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-default);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .btn-danger {
    background: var(--accent-red);
    color: #fff;
    border-color: var(--accent-red);
  }

  .btn-danger:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  @media (max-width: 768px) {
    .sites-page {
      padding: var(--space-3);
    }

    .geo-toggle {
      margin-left: 0;
    }
  }
</style>
