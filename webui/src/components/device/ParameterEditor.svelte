<script>
  import { onMount } from 'svelte'
  import { sendCommand, requestDeviceState } from '../../lib/api.js'
  import { loadMeta, groupByCategory } from '../../lib/meta.js'
  import { toast } from '../../lib/toast.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'
  import ParameterGroup from './ParameterGroup.svelte'
  import Skeleton from '../ui/Skeleton.svelte'
  import EmptyState from '../ui/EmptyState.svelte'

  export let deviceId
  export let state = {}
  export let readonly = false

  let groups = []
  let loading = true
  let sendingKey = null
  let requesting = false

  // Count how many parameters have a live value
  $: paramKeys = groups.flatMap(g => g.params.map(p => p.key))
  $: liveCount = paramKeys.filter(k => state[k] !== undefined).length
  $: totalCount = paramKeys.length

  onMount(async () => {
    const meta = await loadMeta()
    if (Array.isArray(meta)) {
      const grouped = groupByCategory(meta)
      groups = [...grouped.entries()].map(([cat, params]) => ({ cat, params }))
    }
    loading = false
  })

  async function handleSend(e) {
    const { key, value } = e.detail
    sendingKey = key
    try {
      await sendCommand(deviceId, key, value)
      toast.success(`Sent ${key} = ${value}`)
    } catch (err) {
      toast.error(`Failed: ${err.message}`)
    } finally {
      sendingKey = null
    }
  }

  async function handleRequestState() {
    requesting = true
    try {
      await requestDeviceState(deviceId)
      toast.info('Requested full state from device')
    } catch (err) {
      toast.error(`Request failed: ${err.message}`)
    } finally {
      requesting = false
    }
  }
</script>

<div class="param-editor">
  {#if loading}
    <Skeleton height="200px" />
  {:else if groups.length === 0}
    <EmptyState
      icon="settings"
      title={$t('device.no_params')}
      message={$t('device.no_params_hint')}
    />
  {:else}
    <div class="editor-header">
      <div class="editor-stats">
        <span class="stat-label">{$t('device.param_count')}</span>
        <span class="stat-value">{liveCount}<span class="stat-total">/{totalCount}</span></span>
      </div>
      <button
        class="request-btn"
        on:click={handleRequestState}
        disabled={requesting}
        title="Request full state dump from device via MQTT"
      >
        {#if requesting}
          <span class="spinner" />
        {:else}
          <Icon name="refresh" size={14} />
        {/if}
        <span>{$t('device.read_device')}</span>
      </button>
    </div>

    <div class="groups">
      {#each groups as { cat, params }}
        <ParameterGroup
          category={cat}
          {params}
          {state}
          {sendingKey}
          {readonly}
          on:send={handleSend}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .param-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) 0;
  }

  .editor-stats {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .stat-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .stat-value {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--accent-blue);
    font-family: var(--font-mono);
  }

  .stat-total {
    font-weight: 400;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .request-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    background: rgba(88, 166, 255, 0.08);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .request-btn:hover:not(:disabled) {
    background: rgba(88, 166, 255, 0.15);
    border-color: var(--accent-blue);
  }

  .request-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-default);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  @media (max-width: 640px) {
    .editor-header {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
  }
</style>
