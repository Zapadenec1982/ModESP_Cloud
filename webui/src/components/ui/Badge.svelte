<script>
  export let variant = 'neutral' // success | warning | danger | info | neutral
  export let size = 'md'         // sm | md
  export let pulse = false
</script>

<span class="badge badge-{variant} badge-{size}" class:pulse>
  <slot />
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 500;
    border-radius: var(--radius-full);
    white-space: nowrap;
    line-height: 1;
  }

  .badge-md {
    padding: 3px 10px;
    font-size: var(--text-sm);
  }
  .badge-sm {
    padding: 2px 7px;
    font-size: var(--text-xs);
  }

  .badge-success {
    background: rgba(63, 185, 80, 0.15);
    color: var(--accent-green);
  }
  .badge-warning {
    background: rgba(210, 153, 34, 0.15);
    color: var(--accent-yellow);
  }
  .badge-danger {
    background: rgba(248, 81, 73, 0.15);
    color: var(--accent-red);
  }
  .badge-info {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent-blue);
  }
  .badge-neutral {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .pulse {
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
