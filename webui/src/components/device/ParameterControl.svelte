<script>
  import { createEventDispatcher } from 'svelte'
  import { paramLabel, paramUnit, inputType } from '../../lib/meta.js'
  import Icon from '../ui/Icon.svelte'

  export let param   // metadata entry
  export let value    // current live value
  export let sending = false
  export let readonly = false

  const dispatch = createEventDispatcher()

  let editValue = value
  let dirty = false

  $: {
    // Reset editValue when live value changes and not dirty
    if (!dirty && value !== undefined) {
      editValue = param.type === 'bool' ? !!value : value
    }
  }

  $: type = inputType(param)
  $: unit = paramUnit(param.key)
  $: label = paramLabel(param.key)

  function handleInput() {
    dirty = true
  }

  function handleToggle() {
    editValue = !editValue
    dirty = true
    send()
  }

  function send() {
    let v = editValue
    if (param.type === 'bool') v = editValue ? true : false
    else if (param.type === 'float') v = parseFloat(v)
    else v = parseInt(v, 10)

    dispatch('send', { key: param.key, value: v })
    dirty = false
  }

  function reset() {
    editValue = value
    dirty = false
  }
</script>

<div class="param-control">
  <div class="param-info">
    <span class="param-label">{label}</span>
    <span class="param-key font-mono">{param.key}</span>
  </div>

  <div class="param-live">
    {#if value !== undefined}
      <span class="live-value font-mono">
        {param.type === 'bool' ? (value ? 'ON' : 'OFF') : value}
      </span>
      {#if unit}
        <span class="live-unit">{unit}</span>
      {/if}
    {:else}
      <span class="live-value no-data">--</span>
    {/if}
  </div>

  <div class="param-input">
    {#if type === 'toggle'}
      <button
        class="toggle"
        class:on={editValue}
        on:click={handleToggle}
        disabled={sending || readonly}
      >
        <span class="toggle-thumb" />
      </button>
    {:else}
      <input
        type="number"
        bind:value={editValue}
        on:input={handleInput}
        min={param.min}
        max={param.max}
        step={param.step}
        class="num-input font-mono"
        disabled={sending || readonly}
      />
      {#if unit}
        <span class="input-unit">{unit}</span>
      {/if}
    {/if}
  </div>

  <div class="param-actions">
    {#if type !== 'toggle'}
      <button
        class="send-btn"
        on:click={send}
        disabled={!dirty || sending || readonly}
        title="Send command"
      >
        {#if sending}
          <span class="spinner" />
        {:else}
          <Icon name="send" size={14} />
        {/if}
      </button>
    {/if}
  </div>
</div>

<style>
  .param-control {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-muted);
  }

  .param-control:last-child {
    border-bottom: none;
  }

  .param-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .param-label {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: 500;
  }

  .param-key {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .param-live {
    width: 60px;
    text-align: right;
    flex-shrink: 0;
  }

  .live-value {
    font-size: var(--text-sm);
    color: var(--accent-blue);
  }

  .live-value.no-data {
    color: var(--text-muted);
  }

  .live-unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-left: 2px;
  }

  .param-input {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .num-input {
    width: 80px;
    padding: var(--space-1) var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    text-align: right;
  }

  .num-input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input-unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
    width: 20px;
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    width: 36px;
    height: 20px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    cursor: pointer;
    transition: all var(--transition-fast);
    padding: 0;
  }

  .toggle.on {
    background: var(--accent-green);
    border-color: var(--accent-green);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: white;
    border-radius: 50%;
    transition: transform var(--transition-fast);
  }

  .toggle.on .toggle-thumb {
    transform: translateX(16px);
  }

  .param-actions {
    width: 32px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
  }

  .send-btn {
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--accent-blue);
    cursor: pointer;
    padding: 4px 6px;
    display: flex;
    transition: all var(--transition-fast);
  }

  .send-btn:hover:not(:disabled) {
    background: rgba(88, 166, 255, 0.1);
    border-color: var(--accent-blue);
  }

  .send-btn:disabled {
    opacity: 0.3;
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

  @media (max-width: 640px) {
    .param-key { display: none; }
    .param-live { width: 50px; }
    .num-input { width: 60px; }
  }
</style>
