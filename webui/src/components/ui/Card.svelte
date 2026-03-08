<script>
  export let padding = true
  export let hover = false
  export let accent = null // null | 'green' | 'yellow' | 'red' | 'gray'
</script>

<div
  class="card"
  class:card-hover={hover}
  class:card-padded={padding}
  class:accent-green={accent === 'green'}
  class:accent-yellow={accent === 'yellow'}
  class:accent-red={accent === 'red'}
  class:accent-gray={accent === 'gray'}
  on:click
>
  {#if $$slots.header}
    <div class="card-header">
      <slot name="header" />
    </div>
  {/if}
  <slot />
  {#if $$slots.footer}
    <div class="card-footer">
      <slot name="footer" />
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
    position: relative;
  }

  .card-padded {
    padding: var(--space-4);
  }

  .card-hover {
    cursor: pointer;
    transition: border-color var(--transition-fast), transform var(--transition-fast);
  }
  .card-hover:hover {
    border-color: var(--text-muted);
    transform: translateY(-1px);
  }

  /* Left accent stripe */
  .accent-green  { border-left: 3px solid var(--accent-green); }
  .accent-yellow { border-left: 3px solid var(--accent-yellow); }
  .accent-red    { border-left: 3px solid var(--accent-red); }
  .accent-gray   { border-left: 3px solid var(--text-muted); }

  .card-header {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    font-weight: 600;
    font-size: var(--text-base);
  }
  .card-padded .card-header {
    margin: calc(-1 * var(--space-4));
    margin-bottom: var(--space-4);
    padding: var(--space-3) var(--space-4);
  }

  .card-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }
  .card-padded .card-footer {
    margin: var(--space-4) calc(-1 * var(--space-4)) calc(-1 * var(--space-4));
    padding: var(--space-3) var(--space-4);
  }
</style>
