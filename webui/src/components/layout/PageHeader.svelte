<script>
  export let title = ''
  export let subtitle = ''
</script>

<div class="page-header">
  <div class="page-header-text">
    <h1 class="page-title">{title}</h1>
    {#if subtitle}
      <p class="page-subtitle">{subtitle}</p>
    {/if}
  </div>
  <div class="page-header-actions">
    <slot />
  </div>
</div>

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .page-title {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-top: var(--space-1);
  }

  .page-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  @media (max-width: 768px) {
    .page-header {
      flex-direction: column;
      gap: var(--space-3);
    }
  }
</style>
