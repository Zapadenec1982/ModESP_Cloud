<script>
  import { createEventDispatcher } from 'svelte'
  import { categoryLabel } from '../../lib/meta.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'
  import ParameterControl from './ParameterControl.svelte'

  export let category = ''
  export let params = []
  export let state = {}
  export let sendingKey = null
  export let readonly = false
  export let showKeys = false
  export let expanded = false

  const dispatch = createEventDispatcher()

  // How many of the group's parameters the controller has reported
  $: received = params.filter(p => state[p.key] !== undefined).length

  function toggle() {
    expanded = !expanded
  }

  function handleSend(e) {
    dispatch('send', e.detail)
  }
</script>

<div class="group">
  <button class="group-header" on:click={toggle} aria-expanded={expanded}>
    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} />
    <span class="group-title">{categoryLabel(category, $t)}</span>
    <span class="group-count" title={$t('device.param_received_hint')}>{$t('device.param_group_received', received, params.length)}</span>
  </button>

  {#if expanded}
    <div class="group-body">
      {#each params as param (param.key)}
        <ParameterControl
          {param}
          value={state[param.key]}
          sending={sendingKey === param.key}
          {readonly}
          showKey={showKeys}
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
    color: var(--text-secondary);
    font-weight: 400;
    background: var(--bg-surface);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }

  .group-body {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-surface);
  }
</style>
