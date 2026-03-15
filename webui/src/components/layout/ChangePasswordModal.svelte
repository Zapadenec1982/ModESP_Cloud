<script>
  import { createEventDispatcher } from 'svelte'
  import { changePassword } from '../../lib/api.js'
  import { t } from '../../lib/i18n.js'
  import { toast } from '../../lib/toast.js'
  import Icon from '../ui/Icon.svelte'

  export let show = false

  const dispatch = createEventDispatcher()

  let currentPassword = ''
  let newPassword = ''
  let confirmPassword = ''
  let saving = false
  let hibpCount = 0
  let hibpChecking = false
  let hibpChecked = false

  $: passwordTooShort = newPassword.length > 0 && newPassword.length < 15
  $: passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  $: canSubmit = currentPassword && newPassword.length >= 15 && newPassword === confirmPassword && !saving

  function close() {
    currentPassword = ''
    newPassword = ''
    confirmPassword = ''
    hibpCount = 0
    hibpChecked = false
    show = false
    dispatch('close')
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') close()
  }

  // HIBP k-anonymity check (client-side, CORS enabled)
  async function checkHIBP(password) {
    try {
      hibpChecking = true
      const encoder = new TextEncoder()
      const data = encoder.encode(password)
      const hashBuffer = await crypto.subtle.digest('SHA-1', data)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const sha1 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
      const prefix = sha1.slice(0, 5)
      const suffix = sha1.slice(5)

      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' }
      })
      const text = await res.text()
      const match = text.split('\r\n').find(line => line.startsWith(suffix))
      hibpCount = match ? parseInt(match.split(':')[1], 10) : 0
    } catch {
      hibpCount = 0  // Fail-open
    } finally {
      hibpChecking = false
      hibpChecked = true
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return

    // Check HIBP before submitting
    if (!hibpChecked) {
      await checkHIBP(newPassword)
      if (hibpCount > 0) return  // Show warning, user can re-submit
    }

    saving = true
    try {
      await changePassword(currentPassword, newPassword)
      toast.success($t('password.password_changed'))
      close()
    } catch (e) {
      if (e.status === 400 && e.body?.message?.includes('password')) {
        toast.error($t('password.wrong_current'))
      } else {
        toast.error(e.message)
      }
    } finally {
      saving = false
    }
  }

  // Reset HIBP check when password changes
  $: if (newPassword) {
    hibpChecked = false
    hibpCount = 0
  }
</script>

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={close}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation on:keydown={handleKeydown}>
      <div class="modal-header">
        <h2>{$t('password.change_password')}</h2>
        <button class="modal-close" on:click={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="cp-current">{$t('password.current_password')}</label>
          <input id="cp-current" type="password" bind:value={currentPassword}
            autocomplete="current-password" />
        </div>
        <div class="form-group">
          <label for="cp-new">{$t('password.new_password')}</label>
          <input id="cp-new" type="password" bind:value={newPassword}
            autocomplete="new-password" />
          {#if passwordTooShort}
            <span class="hint error">{$t('password.min_length')}</span>
          {/if}
        </div>
        <div class="form-group">
          <label for="cp-confirm">{$t('password.confirm_password')}</label>
          <input id="cp-confirm" type="password" bind:value={confirmPassword}
            autocomplete="new-password" />
          {#if passwordsMismatch}
            <span class="hint error">{$t('password.passwords_mismatch')}</span>
          {/if}
        </div>

        <!-- HIBP Warning -->
        {#if hibpChecked && hibpCount > 0}
          <div class="hibp-warning">
            <Icon name="alert-triangle" size={16} />
            <span>{$t('password.password_breached').replace('{0}', hibpCount.toLocaleString())}</span>
          </div>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={close} disabled={saving}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-primary" on:click={handleSubmit}
          disabled={!canSubmit || hibpChecking}>
          {#if hibpChecking}
            {$t('common.loading')}
          {:else if saving}
            {$t('common.loading')}
          {:else if hibpChecked && hibpCount > 0}
            {$t('password.use_anyway')}
          {:else}
            {$t('common.save')}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 420px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-group label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-group input {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
    transition: border-color var(--transition-fast);
  }

  .form-group input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint.error {
    color: var(--accent-red, #ef4444);
  }

  .hibp-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--accent-amber, #fbbf24);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    border: 1px solid transparent;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-default);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
