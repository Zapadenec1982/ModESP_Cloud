<script>
  import { onMount, onDestroy } from 'svelte';
  import { route, navigate, authEnabled, authUser, isAuthenticated } from './lib/stores.js';
  import { checkAuthEnabled, restoreSession, logout } from './lib/api.js';
  import { connect, disconnect, reconnect } from './lib/ws.js';
  import Dashboard from './pages/Dashboard.svelte';
  import DeviceDetail from './pages/DeviceDetail.svelte';
  import PendingDevices from './pages/PendingDevices.svelte';
  import Notifications from './pages/Notifications.svelte';
  import Login from './pages/Login.svelte';
  import Users from './pages/Users.svelte';
  import Firmware from './pages/Firmware.svelte';

  let currentRoute = '/';
  let routeParams = {};
  let booting = true;

  const unsub = route.subscribe(r => {
    currentRoute = r;
    routeParams = parseRoute(r);
  });

  function parseRoute(r) {
    // #/device/F27FCD
    const match = r.match(/^\/device\/(.+)$/);
    if (match) return { page: 'device', id: match[1] };
    if (r === '/pending') return { page: 'pending' };
    if (r === '/notifications') return { page: 'notifications' };
    if (r === '/users') return { page: 'users' };
    if (r === '/firmware') return { page: 'firmware' };
    return { page: 'dashboard' };
  }

  async function handleLogout() {
    await logout();
    disconnect();
    navigate('/');
  }

  onMount(async () => {
    // Check if backend has auth enabled
    const enabled = await checkAuthEnabled();
    if (enabled) {
      // Try to restore session from refresh token
      const restored = await restoreSession();
      if (!restored) {
        booting = false;
        return; // Show login page
      }
    }
    booting = false;
    connect();
  });

  // Reconnect WS when user logs in
  $: if ($isAuthenticated && !booting) {
    reconnect();
  }

  onDestroy(() => {
    disconnect();
    unsub();
  });
</script>

{#if booting}
  <div class="boot">Loading...</div>
{:else if $authEnabled && !$isAuthenticated}
  <Login />
{:else}
  <div class="app">
    <nav class="nav">
      <a href="#/" class="nav-brand">ModESP Cloud</a>
      <div class="nav-links">
        <a href="#/" class:active={routeParams.page === 'dashboard'}>Dashboard</a>
        <a href="#/pending" class:active={routeParams.page === 'pending'}>Pending</a>
        <a href="#/notifications" class:active={routeParams.page === 'notifications'}>Notifications</a>
        {#if !$authEnabled || $authUser?.role === 'admin'}
          <a href="#/firmware" class:active={routeParams.page === 'firmware'}>Firmware</a>
        {/if}
        {#if $authEnabled && $authUser?.role === 'admin'}
          <a href="#/users" class:active={routeParams.page === 'users'}>Users</a>
        {/if}
      </div>
      {#if $authEnabled && $authUser}
        <div class="nav-user">
          <span class="user-email">{$authUser.email}</span>
          <button class="btn-logout" on:click={handleLogout}>Logout</button>
        </div>
      {/if}
    </nav>

    <main class="main">
      {#if routeParams.page === 'device'}
        <DeviceDetail deviceId={routeParams.id} />
      {:else if routeParams.page === 'pending'}
        <PendingDevices />
      {:else if routeParams.page === 'notifications'}
        <Notifications />
      {:else if routeParams.page === 'users'}
        <Users />
      {:else if routeParams.page === 'firmware'}
        <Firmware />
      {:else}
        <Dashboard />
      {/if}
    </main>
  </div>
{/if}

<style>
  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f6fa;
    color: #2d3436;
    line-height: 1.5;
  }

  .boot {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    color: #636e72;
    font-size: 1.1rem;
  }

  .app {
    min-height: 100vh;
  }

  .nav {
    background: #2d3436;
    color: white;
    padding: 0 1.5rem;
    display: flex;
    align-items: center;
    height: 56px;
    gap: 2rem;
  }

  .nav-brand {
    font-weight: 700;
    font-size: 1.1rem;
    color: #00b894;
    text-decoration: none;
  }

  .nav-links {
    display: flex;
    gap: 1rem;
    flex: 1;
  }

  .nav-links a {
    color: #b2bec3;
    text-decoration: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.9rem;
    transition: color 0.2s;
  }

  .nav-links a:hover,
  .nav-links a.active {
    color: white;
  }

  .nav-user {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-left: auto;
  }

  .user-email {
    color: #b2bec3;
    font-size: 0.8rem;
  }

  .btn-logout {
    background: none;
    border: 1px solid #636e72;
    color: #b2bec3;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-logout:hover {
    border-color: #e17055;
    color: #e17055;
  }

  .main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem;
  }
</style>
