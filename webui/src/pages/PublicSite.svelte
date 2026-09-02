<script>
  /**
   * Public read-only status page for one site — `#/public/site/<token>`.
   *
   * This is the ONLY page in the app a logged-out visitor can reach, and it makes
   * exactly ONE request:
   *
   *   GET /api/public/site   with the raw token in the `X-Site-Token` header
   *
   * Three deliberate constraints, all of them load-bearing:
   *
   * 1. `getPublicSite()` is a BARE fetch, never `request()` from `lib/api.js`.
   *    That helper attaches the Bearer token, runs the refresh chain and calls
   *    `navigate()` on 401 — all three are wrong for a page that must work with
   *    no session at all. Nothing else on this page talks to the API.
   * 2. The token travels in a HEADER, not in the path: nginx writes the request
   *    path to access.log, and this token is a long-lived credential for a
   *    tenant's status page. It lives in the URL FRAGMENT, which browsers never
   *    send to the server and never put in a Referer.
   * 3. No app shell. `App.svelte` branches on `#/public/site/` ABOVE the auth gate
   *    and renders this component standalone, so it owns its own full-page layout.
   *
   * The backend decides what may be shown (site name + city/region/country, and
   * per device only `{ name, online, air_temp, alarm_active }`). Nothing here
   * asks for more, and unknown / revoked / expired tokens are indistinguishable:
   * all three answer 404 with the same body.
   */
  import { onMount, onDestroy } from 'svelte'
  import { getPublicSite } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import { formatDate, formatTemp } from '../lib/format.js'
  import Icon from '../components/ui/Icon.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'

  /** Passed by App.svelte. `params` covers a svelte-spa-router mount as well. */
  export let token = ''
  export let params = {}

  // A status page is meant to stay open on a screen in the back office; the
  // endpoint's own limiter allows 30 views per IP per 5 minutes, so one minute
  // between silent refreshes stays comfortably inside it.
  const REFRESH_MS = 60000

  // Fallback only — App.svelte normally passes the token in. Kept behaviourally
  // identical to its `readPublicToken()` so the two can never disagree about what
  // the credential is: stop at a query/extra segment so a stray `?utm=…` never
  // becomes part of what we send.
  //
  // Declared BEFORE the `hashToken` initialiser below — it is read during instance
  // setup, and a `const` further down would still be in its temporal dead zone.
  const PUBLIC_PREFIX = '#/public/site/'

  function readHashToken() {
    const hash = typeof window !== 'undefined' ? (window.location.hash || '') : ''
    if (!hash.startsWith(PUBLIC_PREFIX)) return ''
    const raw = hash.slice(PUBLIC_PREFIX.length).split(/[?&#]/)[0]
    if (!raw) return ''
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw   // a malformed escape is still a token the backend will 404
    }
  }

  function onHashChange() {
    hashToken = readHashToken()
  }

  let hashToken = readHashToken()
  let site = null
  let loading = true
  let refreshing = false
  /** null | 'not_found' | 'rate_limited' | 'error' */
  let failure = null
  let loadedToken = null
  let timer = null

  $: resolvedToken = String(token || params.token || hashToken || '').trim()
  $: if (resolvedToken !== loadedToken) load()

  $: locationLine = site
    ? [site.city, site.region, site.country].filter(Boolean).join(', ')
    : ''

  // Defensive: this page is rendered from a response nobody on it authenticated
  // for, so it never assumes a field is present.
  $: devices = site && Array.isArray(site.devices) ? site.devices : []
  $: deviceCount = site && Number.isFinite(site.device_count) ? site.device_count : devices.length

  // Days until the link stops working; a warning shows during the last week so the
  // person who put this page on a back-office screen asks for a new link in time.
  $: expiresInDays = site && site.link_expires_at
    ? Math.ceil((new Date(site.link_expires_at).getTime() - Date.now()) / 86400000)
    : null
  const LANDING_URL = '/'
  const PILOT_URL = '/#pilot'
  $: onlineCount = site && Number.isFinite(site.online_count)
    ? site.online_count
    : devices.filter(d => d.online).length
  $: alarmCount = site && Number.isFinite(site.alarm_count)
    ? site.alarm_count
    : devices.filter(d => d.alarm_active).length

  function deviceStatus(device) {
    if (device.alarm_active) return 'alarm'
    return device.online ? 'online' : 'offline'
  }

  async function load(silent = false) {
    loadedToken = resolvedToken

    if (!resolvedToken) {
      site = null
      failure = 'not_found'
      loading = false
      return
    }

    if (silent) refreshing = true
    else loading = true

    try {
      const data = await getPublicSite(resolvedToken)

      // The token may have changed while the request was in flight.
      if (loadedToken !== resolvedToken) return

      site = data || null
      failure = site ? null : 'error'
      if (site && site.name) document.title = `${site.name} — ModESP Cloud`
    } catch (e) {
      if (loadedToken !== resolvedToken) return
      if (e && e.status === 404) {
        // Unknown, revoked and expired are the same answer by design.
        site = null
        failure = 'not_found'
      } else if (e && e.status === 429) {
        // Keep whatever is on screen — a throttled refresh is not a loss.
        failure = site ? null : 'rate_limited'
      } else {
        // Offline, DNS, proxy down — keep the last good snapshot if there is one.
        failure = site ? null : 'error'
      }
    } finally {
      if (loadedToken === resolvedToken) {
        loading = false
        refreshing = false
      }
    }
  }

  function refresh() {
    if (loading || refreshing) return
    load(true)
  }

  onMount(() => {
    // App.svelte's route-title handler never runs for this branch (there is no
    // <Router> here), so the page names itself until the site name arrives.
    document.title = `${$t('public.site_status')} — ModESP Cloud`
    window.addEventListener('hashchange', onHashChange)
    timer = setInterval(() => {
      // A backgrounded tab must not keep spending the endpoint's rate limit.
      if (document.visibilityState === 'visible' && site) refresh()
    }, REFRESH_MS)
  })

  onDestroy(() => {
    window.removeEventListener('hashchange', onHashChange)
    clearInterval(timer)
  })
</script>

<div class="public-page">
  <div class="public-inner">
    {#if loading}
      <div class="state">
        <div class="spinner" aria-hidden="true"></div>
        <p>{$t('public.loading')}</p>
      </div>
    {:else if failure === 'not_found'}
      <div class="state">
        <Icon name="x-circle" size={28} />
        <h1>{$t('public.not_found')}</h1>
        <p>{$t('public.not_found_hint')}</p>
      </div>
    {:else if failure === 'rate_limited'}
      <div class="state">
        <Icon name="clock" size={28} />
        <h1>{$t('public.rate_limited')}</h1>
        <button class="btn" on:click={() => load()}>{$t('public.retry')}</button>
      </div>
    {:else if failure === 'error' || !site}
      <div class="state">
        <Icon name="alert-triangle" size={28} />
        <h1>{$t('public.load_error')}</h1>
        <button class="btn" on:click={() => load()}>{$t('public.retry')}</button>
      </div>
    {:else}
      <header class="head">
        <div class="head-title">
          {#if site.organisation}
            <p class="head-org">{site.organisation}</p>
          {/if}
          <h1>{site.name}</h1>
          {#if locationLine}
            <p class="head-place">
              <Icon name="map-pin" size={13} />
              {locationLine}
            </p>
          {/if}
        </div>
        <button class="icon-btn" on:click={refresh} disabled={refreshing}
          title={$t('common.refresh')} aria-label={$t('common.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      </header>

      <div class="summary">
        <div class="stat">
          <span class="stat-value">{deviceCount}</span>
          <span class="stat-label">{$t('public.total')}</span>
        </div>
        <div class="stat">
          <span class="stat-value stat-online">{onlineCount}</span>
          <span class="stat-label">{$t('public.online')}</span>
        </div>
        <div class="stat">
          <span class="stat-value" class:stat-alarm={alarmCount > 0}>{alarmCount}</span>
          <span class="stat-label">{$t('public.alarms')}</span>
        </div>
      </div>

      {#if devices.length === 0}
        <p class="empty">{$t('public.no_devices')}</p>
      {:else}
        <ul class="devices">
          {#each devices as device, i (device.name + ':' + i)}
            <li class="device" class:device-alarm={device.alarm_active}>
              <StatusDot status={deviceStatus(device)} size="sm" />
              <span class="device-name">{device.name}</span>
              {#if device.alarm_active}
                <span class="alarm-tag">{$t('public.alarm')}</span>
              {/if}
              <span class="device-temp" title={$t('public.temperature')}>{formatTemp(device.air_temp).text}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if expiresInDays !== null && expiresInDays <= 7}
        <p class="expiry" role="status">{$t('public.expires_soon', Math.max(expiresInDays, 0))}</p>
      {/if}

      <footer class="foot">
        {#if site.generated_at}
          <span>{$t('public.updated', formatDate(site.generated_at))}</span>
        {/if}
        <span>{$t('public.read_only')}</span>
        <a class="foot-brand" href={LANDING_URL} rel="noopener">{$t('public.powered_by_link')}</a>
      </footer>
      <a class="cta" href={PILOT_URL} rel="noopener">{$t('public.cta')}</a>
    {/if}
  </div>
</div>

<style>
  /* Standalone page: no sidebar, no header, no app grid — it renders above the
     auth gate in App.svelte and owns the whole viewport. */
  .public-page {
    min-height: 100vh;
    background: var(--bg-primary);
    padding: var(--space-4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }

  .public-inner {
    width: 100%;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ── States ─────────────────────────────────── */

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    min-height: 60vh;
    color: var(--text-muted);
    text-align: center;
  }

  .state h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .state p {
    margin: 0;
    font-size: var(--text-sm);
    max-width: 32ch;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--accent-blue);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .btn:hover {
    background: var(--accent-blue);
    color: var(--text-inverse);
  }

  /* ── Header ─────────────────────────────────── */

  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding-top: var(--space-4);
  }

  .head-title {
    flex: 1;
    min-width: 0;
  }

  .head h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--text-xl);
    font-weight: 600;
    word-break: break-word;
  }

  .head-place {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--accent-blue);
    border-color: var(--accent-blue);
  }

  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Summary ────────────────────────────────── */

  .summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--space-3) var(--space-2);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .stat-value {
    color: var(--text-primary);
    font-size: var(--text-xl);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .stat-online { color: var(--status-online); }
  .stat-alarm  { color: var(--status-alarm); }

  .stat-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ── Devices ────────────────────────────────── */

  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .device {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }

  .device-alarm {
    border-color: var(--status-alarm);
  }

  .device-name {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-size: var(--text-base);
    word-break: break-word;
  }

  .alarm-tag {
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--status-alarm);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .device-temp {
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-variant-numeric: tabular-nums;
  }

  .empty {
    margin: 0;
    padding: var(--space-5) var(--space-3);
    background: var(--bg-surface);
    border: 1px dashed var(--border-default);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  /* ── Footer ─────────────────────────────────── */

  .foot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--space-3) 0 var(--space-5);
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }

  .foot-brand {
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  @media (max-width: 480px) {
    .public-page {
      padding: var(--space-3);
    }

    .head h1 {
      font-size: var(--text-lg);
    }
  }
  .head-org {
    margin: 0 0 2px;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .expiry {
    margin: var(--space-3) 0 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent-orange, #f59e0b) 15%, transparent);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  a.foot-brand {
    color: inherit;
    text-decoration: none;
  }

  a.foot-brand:hover {
    text-decoration: underline;
  }

  .cta {
    display: block;
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    text-align: center;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .cta:hover {
    color: var(--text-primary);
    border-color: var(--accent-blue);
  }
</style>
