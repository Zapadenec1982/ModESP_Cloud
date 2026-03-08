<script>
  import { wsConnected, sidebarOpen } from '../../lib/stores.js'
  import Icon from '../ui/Icon.svelte'

  export let title = 'ModESP Cloud'

  function toggleSidebar() {
    sidebarOpen.update(v => !v)
  }
</script>

<header class="mobile-header">
  <button class="hamburger" on:click={toggleSidebar} aria-label="Toggle menu">
    <Icon name="menu" size={20} />
  </button>

  <span class="title">{title}</span>

  <span class="status-dot" class:connected={$wsConnected} />
</header>

<style>
  .mobile-header {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--header-height);
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-default);
    align-items: center;
    padding: 0 var(--space-4);
    gap: var(--space-3);
    z-index: 50;
  }

  @media (max-width: 768px) {
    .mobile-header {
      display: flex;
    }
  }

  .hamburger {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hamburger:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .title {
    font-weight: 600;
    font-size: var(--text-lg);
    color: var(--accent-blue);
    flex: 1;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-offline);
    flex-shrink: 0;
  }
  .status-dot.connected {
    background: var(--status-online);
    box-shadow: 0 0 6px var(--status-online);
  }
</style>
