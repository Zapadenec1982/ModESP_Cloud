<script>
  import Icon from './Icon.svelte'

  export let icon = 'info'
  export let title = ''
  export let message = ''
</script>

<div class="empty">
  <Icon name={icon} size={40} color="var(--text-muted)" />
  {#if title}
    <h3>{title}</h3>
  {/if}
  {#if message}
    <p>{message}</p>
  {/if}
  {#if $$slots.default}
    <div class="action">
      <slot />
    </div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-6);
    text-align: center;
    min-height: 200px;
  }
  h3 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-secondary);
  }
  p {
    font-size: var(--text-base);
    color: var(--text-muted);
    max-width: 320px;
  }
  .action {
    margin-top: var(--space-2);
  }
</style>
