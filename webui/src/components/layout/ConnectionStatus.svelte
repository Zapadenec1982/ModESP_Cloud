<script>
  import { wsConnected } from '../../lib/stores.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'

  export let compact = false
</script>

<div class="connection" class:compact class:connected={$wsConnected}>
  <span class="dot" />
  {#if !compact}
    <span class="label">{$wsConnected ? $t('connection.connected') : $t('connection.disconnected')}</span>
  {/if}
</div>

<style>
  .connection {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    color: var(--text-muted);
    transition: all var(--transition-fast);
  }

  .connection.compact {
    justify-content: center;
    padding: var(--space-1);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-offline);
    flex-shrink: 0;
    transition: background var(--transition-fast);
  }

  .connection.connected .dot {
    background: var(--status-online);
    box-shadow: 0 0 6px var(--status-online);
  }

  .connection.connected {
    color: var(--text-secondary);
  }

  .label {
    white-space: nowrap;
  }
</style>
