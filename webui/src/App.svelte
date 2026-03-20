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
    '/alarms':          Alarms,
    '/pending':         wrap({ component: PendingDevices, conditions: [isAdminCheck] }),
    '/firmware':        wrap({ component: Firmware, conditions: [canWriteCheck] }),
    '/tenants':         wrap({ component: Tenants, conditions: [isAdminCheck] }),
    '/users':           wrap({ component: Users, conditions: [isAdminCheck] }),
    '/audit-log':       wrap({ component: AuditLog, conditions: [isSuperAdminCheck] }),
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
      if (devRes?.data) {
        pendingCount = devRes.data.filter(d => d.status === 'pending').length
      }
      if (almRes?.data) {
        alarmCount = almRes.data.length
      }
    } catch (e) {
      // silent — sidebar badges are non-critical
    }
  }

  let unsubAlarm
  let unsubDeviceOnline
  let unsubDeviceOffline

  onMount(async () => {
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
  $: if ($isAuthenticated && !booting) {
    reconnect()
    refreshCounts()
  }

  onDestroy(() => {
    disconnect()
    unsubAlarm?.()
    unsubDeviceOnline?.()
    unsubDeviceOffline?.()
  })

  const pageTitleKeys = {
    '/': 'pages.dashboard',
    '/alarms': 'pages.alarms',
    '/pending': 'pages.pending',
    '/firmware': 'pages.firmware',
    '/tenants': 'pages.tenants',
    '/users': 'pages.users',
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

{#if booting}
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
