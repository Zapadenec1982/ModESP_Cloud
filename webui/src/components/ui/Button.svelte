<script>
  import Icon from './Icon.svelte'

  export let variant = 'primary' // primary | secondary | ghost | danger
  export let size = 'md'         // sm | md
  export let icon = null
  export let loading = false
  export let disabled = false
  export let type = 'button'
</script>

<button
  {type}
  class="btn btn-{variant} btn-{size}"
  class:loading
  disabled={disabled || loading}
  on:click
  {...$$restProps}
>
  {#if loading}
    <span class="spinner" />
  {:else if icon}
    <Icon name={icon} size={size === 'sm' ? 14 : 16} />
  {/if}
  {#if $$slots.default}
    <span class="label"><slot /></span>
  {/if}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
    line-height: 1;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-md {
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-base);
    height: 34px;
  }
  .btn-sm {
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    height: 28px;
  }

  .btn-primary {
    background: var(--accent-blue);
    color: var(--text-inverse);
  }
  .btn-primary:hover:not(:disabled) {
    background: #79c0ff;
  }

  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-default);
  }
  .btn-secondary:hover:not(:disabled) {
    background: var(--border-default);
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
  }
  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .btn-danger {
    background: var(--accent-red);
    color: #fff;
  }
  .btn-danger:hover:not(:disabled) {
    background: #ff7b72;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
