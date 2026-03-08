<script>
  import { location } from 'svelte-spa-router'
  import { authEnabled, authUser, sidebarCollapsed, sidebarOpen } from '../../lib/stores.js'
  import { logout } from '../../lib/api.js'
  import { disconnect } from '../../lib/ws.js'
  import Icon from '../ui/Icon.svelte'
  import ConnectionStatus from './ConnectionStatus.svelte'

  export let alarmCount = 0
  export let pendingCount = 0

  const navItems = [
    { section: 'MONITORING' },
    { path: '/',              icon: 'grid',     label: 'Dashboard' },
    { path: '/alarms',        icon: 'alert-triangle', label: 'Alarms', badge: () => alarmCount },
    { section: 'MANAGEMENT' },
    { path: '/pending',       icon: 'wifi',     label: 'Pending',  badge: () => pendingCount },
    { path: '/notifications', icon: 'bell',     label: 'Notifications' },
    { path: '/firmware',      icon: 'upload',   label: 'Firmware', admin: true },
    { section: 'ADMIN', admin: true },
    { path: '/users',         icon: 'users',    label: 'Users',    admin: true },
  ]

  function isActive(itemPath, currentPath) {
    if (itemPath === '/') return currentPath === '/' || currentPath === ''
    return currentPath.startsWith(itemPath)
  }

  function handleNav(path) {
    window.location.hash = '#' + path
    sidebarOpen.set(false)
  }

  async function handleLogout() {
    await logout()
    disconnect()
    window.location.hash = '#/'
  }

  function toggleCollapse() {
    sidebarCollapsed.update(v => !v)
  }

  function closeMobile() {
    sidebarOpen.set(false)
  }

  $: isAdmin = !$authEnabled || $authUser?.role === 'admin'
</script>

<!-- Mobile backdrop -->
{#if $sidebarOpen}
  <div class="backdrop" on:click={closeMobile} on:keydown={() => {}} />
{/if}

<aside class="sidebar" class:collapsed={$sidebarCollapsed} class:mobile-open={$sidebarOpen}>
  <!-- Brand -->
  <div class="brand">
    {#if !$sidebarCollapsed}
      <span class="brand-text">ModESP Cloud</span>
    {:else}
      <span class="brand-icon">M</span>
    {/if}
    <button class="collapse-btn" on:click={toggleCollapse} title="Toggle sidebar">
      <Icon name={$sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={16} />
    </button>
  </div>

  <!-- Navigation -->
  <nav class="nav">
    {#each navItems as item}
      {#if item.section}
        {#if !item.admin || isAdmin}
          {#if !$sidebarCollapsed}
            <div class="section-label">{item.section}</div>
          {:else}
            <div class="section-divider" />
          {/if}
        {/if}
      {:else if !item.admin || isAdmin}
        <button
          class="nav-item"
          class:active={isActive(item.path, $location)}
          on:click={() => handleNav(item.path)}
          title={$sidebarCollapsed ? item.label : ''}
        >
          <Icon name={item.icon} size={18} />
          {#if !$sidebarCollapsed}
            <span class="nav-label">{item.label}</span>
            {#if item.badge && item.badge() > 0}
              <span class="nav-badge">{item.badge()}</span>
            {/if}
          {/if}
        </button>
      {/if}
    {/each}
  </nav>

  <!-- Footer -->
  <div class="sidebar-footer">
    <ConnectionStatus compact={$sidebarCollapsed} />

    {#if $authEnabled && $authUser}
      <div class="user-section" class:compact={$sidebarCollapsed}>
        <Icon name="user" size={16} />
        {#if !$sidebarCollapsed}
          <span class="user-email truncate">{$authUser.email}</span>
          <button class="logout-btn" on:click={handleLogout} title="Sign Out">
            <Icon name="log-out" size={16} />
          </button>
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    z-index: 99;
  }

  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    z-index: 100;
    transition: width var(--transition-normal);
    overflow: hidden;
  }

  .sidebar.collapsed {
    width: var(--sidebar-collapsed);
  }

  /* Mobile: hidden by default, slides in when open */
  @media (max-width: 768px) {
    .sidebar {
      transform: translateX(-100%);
      transition: transform var(--transition-slow);
    }
    .sidebar.mobile-open {
      transform: translateX(0);
    }
    .sidebar.collapsed {
      width: var(--sidebar-width);
    }
    .collapse-btn { display: none; }
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4);
    height: 56px;
    border-bottom: 1px solid var(--border-muted);
    flex-shrink: 0;
  }

  .brand-text {
    font-weight: 700;
    font-size: var(--text-lg);
    color: var(--accent-blue);
    white-space: nowrap;
  }

  .brand-icon {
    font-weight: 700;
    font-size: var(--text-xl);
    color: var(--accent-blue);
    width: 28px;
    text-align: center;
  }

  .collapse-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
  }
  .collapse-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }

  .nav {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }

  .section-label {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: var(--space-3) var(--space-3) var(--space-1);
    white-space: nowrap;
  }

  .section-divider {
    height: 1px;
    background: var(--border-muted);
    margin: var(--space-2) var(--space-2);
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
    white-space: nowrap;
    border-left: 3px solid transparent;
  }

  .nav-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: rgba(88, 166, 255, 0.1);
    color: var(--accent-blue);
    border-left-color: var(--accent-blue);
  }

  .nav-label {
    flex: 1;
  }

  .nav-badge {
    background: var(--accent-red);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    min-width: 18px;
    text-align: center;
  }

  .sidebar-footer {
    border-top: 1px solid var(--border-muted);
    padding: var(--space-3);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .user-section {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    color: var(--text-secondary);
  }
  .user-section.compact {
    justify-content: center;
  }

  .user-email {
    flex: 1;
    font-size: var(--text-sm);
  }

  .logout-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
  }
  .logout-btn:hover {
    color: var(--accent-red);
  }
</style>
