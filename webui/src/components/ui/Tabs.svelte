<script>
  export let tabs = []   // [{ id, label, icon? }]
  export let active = '' // currently selected tab id
</script>

<div class="tabs">
  {#each tabs as tab}
    <button
      class="tab"
      class:active={active === tab.id}
      on:click={() => active = tab.id}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--border-default);
    overflow-x: auto;
  }

  .tab {
    padding: var(--space-2) var(--space-4);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .tab:hover {
    color: var(--text-primary);
  }

  .tab.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
  }
</style>
