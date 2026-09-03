<script>
  // Invitation acceptance — standalone page at #/invite/<token> (plan epic 1.5).
  // Rendered by App.svelte above the auth gate, like the public site page.
  import { onMount } from 'svelte'
  import { getInvite, acceptInvite } from '../lib/api.js'
  import { t } from '../lib/i18n.js'

  export let token

  let loading = true
  let invite = null
  let errorKey = ''      // 'invalid' | 'expired'
  let password = ''
  let terms = false
  let submitting = false
  let error = ''
  let done = false

  const ROLE_KEYS = { admin: 'users.role_admin', technician: 'users.role_technician', viewer: 'users.role_viewer' }

  onMount(async () => {
    try {
      invite = await getInvite(token)
    } catch (e) {
      errorKey = e.body?.error === 'invitation_expired' ? 'expired' : 'invalid'
    } finally {
      loading = false
    }
  })

  $: minLength = invite?.existing_user ? 1 : 15
  $: canSubmit = terms && password.length >= minLength && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    error = ''
    submitting = true
    try {
      await acceptInvite(token, password, true)
      done = true
      // The standalone shell cannot swap into the app in place — reload on #/
      setTimeout(goHome, 800)
    } catch (e) {
      if (e.body?.error === 'invitation_expired') errorKey = 'expired'
      else if (e.status === 404 || e.status === 410) errorKey = 'invalid'
      else error = e.message || 'Failed'
    } finally {
      submitting = false
    }
  }

  function goHome() {
    window.location.replace('/#/')
    window.location.reload()
  }

  function termsHtml(label, href) {
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
  }
</script>

<div class="invite-page">
  <div class="invite-card">
    <div class="brand">M</div>

    {#if loading}
      <p class="subtitle">{$t('invite.loading')}</p>
    {:else if errorKey}
      <h1 class="title">{$t('invite.title')}</h1>
      <div class="error">{$t(errorKey === 'expired' ? 'invite.expired' : 'invite.invalid')}</div>
      <button type="button" class="btn-link" on:click={goHome}>{$t('invite.go_login')}</button>
    {:else if done}
      <h1 class="title">{$t('invite.title')}</h1>
      <div class="success">{$t('invite.success')}</div>
    {:else}
      <form on:submit|preventDefault={handleSubmit}>
        <h1 class="title">{$t('invite.title')}</h1>
        <p class="subtitle">{$t('invite.subtitle', invite.tenant.name)}</p>

        {#if error}
          <div class="error">{error}</div>
        {/if}

        <div class="info-row"><span>{$t('invite.email')}</span><strong>{invite.email}</strong></div>
        <div class="info-row"><span>{$t('invite.role')}</span><strong>{$t(ROLE_KEYS[invite.role] || invite.role)}</strong></div>

        {#if invite.existing_user}
          <p class="hint">{$t('invite.existing_hint')}</p>
        {/if}

        <label class="field">
          <span>{invite.existing_user ? $t('invite.existing_password') : $t('invite.set_password')}</span>
          <input type="password" bind:value={password} required minlength={minLength}
                 autocomplete={invite.existing_user ? 'current-password' : 'new-password'} />
        </label>

        <label class="terms">
          <input type="checkbox" bind:checked={terms} />
          <span>{@html $t('invite.accept_terms', termsHtml($t('invite.terms'), '/legal/offer'), termsHtml($t('invite.privacy'), '/legal/privacy'))}</span>
        </label>

        <button type="submit" class="btn-primary" disabled={!canSubmit}>
          {submitting ? $t('invite.accepting') : $t('invite.submit')}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .invite-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-4);
    background: var(--bg-primary);
  }

  .invite-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
  }

  .brand {
    width: 48px;
    height: 48px;
    background: var(--accent-blue);
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: var(--text-2xl);
    color: white;
    margin-bottom: var(--space-3);
  }

  .title {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 var(--space-1);
    text-align: center;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin: 0 0 var(--space-4);
    text-align: center;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-muted);
    font-size: var(--text-sm);
  }
  .info-row span { color: var(--text-muted); }
  .info-row strong { color: var(--text-primary); word-break: break-all; text-align: right; }

  .hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
    margin: var(--space-3) 0 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .field input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: var(--text-base);
  }

  .terms {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin-top: var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }
  .terms input { margin-top: 2px; }
  .terms :global(a) { color: var(--accent-blue); }

  .btn-primary {
    margin-top: var(--space-4);
    padding: var(--space-3);
    background: var(--accent-blue);
    color: white;
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-link {
    margin-top: var(--space-3);
    background: none;
    border: none;
    color: var(--accent-blue);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .error, .success {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
    text-align: center;
  }
  .error   { background: rgba(248, 81, 73, 0.1);  color: var(--accent-red); }
  .success { background: rgba(63, 185, 80, 0.12); color: var(--accent-green, #3fb950); }
</style>
