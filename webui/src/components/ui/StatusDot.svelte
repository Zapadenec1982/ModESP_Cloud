<script>
  export let status = 'offline' // online | offline | alarm | warning
  export let size = 'md' // sm | md
</script>

<span class="dot dot-{status}" class:sm={size === 'sm'} title={status}>
  {#if status === 'online' || status === 'alarm'}
    <span class="ring" />
  {/if}
</span>

<style>
  .dot {
    position: relative;
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.sm {
    width: 8px;
    height: 8px;
  }

  .dot-online {
    background: var(--status-online);
  }
  .dot-offline {
    background: var(--status-offline);
  }
  .dot-alarm {
    background: var(--status-alarm);
  }
  .dot-warning {
    background: var(--status-warning);
  }

  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    animation: pulse-ring 2s ease-out infinite;
  }

  .dot-online .ring {
    border: 2px solid var(--status-online);
  }
  .dot-alarm .ring {
    border: 2px solid var(--status-alarm);
  }

  @keyframes pulse-ring {
    0% { transform: scale(0.8); opacity: 1; }
    100% { transform: scale(2.2); opacity: 0; }
  }
</style>
