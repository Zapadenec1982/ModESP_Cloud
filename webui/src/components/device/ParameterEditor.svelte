<script>
  // The controller's writable parameters (audit item 6): every row says what
  // the parameter is called and what it does, what the controller last
  // reported (or that it has not reported it yet), and offers the control to
  // change it. The header explains the «received N of M» count — it was a
  // bare «7/49» — and lets a technician switch the protocol keys on.
  import { onMount } from 'svelte'
  import { sendCommand, requestDeviceState, getDeviceCommands } from '../../lib/api.js'
  import { loadMeta, groupByCategory, paramLabel } from '../../lib/meta.js'
  import { toast } from '../../lib/toast.js'
  import { t } from '../../lib/i18n.js'
  import { isAdmin } from '../../lib/stores.js'
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

  // The protocol keys (thermostat.setpoint…) are secondary: off by default,
  // remembered per browser once a technician switches them on
  const KEYS_PREF = 'modesp_param_keys'
  let showKeys = false
  try { showKeys = localStorage.getItem(KEYS_PREF) === '1' } catch { /* private mode */ }
  function toggleKeys() {
    showKeys = !showKeys
    try { localStorage.setItem(KEYS_PREF, showKeys ? '1' : '0') } catch { /* ignore */ }
  }

  // Command history (admin) — the audit rows behind GET /devices/:id/commands
  let showHistory = false
  let history = []
  let historyLoading = false

  $: dangerousKeys = new Set(groups.flatMap(g => g.params.filter(p => p.dangerous).map(p => p.key)))

  // How many parameters the controller has reported, of all it can take
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
    const dangerous = dangerousKeys.has(key)
    // Setpoint, protection limits, manual defrost, alarm reset: the backend
    // refuses these without confirm, and a click is not a decision.
    if (dangerous && !confirm($t('device.command_confirm', key, value))) return
    sendingKey = key
    try {
      await sendCommand(deviceId, key, value, { confirm: dangerous })
      toast.success($t('device.command_sent', paramLabel(key), value))
      if (showHistory) loadHistory()
    } catch (err) {
      toast.error($t('device.command_failed', err.message))
    } finally {
      sendingKey = null
    }
  }

  async function loadHistory() {
    historyLoading = true
    try {
      history = await getDeviceCommands(deviceId)
    } catch (err) {
      toast.error(err.message)
    } finally {
      historyLoading = false
    }
  }

  function toggleHistory() {
    showHistory = !showHistory
    if (showHistory) loadHistory()
  }

  async function handleRequestState() {
    requesting = true
    try {
      await requestDeviceState(deviceId)
      toast.info($t('device.state_requested'))
    } catch (err) {
      toast.error($t('device.state_request_failed', err.message))
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
        <span class="stat-text">
          {$t('device.param_received', liveCount, totalCount)}
          <span class="stat-hint" title={$t('device.param_received_hint')} aria-label={$t('device.param_received_hint')}>
            <Icon name="help-circle" size={14} />
          </span>
        </span>
        <span class="stat-sub">{$t('device.param_received_hint')}</span>
      </div>
      <div class="editor-actions">
        <button
          class="request-btn"
          on:click={handleRequestState}
          disabled={requesting}
          title={$t('device.read_device_hint')}
        >
          {#if requesting}
            <span class="spinner" />
          {:else}
            <Icon name="refresh" size={14} />
          {/if}
          <span>{$t('device.read_device')}</span>
        </button>
        <button class="request-btn" class:pressed={showKeys} on:click={toggleKeys} title={$t('device.param_keys_hint')} aria-pressed={showKeys}>
          <Icon name="hash" size={14} />
          <span>{$t('device.param_keys_toggle')}</span>
        </button>
        {#if $isAdmin}
          <button class="request-btn" on:click={toggleHistory} title={$t('device.command_history')} aria-pressed={showHistory}>
            <Icon name="clock" size={14} />
            <span>{$t('device.command_history')}</span>
          </button>
        {/if}
      </div>
    </div>

    {#if showHistory}
      <div class="history">
        {#if historyLoading}
          <Skeleton height="60px" />
        {:else if history.length === 0}
          <p class="history-empty">{$t('device.command_history_empty')}</p>
        {:else}
          {#each history as c (c.id)}
            <div class="history-row" class:dangerous={c.dangerous}>
              <span class="history-time">{new Date(c.created_at).toLocaleString()}</span>
              <span class="history-key"><span class="history-label">{paramLabel(c.key, $t)}</span> <span class="font-mono">{c.key} = {c.value}</span></span>
              <span class="history-user">{c.user_email}</span>
              {#if c.status_code >= 400}<span class="history-status">HTTP {c.status_code}</span>{/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <div class="groups">
      {#each groups as { cat, params }, i (cat)}
        <ParameterGroup
          category={cat}
          {params}
          {state}
          {sendingKey}
          {readonly}
          {showKeys}
          expanded={i === 0}
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
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    flex-wrap: wrap;
  }

  .editor-stats {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 280px;
  }

  .stat-text {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .stat-hint {
    display: inline-flex;
    color: var(--text-muted);
    cursor: help;
  }

  .stat-sub {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: 1.35;
    max-width: 60ch;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
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

  .request-btn.pressed {
    background: rgba(88, 166, 255, 0.2);
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
  .history {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-3);
    max-height: 240px;
    overflow-y: auto;
  }
  .history-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    border-bottom: 1px solid var(--border-muted);
    align-items: center;
  }
  .history-row:last-child { border-bottom: none; }
  .history-row.dangerous .history-key { color: var(--accent-orange, #f59e0b); }
  .history-time { color: var(--text-muted); white-space: nowrap; }
  .history-key { overflow: hidden; text-overflow: ellipsis; }
  .history-label { font-weight: 500; }
  .history-key .font-mono { color: var(--text-muted); }
  .history-user { color: var(--text-muted); }
  .history-status { color: var(--accent-red); }
  .history-empty { padding: var(--space-3); font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
</style>
