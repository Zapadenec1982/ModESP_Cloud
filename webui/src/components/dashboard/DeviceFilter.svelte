<script>
  import { createEventDispatcher } from 'svelte'
  import SearchInput from '../ui/SearchInput.svelte'
  import Icon from '../ui/Icon.svelte'

  export let search = ''
  export let filter = 'all'   // all | online | offline | alarm
  export let view = 'grid'    // grid | list

  const dispatch = createEventDispatcher()

  const filters = [
    { value: 'all',     label: 'All' },
    { value: 'online',  label: 'Online' },
    { value: 'offline', label: 'Offline' },
    { value: 'alarm',   label: 'Alarm' },
  ]

  function setFilter(f) {
    filter = f
    dispatch('change')
  }

  function toggleView() {
    view = view === 'grid' ? 'list' : 'grid'
    dispatch('change')
  }
</script>

<div class="filter-bar">
  <div class="search-wrap">
    <SearchInput bind:value={search} placeholder="Search devices..." />
  </div>

  <div class="pills">
    {#each filters as f}
      <button
        class="pill"
        class:active={filter === f.value}
        on:click={() => setFilter(f.value)}
      >
        {f.label}
      </button>
    {/each}
  </div>

  <button class="view-toggle" on:click={toggleView} title={view === 'grid' ? 'List view' : 'Grid view'}>
    <Icon name={view === 'grid' ? 'list' : 'grid'} size={16} />
  </button>
</div>

<style>
  .filter-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .search-wrap {
    flex: 1;
    min-width: 200px;
  }

  .pills {
    display: flex;
    gap: var(--space-1);
  }

  .pill {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .pill:hover {
    border-color: var(--text-muted);
    color: var(--text-primary);
  }

  .pill.active {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #fff;
  }

  .view-toggle {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    padding: var(--space-2);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
  }

  .view-toggle:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .filter-bar {
      flex-direction: column;
      align-items: stretch;
    }
    .search-wrap {
      min-width: unset;
    }
    .pills {
      overflow-x: auto;
    }
  }
</style>
