<script>
  import { onMount, onDestroy } from 'svelte';
  import { route, navigate } from './lib/stores.js';
  import { connect, disconnect } from './lib/ws.js';
  import Dashboard from './pages/Dashboard.svelte';
  import DeviceDetail from './pages/DeviceDetail.svelte';
  import PendingDevices from './pages/PendingDevices.svelte';

  let currentRoute = '/';
  let routeParams = {};

  const unsub = route.subscribe(r => {
    currentRoute = r;
    routeParams = parseRoute(r);
  });

  function parseRoute(r) {
    // #/device/F27FCD
    const match = r.match(/^\/device\/(.+)$/);
    if (match) return { page: 'device', id: match[1] };
    if (r === '/pending') return { page: 'pending' };
    return { page: 'dashboard' };
  }

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    disconnect();
    unsub();
  });
</script>

<div class="app">
  <nav class="nav">
    <a href="#/" class="nav-brand">ModESP Cloud</a>
    <div class="nav-links">
      <a href="#/" class:active={routeParams.page === 'dashboard'}>Dashboard</a>
      <a href="#/pending" class:active={routeParams.page === 'pending'}>Pending</a>
    </div>
  </nav>

  <main class="main">
    {#if routeParams.page === 'device'}
      <DeviceDetail deviceId={routeParams.id} />
    {:else if routeParams.page === 'pending'}
      <PendingDevices />
    {:else}
      <Dashboard />
    {/if}
  </main>
</div>

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

  .main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem;
  }
</style>
