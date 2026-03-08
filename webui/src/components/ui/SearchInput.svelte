<script>
  import Icon from './Icon.svelte'

  export let value = ''
  export let placeholder = 'Search...'

  let inputEl

  function clear() {
    value = ''
    inputEl?.focus()
  }
</script>

<div class="search">
  <Icon name="search" size={16} />
  <input
    bind:this={inputEl}
    bind:value
    {placeholder}
    type="text"
    class="search-input"
  />
  {#if value}
    <button class="clear-btn" on:click={clear}>
      <Icon name="x" size={14} />
    </button>
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    color: var(--text-muted);
    transition: border-color var(--transition-fast);
  }

  .search:focus-within {
    border-color: var(--accent-blue);
    color: var(--text-secondary);
  }

  .search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    border-radius: var(--radius-sm);
  }

  .clear-btn:hover {
    color: var(--text-secondary);
  }
</style>
