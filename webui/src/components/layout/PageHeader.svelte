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
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    animation: fade-in 0.25s ease-out;
  }

  .page-title {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin-top: var(--space-1);
    letter-spacing: 0.02em;
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
