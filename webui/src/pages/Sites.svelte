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
   * Read is open to every authenticated role: `GET /api/sites` narrows by RBAC
   * (a technician sees only sites where they can see a device, or hold a
   * user_sites grant) rather than by role. Every mutation below is admin-only
   * server-side, so the controls that write are behind `$isAdmin`.
   *
   * Leaflet is never imported here — AddressPicker is loaded lazily inside the
   * editor modal, so opening the list costs nothing.
   */
  import { onMount } from 'svelte'
  import {
    getSites, createSite, updateSite, deleteSite, geocodeSite,
    getGeocodeStatus, geocodePendingSites,
    getSitePublicLinks, createSitePublicLink, revokeSitePublicLink,
    exportSitePdf,
  } from '../lib/api.js'
  import { isAdmin, canWrite } from '../lib/stores.js'
  import { t, locale } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { emptyAddress, formatCoords, precisionKey } from '../lib/geo.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import SearchInput from '../components/ui/SearchInput.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  const SEARCH_DEBOUNCE_MS = 300

  let sites = []
  let loading = true
  let search = ''
  let searchTimer = null

  // Geocode progress (admin only — GET /api/sites/geocode-status is maybeAuthorize('admin')).
  let geoStatus = null      // { pending, geocoded, failed }
  let geoMeta = {}          // { geocoder_enabled, bulk_enabled, sweep_in_progress }
  let sweeping = false

  // Editor modal
  let showEditor = false
  let editing = null        // the site row being edited, or null for "create"
  let form = { name: '', notes: '' }
  let address = emptyAddress()
  let saving = false

  // Delete confirmation
  let deleting = null
  let deleteBusy = false

  // Public links panel
  let linksSite = null
  let links = []
  let linksLoading = false
  let linkLabel = ''
  let linkDays = 90
  let linkBusy = false
  let mintedToken = null    // shown exactly once, never recoverable afterwards

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
    form = { name: '', notes: '' }
    address = emptyAddress()
    showEditor = true
  }

  function openEdit(site) {
    editing = site
    form = { name: site.name || '', notes: site.notes || '' }
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

  // ── HACCP report (one PDF for every device of the site) ──

  let reportSite = null
  let reportFrom = ''
  let reportTo = ''
  let reportBusy = false

  function isoDay(d) { return d.toISOString().slice(0, 10) }

  function openReport(site) {
    reportSite = site
    reportTo = isoDay(new Date())
    reportFrom = isoDay(new Date(Date.now() - 30 * 86400 * 1000))
  }

  async function runReport() {
    if (!reportSite || !reportFrom || !reportTo) return
    reportBusy = true
    try {
      const from = new Date(reportFrom + 'T00:00:00').toISOString()
      const to = new Date(reportTo + 'T23:59:59').toISOString()
      const meta = await exportSitePdf(reportSite.id, from, to, '1h', $locale)
      if (meta && meta.code) toast.success($t('export.report_code', meta.code), 8000)
      else toast.success($t('export.export_success'))
      if (meta && meta.source === 'hourly') toast.info($t('export.hourly_source'), 8000)
      reportSite = null
    } catch (e) {
      if (e.status === 404) toast.warning($t('export.no_data'))
      else if (e.status !== 402) toast.error(e.message || $t('export.export_error'))
    } finally {
      reportBusy = false
    }
  }

  // ── Public links ───────────────────────────────────────

  async function openLinks(site) {
    linksSite = site
    mintedToken = null
    linkLabel = ''
    linkDays = 90
    linksLoading = true
    try {
      links = await getSitePublicLinks(site.id)
    } catch (e) {
      toast.error(e.message)
      links = []
    } finally {
      linksLoading = false
    }
  }

  function closeLinks() {
    linksSite = null
    links = []
    mintedToken = null
  }

  function onLinksKey(e) {
    if (e.key === 'Escape') closeLinks()
  }

  function onLinksBackdrop(e) {
    if (e.target === e.currentTarget) closeLinks()
  }

  /**
   * The shareable address. The token lives in the HASH FRAGMENT, which browsers
   * never send to a server — so it appears in no access log and in no Referer.
   * App.svelte reads it from there and passes it in the X-Site-Token header.
   */
  function publicUrl(token) {
    const { origin, pathname } = window.location
    return `${origin}${pathname}#/public/site/${encodeURIComponent(token)}`
  }

  async function mintLink() {
    if (!linksSite) return
    linkBusy = true
    try {
      const created = await createSitePublicLink(linksSite.id, {
        label: linkLabel.trim() || undefined,
        expires_in_days: Number(linkDays) || undefined,
      })
      // The raw token is in this response and nowhere else, ever again.
      mintedToken = created.token || null
      links = [created, ...links]
      linkLabel = ''
      toast.success($t('site.public_link_created'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      linkBusy = false
    }
  }

  async function revokeLink(link) {
    if (!linksSite) return
    if (!window.confirm($t('site.public_link_revoke_confirm'))) return
    try {
      await revokeSitePublicLink(linksSite.id, link.id)
      toast.success($t('site.public_link_revoked'))
      links = links.map(l => (l.id === link.id ? { ...l, active: false, revoked_at: new Date().toISOString() } : l))
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function copyUrl(token) {
    try {
      await navigator.clipboard.writeText(publicUrl(token))
      toast.success($t('site.public_link_copied'))
    } catch {
      // Clipboard access can be denied outright; the value is on screen anyway.
      toast.warning($t('site.public_link_token_once'))
    }
  }

  // ── Rendering helpers ──────────────────────────────────

  function addressLine(site) {
    return [site.address_line, site.city, site.region, site.country]
      .filter(v => typeof v === 'string' && v.trim() !== '')
      .join(', ')
  }

  function formatDate(value) {
    if (!value) return '—'
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  onMount(() => {
    load()
    loadGeoStatus()
  })
</script>

<div class="sites-page">
  <PageHeader title={$t('pages.sites')} subtitle={$t('pages.sites_sub')}>
    {#if $isAdmin}
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
    <div class="geo-panel">
      <div class="geo-title">
        <Icon name="globe" size={14} />
        <span>{$t('site.geocode_status')}</span>
      </div>
      <div class="geo-counters font-mono">
        <span>{$t('site.geocode_pending')}: {geoStatus.pending}</span>
        <span class="ok">{$t('site.geocode_done')}: {geoStatus.geocoded}</span>
        <span class="bad">{$t('site.geocode_failed_count')}: {geoStatus.failed}</span>
      </div>
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
            <th>{$t('site.geo_source')}</th>
            {#if $canWrite}<th class="actions-col"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each sites as site (site.id)}
            <tr>
              <td class="name-cell">{site.name}</td>
              <td class="addr-cell">
                {#if addressLine(site)}
                  <span>{addressLine(site)}</span>
                {:else}
                  <span class="muted">{$t('site.no_address')}</span>
                {/if}
                {#if site.latitude !== null && site.longitude !== null}
                  <span class="coords font-mono">{formatCoords(site.latitude, site.longitude)}</span>
                {/if}
              </td>
              <td class="num font-mono">{site.device_count}</td>
              <td class="num font-mono ok">{site.online_count}</td>
              <td class="num font-mono" class:bad={site.alarm_count > 0}>{site.alarm_count}</td>
              <td>
                <span class="geo-badge geo-{site.geo_source}">{$t(`site.geo_source_${site.geo_source}`)}</span>
                {#if site.geo_precision}
                  <span class="muted">{$t(precisionKey(site.geo_precision))}</span>
                {/if}
              </td>
              {#if $canWrite}
                <td class="actions-col">
                  <button class="tbl-btn" on:click={() => openReport(site)} title={$t('export.haccp_report')}
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
                  <button class="tbl-btn" on:click={() => openLinks(site)} title={$t('site.public_links')}
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

        <div class="form-group">
          <label for="site-notes">{$t('site.notes')}</label>
          <textarea id="site-notes" rows="2" maxlength="4000" bind:value={form.notes}></textarea>
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

<!-- ── HACCP site report ─────────────────────────────────── -->
{#if reportSite}
  <div class="modal-backdrop" role="presentation"
    on:click={(e) => { if (e.target === e.currentTarget && !reportBusy) reportSite = null }}
    on:keydown={(e) => { if (e.key === 'Escape' && !reportBusy) reportSite = null }}>
    <div class="modal" role="dialog" aria-modal="true" aria-label={$t('export.haccp_report')}>
      <div class="modal-header">
        <h2>{$t('export.haccp_report')} — {reportSite.name}</h2>
        <button class="modal-close" on:click={() => (reportSite = null)} aria-label={$t('common.close')} disabled={reportBusy}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <p class="hint">{$t('export.site_report_hint', reportSite.device_count)}</p>
        <div class="form-row">
          <div class="form-group grow">
            <label for="report-from">{$t('export.period_from')}</label>
            <input id="report-from" type="date" bind:value={reportFrom} max={reportTo} disabled={reportBusy} />
          </div>
          <div class="form-group grow">
            <label for="report-to">{$t('export.period_to')}</label>
            <input id="report-to" type="date" bind:value={reportTo} min={reportFrom} disabled={reportBusy} />
          </div>
        </div>
        <p class="hint">{$t('export.verify_hint')}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={() => (reportSite = null)} disabled={reportBusy}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-primary" on:click={runReport} disabled={reportBusy || !reportFrom || !reportTo}>
          {reportBusy ? $t('export.exporting') : $t('export.export_pdf')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Public links panel ────────────────────────────────── -->
{#if linksSite}
  <div class="modal-backdrop" role="presentation" on:click={onLinksBackdrop} on:keydown={onLinksKey}>
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-label={$t('site.public_links')}>
      <div class="modal-header">
        <div>
          <h2>{$t('site.public_links')}</h2>
          <span class="modal-subtitle">{linksSite.name}</span>
        </div>
        <button class="modal-close" on:click={closeLinks} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        {#if mintedToken}
          <!-- The ONLY moment this value exists outside the browser's memory:
               the server stores sha256(token) and nothing else. -->
          <div class="token-box">
            <p class="token-warn">
              <Icon name="alert-triangle" size={14} />
              {$t('site.public_link_token_once')}
            </p>
            <div class="token-row">
              <input class="token-input font-mono" type="text" readonly value={publicUrl(mintedToken)} />
              <button class="tbl-btn" on:click={() => copyUrl(mintedToken)}>
                {$t('site.public_link_copy')}
              </button>
            </div>
          </div>
        {/if}

        <div class="mint-row">
          <div class="form-group grow">
            <label for="link-label">{$t('site.public_link_label')}</label>
            <input id="link-label" type="text" maxlength="128" bind:value={linkLabel}
              placeholder={$t('site.public_link_label_placeholder')} />
          </div>
          <div class="form-group">
            <label for="link-days">{$t('site.public_link_expires_in')}</label>
            <!-- 1..365: the same bound createLinkSchema enforces server-side, so
                 the form cannot produce a 400 the user has no way to read. -->
            <input id="link-days" type="number" min="1" max="365" bind:value={linkDays} />
          </div>
          <button class="btn btn-primary" on:click={mintLink} disabled={linkBusy}>
            {$t('site.public_link_new')}
          </button>
        </div>

        {#if linksLoading}
          <Skeleton height="120px" />
        {:else if links.length === 0}
          <p class="hint">{$t('site.public_link_none')}</p>
        {:else}
          <table class="links-table">
            <thead>
              <tr>
                <th>{$t('site.public_link_label')}</th>
                <th>{$t('site.public_link_expires')}</th>
                <th class="num">{$t('site.public_link_views')}</th>
                <th>{$t('site.public_link_last_viewed')}</th>
                <th class="actions-col"></th>
              </tr>
            </thead>
            <tbody>
              {#each links as link (link.id)}
                <tr>
                  <td>{link.label || '—'}</td>
                  <td>
                    {formatDate(link.expires_at)}
                    <span class="link-state" class:active={link.active}>
                      {link.active ? $t('site.public_link_active') : $t('site.public_link_expired')}
                    </span>
                  </td>
                  <td class="num font-mono">{link.view_count ?? 0}</td>
                  <td>{formatDate(link.last_viewed)}</td>
                  <td class="actions-col">
                    {#if link.active}
                      <button class="tbl-btn danger" on:click={() => revokeLink(link)}>
                        {$t('site.public_link_revoke')}
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeLinks}>{$t('common.close')}</button>
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

  .geo-panel {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .geo-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .geo-counters {
    display: flex;
    gap: var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .geo-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
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

  .sites-table,
  .links-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .sites-table th,
  .links-table th {
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

  .sites-table td,
  .links-table td {
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

  .addr-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 220px;
  }

  .coords {
    color: var(--text-muted);
    font-size: var(--text-xs);
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
  }

  .form-group.grow {
    flex: 1;
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

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint-warn {
    color: var(--accent-yellow);
  }

  /* ── Public links ──────────────────────────────────── */

  .mint-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .token-box {
    padding: var(--space-3);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .token-warn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent-yellow);
    font-size: var(--text-xs);
  }

  .token-row {
    display: flex;
    gap: var(--space-2);
  }

  .token-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
  }

  .link-state {
    display: inline-block;
    margin-left: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .link-state.active {
    color: var(--accent-green);
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

    .geo-actions {
      margin-left: 0;
    }
  }
</style>
