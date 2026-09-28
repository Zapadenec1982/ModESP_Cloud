<script>
  // One writable parameter of the controller (audit item 6): what it is
  // called and what it does, what the controller last reported, and the
  // control to change it. A mode parameter (fan mode, defrost type, night
  // mode…) is a list of named choices, never a bare number; a switch is a
  // toggle; everything else a number with its unit. The technical key stays
  // available to a technician behind the editor's «Технічні ключі» switch.
  import { createEventDispatcher } from 'svelte'
  import { paramLabel, paramDescription, paramUnit, inputType, paramOptions, formatParamValue, optionLabel } from '../../lib/meta.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'

  export let param   // metadata entry
  export let value    // current live value
  export let sending = false
  export let readonly = false
  export let showKey = false

  const dispatch = createEventDispatcher()

  let editValue = value
  let dirty = false

  $: {
    // Reset editValue when live value changes and not dirty
    if (!dirty && value !== undefined) {
      editValue = param.type === 'bool' ? !!value : value
    }
  }

  // $t in the dependencies: the texts re-translate when the language changes
  $: type = inputType(param, $t)
  $: unit = paramUnit(param.key, $t)
  $: label = paramLabel(param.key, $t)
  $: description = paramDescription(param.key, $t)
  $: options = type === 'select' ? paramOptions(param, $t) : []
  $: live = formatParamValue(param, value, $t)
  // The choice's number stays beside its name, for the technician and the manual
  $: liveNumber = live !== null && optionLabel(param.key, value, $t) ? String(value) : ''

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
</script>

<div class="param-control" class:dangerous={param.dangerous}>
  <div class="param-info">
    <span class="param-label">
      {label}
      {#if param.dangerous}
        <span class="danger-mark" title={$t('device.param_dangerous')} aria-label={$t('device.param_dangerous')}>
          <Icon name="alert-triangle" size={12} />
        </span>
      {/if}
    </span>
    {#if description}
      <span class="param-desc">{description}</span>
    {/if}
    {#if showKey}
      <span class="param-key font-mono">{param.key}</span>
    {/if}
  </div>

  <div class="param-live">
    {#if live !== null}
      <span class="live-value" class:font-mono={!liveNumber} title={liveNumber ? `${param.key} = ${liveNumber}` : ''}>
        {live}{#if liveNumber}<span class="live-code font-mono"> ({liveNumber})</span>{/if}
      </span>
      {#if unit && !liveNumber}
        <span class="live-unit">{unit}</span>
      {/if}
    {:else}
      <span class="live-value no-data" title={$t('device.param_no_value')} aria-label={$t('device.param_no_value')}>—</span>
    {/if}
  </div>

  <div class="param-input">
    {#if type === 'toggle'}
      <button
        class="toggle"
        class:on={editValue}
        on:click={handleToggle}
        disabled={sending || readonly}
        role="switch"
        aria-checked={!!editValue}
        aria-label={label}
      >
        <span class="toggle-thumb" />
      </button>
    {:else if type === 'select'}
      <select
        bind:value={editValue}
        on:change={handleInput}
        class="mode-select"
        disabled={sending || readonly}
        aria-label={label}
      >
        {#if editValue === undefined || editValue === null}
          <option value={undefined} disabled>—</option>
        {/if}
        {#each options as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
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
        aria-label={label}
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
        title={$t('device.send')}
        aria-label={$t('device.send')}
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
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: 500;
  }

  .danger-mark {
    display: inline-flex;
    color: var(--accent-orange, #f59e0b);
  }

  .param-desc {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: 1.35;
  }

  .param-key {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .param-live {
    min-width: 72px;
    max-width: 200px;
    text-align: right;
    flex-shrink: 0;
  }

  .live-value {
    font-size: var(--text-sm);
    color: var(--accent-blue);
  }

  .live-code {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .live-value.no-data {
    color: var(--text-muted);
    cursor: help;
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

  .num-input, .mode-select {
    padding: var(--space-1) var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .num-input {
    width: 80px;
    text-align: right;
  }

  .mode-select {
    max-width: 220px;
    font-family: var(--font-sans);
  }

  .num-input:focus, .mode-select:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input-unit {
    font-size: var(--text-xs);
    color: var(--text-muted);
    min-width: 20px;
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
    .param-control { flex-wrap: wrap; }
    .param-info { flex-basis: 100%; }
    .param-key { display: none; }
    .param-live { min-width: 50px; margin-left: auto; }
    .num-input { width: 64px; }
    .mode-select { max-width: 160px; }
  }
</style>
