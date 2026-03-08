<script>
  import { createEventDispatcher } from 'svelte'
  import { categoryLabel } from '../../lib/meta.js'
  import Icon from '../ui/Icon.svelte'
  import ParameterControl from './ParameterControl.svelte'

  export let category = ''
  export let params = []
  export let state = {}
  export let sendingKey = null
  export let readonly = false

  const dispatch = createEventDispatcher()

  let expanded = true

  function toggle() {
    expanded = !expanded
  }

  function handleSend(e) {
    dispatch('send', e.detail)
  }
</script>

<div class="group">
  <button class="group-header" on:click={toggle}>
    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} />
    <span class="group-title">{categoryLabel(category)}</span>
    <span class="group-count">{params.length}</span>
  </button>

  {#if expanded}
    <div class="group-body">
      {#each params as param (param.key)}
        <ParameterControl
          {param}
          value={state[param.key]}
          sending={sendingKey === param.key}
          {readonly}
          on:send={handleSend}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .group {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: var(--bg-tertiary);
    border: none;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .group-header:hover {
    background: var(--border-muted);
  }

  .group-title {
    flex: 1;
  }

  .group-count {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 400;
    background: var(--bg-surface);
    padding: 1px 6px;
    border-radius: var(--radius-full);
  }

  .group-body {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-surface);
  }
</style>
