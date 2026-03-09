<script>
  import { location } from 'svelte-spa-router'
  import { authEnabled, authUser, sidebarCollapsed, sidebarOpen, currentTenant, availableTenants, hasMultipleTenants } from '../../lib/stores.js'
  import { logout, switchTenant } from '../../lib/api.js'
  import { disconnect } from '../../lib/ws.js'
  import { t } from '../../lib/i18n.js'
  import { toast } from '../../lib/toast.js'
  import Icon from '../ui/Icon.svelte'
  import ConnectionStatus from './ConnectionStatus.svelte'
  import SettingsMenu from './SettingsMenu.svelte'

  export let alarmCount = 0
  export let pendingCount = 0

  $: navItems = [
    { section: $t('nav.sections.monitoring') },
    { path: '/',              icon: 'grid',     label: $t('nav.dashboard') },
    { path: '/alarms',        icon: 'alert-triangle', label: $t('nav.alarms'), badge: () => alarmCount },
    { section: $t('nav.sections.management') },
    { path: '/pending',       icon: 'wifi',     label: $t('nav.pending'),  badge: () => pendingCount },
    { path: '/notifications', icon: 'bell',     label: $t('nav.notifications') },
    { path: '/firmware',      icon: 'upload',   label: $t('nav.firmware'), admin: true },
    { section: $t('nav.sections.admin'), admin: true },
    { path: '/tenants',       icon: 'layers',   label: $t('nav.tenants'),  admin: true },
    { path: '/users',         icon: 'users',    label: $t('nav.users'),    admin: true },
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

  $: isAdmin = !$authEnabled || $authUser?.role === 'admin' || $authUser?.role === 'superadmin'

  // Tenant switcher
  let tenantDropdownOpen = false

  function toggleTenantDropdown() {
    tenantDropdownOpen = !tenantDropdownOpen
  }

  async function handleSwitchTenant(tenantId) {
    tenantDropdownOpen = false
    if (tenantId === $currentTenant?.id) return
    try {
      await switchTenant(tenantId)
      toast.success($t('auth.switch_workspace') + ': ' + ($currentTenant?.name || ''))
      // Reload to clean all state (devices, alarms, etc.)
      window.location.reload()
    } catch (e) {
      toast.error(e.message || 'Failed to switch tenant')
    }
  }
</script>

<!-- Mobile backdrop -->
{#if $sidebarOpen}
  <div class="backdrop" role="presentation" on:click={closeMobile} on:keydown={() => {}} />
{/if}

<aside class="sidebar" class:collapsed={$sidebarCollapsed} class:mobile-open={$sidebarOpen}>
  <!-- Brand -->
  <div class="brand">
    {#if !$sidebarCollapsed}
      <span class="brand-text">ModESP Cloud</span>
    {:else}
      <span class="brand-icon">M</span>
    {/if}
    <button class="collapse-btn" on:click={toggleCollapse} title="Toggle sidebar" aria-expanded={!$sidebarCollapsed} aria-label="Toggle sidebar">
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
          aria-current={isActive(item.path, $location) ? 'page' : undefined}
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
    <SettingsMenu compact={$sidebarCollapsed} />

    {#if $currentTenant}
      <div class="tenant-section" class:compact={$sidebarCollapsed}>
        <span class="tenant-avatar-sm">{$currentTenant.name.charAt(0).toUpperCase()}</span>
        {#if !$sidebarCollapsed}
          <span class="tenant-name-text truncate">{$currentTenant.name}</span>
          {#if $hasMultipleTenants}
            <button class="tenant-switch-btn" on:click={toggleTenantDropdown} title={$t('auth.switch_workspace')}>
              <Icon name={tenantDropdownOpen ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
          {/if}
        {/if}
      </div>
      {#if tenantDropdownOpen && $hasMultipleTenants}
        <div class="tenant-dropdown">
          {#each $availableTenants as tenant}
            <button
              class="tenant-option"
              class:active={tenant.id === $currentTenant?.id}
              on:click={() => handleSwitchTenant(tenant.id)}
            >
              <span class="tenant-avatar-xs">{tenant.name.charAt(0).toUpperCase()}</span>
              <div class="tenant-option-info">
                <span class="tenant-option-name">{tenant.name}</span>
                <span class="tenant-option-slug">{tenant.slug}</span>
              </div>
              {#if tenant.id === $currentTenant?.id}
                <span class="tenant-current-badge">{$t('auth.current_workspace')}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}

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
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-muted);
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
    background: rgba(74, 158, 255, 0.08);
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

  /* Tenant switcher */
  .tenant-section {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-1);
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-muted);
    margin-bottom: var(--space-1);
  }
  .tenant-section.compact {
    justify-content: center;
  }

  .tenant-avatar-sm {
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm);
    background: var(--accent-blue);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: var(--text-xs);
    flex-shrink: 0;
  }

  .tenant-name-text {
    flex: 1;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .tenant-switch-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    border-radius: var(--radius-sm);
    display: flex;
  }
  .tenant-switch-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }

  .tenant-dropdown {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-1);
    max-height: 200px;
    overflow-y: auto;
  }

  .tenant-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    color: var(--text-secondary);
    transition: background var(--transition-fast);
    width: 100%;
  }
  .tenant-option:hover {
    background: var(--bg-secondary);
  }
  .tenant-option.active {
    background: rgba(88, 166, 255, 0.08);
  }

  .tenant-avatar-xs {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    background: var(--accent-blue);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 10px;
    flex-shrink: 0;
  }

  .tenant-option-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tenant-option-name {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .tenant-option-slug {
    font-size: 10px;
    color: var(--text-muted);
  }

  .tenant-current-badge {
    font-size: 10px;
    color: var(--accent-blue);
    font-weight: 600;
    white-space: nowrap;
  }
</style>
