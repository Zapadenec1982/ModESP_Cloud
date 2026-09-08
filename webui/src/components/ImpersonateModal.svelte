<script>
  // Support impersonation (plan epic 2.13): a superadmin signs in as a user of
  // an organisation. The reason is required — it goes into that organisation's
  // audit log next to who signed in and until when.
  import { startImpersonation } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import Button from './ui/Button.svelte'
  import Icon from './ui/Icon.svelte'

  export let show = false
  export let user = null      // { id, email, role }
  export let tenant = null    // { id, name } — optional, defaults to the user's home organisation

  let reason = ''
  let starting = false

  function close() {
    if (starting) return
    show = false
    reason = ''
  }

  async function start() {
    if (reason.trim().length < 3) {
      toast.error($t('impersonation.reason_required'))
      return
    }
    starting = true
    try {
      await startImpersonation(user.id, { tenant_id: tenant?.id, reason: reason.trim() })
      // startImpersonation() reloads the page; nothing runs after it on success
    } catch (err) {
      toast.error(err.message)
      starting = false
    }
  }

  function onBackdropKey(e) {
    if (e.key === 'Escape') close()
  }
</script>

{#if show && user}
  <div class="modal-backdrop" role="presentation" on:click|self={close} on:keydown={onBackdropKey}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <div class="modal-header">
        <h3 id="imp-title"><Icon name="user-check" size={18} /> {$t('impersonation.title')}</h3>
        <button class="modal-close" on:click={close} aria-label={$t('common.close')}><Icon name="x" size={18} /></button>
      </div>
      <form class="modal-body" on:submit|preventDefault={start}>
        <p class="intro">
          {$t('impersonation.intro', user.email, tenant?.name || $t('impersonation.home_org'), $t('users.role_' + (user.role || 'viewer')))}
        </p>
        <ul class="limits">
          <li>{$t('impersonation.limit_audit')}</li>
          <li>{$t('impersonation.limit_secrets')}</li>
          <li>{$t('impersonation.limit_time')}</li>
        </ul>
        <label class="field">
          <span class="field-label">{$t('impersonation.reason_label')}</span>
          <textarea rows="3" bind:value={reason} maxlength="500" placeholder={$t('impersonation.reason_placeholder')} required></textarea>
          <span class="field-hint">{$t('impersonation.reason_hint')}</span>
        </label>
        <div class="modal-actions">
          <Button variant="secondary" on:click={close} disabled={starting}>{$t('common.cancel')}</Button>
          <Button variant="primary" type="submit" loading={starting}>{$t('impersonation.start')}</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: var(--bg-overlay);
    display: flex; align-items: center; justify-content: center; z-index: 200; padding: var(--space-4);
  }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg);
    width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-4); border-bottom: 1px solid var(--border-muted);
  }
  .modal-header h3 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); }
  .modal-close { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; border-radius: var(--radius-sm); display: flex; }
  .modal-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
  .intro { margin: 0; font-size: var(--text-sm); color: var(--text-primary); line-height: 1.5; }
  .limits { margin: 0; padding-left: 1.2em; font-size: var(--text-xs); color: var(--text-muted); line-height: 1.6; }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field-label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .field-hint { font-size: var(--text-xs); color: var(--text-muted); }
  .field textarea {
    padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: var(--font-sans); resize: vertical;
  }
  .field textarea:focus { outline: none; border-color: var(--accent-blue); box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.15); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
