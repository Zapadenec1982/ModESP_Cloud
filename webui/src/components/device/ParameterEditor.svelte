<script>
  import { onMount } from 'svelte'
  import { sendCommand } from '../../lib/api.js'
  import { loadMeta, groupByCategory } from '../../lib/meta.js'
  import { toast } from '../../lib/toast.js'
  import ParameterGroup from './ParameterGroup.svelte'
  import Skeleton from '../ui/Skeleton.svelte'
  import EmptyState from '../ui/EmptyState.svelte'

  export let deviceId
  export let state = {}

  let groups = []
  let loading = true
  let sendingKey = null

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
</script>

<div class="param-editor">
  {#if loading}
    <Skeleton height="200px" />
  {:else if groups.length === 0}
    <EmptyState
      icon="settings"
      title="No parameters available"
      message="Parameter metadata not loaded"
    />
  {:else}
    <div class="groups">
      {#each groups as { cat, params }}
        <ParameterGroup
          category={cat}
          {params}
          {state}
          {sendingKey}
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

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
</style>
