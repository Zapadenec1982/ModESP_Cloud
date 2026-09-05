<script>
  import { onMount, onDestroy } from 'svelte'
  import Router from 'svelte-spa-router'
  import { wrap } from 'svelte-spa-router/wrap'
  import { authEnabled, authUser, isAuthenticated, isAdmin, isSuperAdmin, canWrite, sidebarCollapsed } from './lib/stores.js'
  import { checkAuthEnabled, restoreSession, getDevices, getAlarms } from './lib/api.js'
  import { connect, disconnect, reconnect, on, subscribeGlobal } from './lib/ws.js'
  import { t } from './lib/i18n.js'
  import Sidebar from './components/layout/Sidebar.svelte'
  import MobileHeader from './components/layout/MobileHeader.svelte'
  import ToastContainer from './components/ui/ToastContainer.svelte'

  // Pages
  import Dashboard from './pages/Dashboard.svelte'
  import DeviceDetail from './pages/DeviceDetail.svelte'
  import PendingDevices from './pages/PendingDevices.svelte'
  import Login from './pages/Login.svelte'
  import Users from './pages/Users.svelte'
  import Firmware from './pages/Firmware.svelte'
  import Alarms from './pages/Alarms.svelte'
  import Tenants from './pages/Tenants.svelte'
  import AuditLog from './pages/AuditLog.svelte'

  // Admin-only route guard: redirect non-admin to /
  function isAdminCheck() {
    let admin = false
    isAdmin.subscribe(v => admin = v)()
    return admin
  }

  function isSuperAdminCheck() {
    let sa = false
    isSuperAdmin.subscribe(v => sa = v)()
    return sa
  }

  // Technician+ route guard (firmware page)
  function canWriteCheck() {
    let cw = false
    canWrite.subscribe(v => cw = v)()
    return cw
  }

  const routes = {
    '/':                Dashboard,
    '/device/:id':      DeviceDetail,
    // Lazy-loaded: keeps Leaflet (~150 KB) out of the main bundle
    '/map':             wrap({ asyncComponent: () => import('./pages/DeviceMap.svelte') }),
    '/geo-stats':       wrap({ asyncComponent: () => import('./pages/GeoStats.svelte') }),
    // Any authenticated role: GET /api/sites narrows by RBAC, not by role. The
    // write controls inside the page are behind $isAdmin, matching the backend.
    '/sites':           wrap({ asyncComponent: () => import('./pages/Sites.svelte') }),
    '/alarms':          Alarms,
    // Any role: the list narrows to own and accessible orders server-side (plan epic 2.3)
    '/work-orders':     wrap({ asyncComponent: () => import('./pages/WorkOrders.svelte') }),
    // Every role: own notification preferences; the subscriber sections inside are admin-only.
    '/notifications':   wrap({ asyncComponent: () => import('./pages/Notifications.svelte') }),
    '/pending':         wrap({ component: PendingDevices, conditions: [isAdminCheck] }),
    '/firmware':        wrap({ component: Firmware, conditions: [canWriteCheck] }),
    '/partner':         wrap({ asyncComponent: () => import('./pages/Partner.svelte'), conditions: [isAdminCheck] }),
    '/tenants':         wrap({ component: Tenants, conditions: [isAdminCheck] }),
    '/users':           wrap({ component: Users, conditions: [isAdminCheck] }),
    '/settings':        wrap({ asyncComponent: () => import('./pages/TenantSettings.svelte'), conditions: [isAdminCheck] }),
    '/audit-log':       wrap({ component: AuditLog, conditions: [isSuperAdminCheck] }),
  }

  // ── Public site status page (Part 2 §7.7) ──────────────
  //
  // Deliberately NOT an entry in `routes`: <Router> is instantiated only in the
  // authenticated branch below, so a route added there is unreachable for a
  // logged-out visitor. The hash is therefore read synchronously here, at
  // instance init, and the page is rendered standalone above every auth gate —
  // no sidebar, no Login screen, and no authenticated API call.
  //
  // The token lives in the fragment (`…/#/public/site/<token>`), which browsers
  // never send to a server, so it appears in no access log and in no Referer.
  const PUBLIC_PREFIX = '#/public/site/'

  function readPublicToken() {
    const hash = typeof window !== 'undefined' ? (window.location.hash || '') : ''
    if (!hash.startsWith(PUBLIC_PREFIX)) return null
    // Stop at a query/extra segment so a stray `?utm=…` never becomes part of
    // the credential we send.
    const raw = hash.slice(PUBLIC_PREFIX.length).split(/[?&#]/)[0]
    if (!raw) return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw   // a malformed escape is still a token the backend will 404
    }
  }

  const publicToken = readPublicToken()
  const isPublicView = publicToken !== null

  // ── Invitation acceptance (plan epic 1.5) ───────────────
  // Same shape as the public page: the token is read once at init and the
  // page renders standalone, above the auth gate, with no sidebar.
  const INVITE_PREFIX = '#/invite/'

  function readInviteToken() {
    const hash = typeof window !== 'undefined' ? (window.location.hash || '') : ''
    if (!hash.startsWith(INVITE_PREFIX)) return null
    const raw = hash.slice(INVITE_PREFIX.length).split(/[?&#]/)[0]
    return raw || null
  }

  const inviteToken = readInviteToken()
  const isInviteView = inviteToken !== null

  // Pasting a public link into an already-open tab changes the hash without a
  // page load, and the two shells cannot swap in place — reload across that
  // boundary only. Ordinary in-app navigation never crosses it.
  function onHashChange() {
    if ((readPublicToken() !== null) !== isPublicView) window.location.reload()
    if ((readInviteToken() !== null) !== isInviteView) window.location.reload()
  }

  let booting = true
  let alarmCount = 0
  let pendingCount = 0

  // Fetch counts for sidebar badges
  async function refreshCounts() {
    try {
      const [devRes, almRes] = await Promise.all([
        getDevices(),
        getAlarms({ active: true })
      ])
      // request() already unwraps { data }, so these are arrays. Guard both shapes.
      const devices = Array.isArray(devRes) ? devRes : (devRes?.data ?? [])
      const alarms = Array.isArray(almRes) ? almRes : (almRes?.data ?? [])
      pendingCount = devices.filter(d => d.status === 'pending').length
      alarmCount = alarms.length
    } catch (e) {
      // silent — sidebar badges are non-critical
    }
  }

  let unsubAlarm
  let unsubDeviceOnline
  let unsubDeviceOffline

  onMount(async () => {
    window.addEventListener('hashchange', onHashChange)

    // The public status page must make NO authenticated call: checkAuthEnabled()
    // fetches /api/devices, connect() asks for a WS ticket, and refreshCounts()
    // hits /api/devices + /api/alarms. Bail out before any of them.
    // (routeLoaded never fires here — there is no <Router> — so the placeholder
    // title is set explicitly; PublicSite replaces it with the site name.)
    if (isPublicView || isInviteView) {
      document.title = isInviteView ? `${$t('invite.title')} — ModESP Cloud` : `${$t('pages.public_site')} — ModESP Cloud`
      return
    }

    // Check if backend has auth enabled
    const enabled = await checkAuthEnabled()
    if (enabled) {
      const restored = await restoreSession()
      if (!restored) {
        booting = false
        return
      }
    }
    booting = false
    connect()
    subscribeGlobal()
    // Small delay ensures access token is fully set in memory after restoreSession()
    // before firing API requests (prevents spurious 401 on first request)
    await refreshCounts()

    // Update alarm count on alarm events
    unsubAlarm = on('alarm', () => refreshCounts())
    unsubDeviceOnline = on('device_online', () => refreshCounts())
    unsubDeviceOffline = on('device_offline', () => refreshCounts())
  })

  // Reconnect WS when user logs in
  $: if ($isAuthenticated && !booting && !isPublicView && !isInviteView) {
    reconnect()
    refreshCounts()
  }

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashChange)
    disconnect()
    unsubAlarm?.()
    unsubDeviceOnline?.()
    unsubDeviceOffline?.()
  })

  const pageTitleKeys = {
    '/': 'pages.dashboard',
    '/map': 'pages.map',
    '/geo-stats': 'pages.geo_stats',
    '/alarms': 'pages.alarms',
    '/notifications': 'pages.notifications',
    '/pending': 'pages.pending',
    '/firmware': 'pages.firmware',
    '/partner': 'pages.partner',
    '/tenants': 'pages.tenants',
    '/users': 'pages.users',
    '/settings': 'pages.settings',
    '/audit-log': 'pages.audit_log',
  }

  function handleRouteLoaded(e) {
    const path = e.detail.location
    const key = pageTitleKeys[path]
    const title = key ? $t(key) : (path.startsWith('/device/') ? $t('pages.device') : 'ModESP Cloud')
    document.title = `${title} — ModESP Cloud`
  }

  function conditionsFailed() {
    window.location.hash = '#/'
  }
</script>

{#if isPublicView}
  <!--
    Standalone: no Sidebar, no MobileHeader, no <Router>, no auth gate. Lazily
    imported so the public page's code never ships in the entry chunk that every
    logged-in user downloads.
  -->
  {#await import('./pages/PublicSite.svelte')}
    <div class="boot">
      <div class="boot-spinner" />
      <span class="boot-text">ModESP Cloud</span>
    </div>
  {:then { default: PublicSite }}
    <PublicSite token={publicToken} />
  {:catch}
    <div class="boot">
      <span class="boot-text">{$t('site.public_load_failed')}</span>
    </div>
  {/await}
  <ToastContainer />
{:else if isInviteView}
  {#await import('./pages/AcceptInvite.svelte')}
    <div class="boot">
      <div class="boot-spinner" />
      <span class="boot-text">ModESP Cloud</span>
    </div>
  {:then { default: AcceptInvite }}
    <AcceptInvite token={inviteToken} />
  {:catch}
    <div class="boot">
      <span class="boot-text">ModESP Cloud</span>
    </div>
  {/await}
  <ToastContainer />
{:else if booting}
  <div class="boot">
    <div class="boot-spinner" />
    <span class="boot-text">ModESP Cloud</span>
  </div>
{:else if $authEnabled && !$isAuthenticated}
  <Login />
{:else}
  <div class="app-layout" class:collapsed={$sidebarCollapsed}>
    <Sidebar {alarmCount} {pendingCount} />
    <MobileHeader />

    <main class="main-content">
      <Router {routes} on:conditionsFailed={conditionsFailed} on:routeLoaded={handleRouteLoaded} />
    </main>
  </div>
  <ToastContainer />
{/if}

<style>
  .boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: var(--space-4);
    background: var(--bg-primary);
  }

  .boot-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .boot-text {
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    letter-spacing: 0.05em;
  }

  .app-layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .main-content {
    flex: 1;
    margin-left: var(--sidebar-width);
    overflow-y: auto;
    padding: var(--space-5);
    transition: margin-left var(--transition-normal);
  }

  .app-layout.collapsed .main-content {
    margin-left: var(--sidebar-collapsed);
  }

  @media (max-width: 768px) {
    .main-content {
      margin-left: 0;
      padding: var(--space-4);
      padding-top: calc(var(--header-height) + var(--space-4));
    }
    .app-layout.collapsed .main-content {
      margin-left: 0;
    }
  }
</style>
