<script>
  // Self-registration — standalone page at #/register, and the landing point of
  // the verification e-mail at #/verify?email=…&code=… (plan epic 2.1).
  // Rendered by App.svelte above the auth gate, like the invitation page.
  import { onMount } from 'svelte'
  import { getRegistrationInfo, register, verifyEmail, resendVerification } from '../lib/api.js'
  import { t, locale } from '../lib/i18n.js'

  /** { email, code } when opened from the e-mail link; null for the form. */
  export let verify = null

  let loading = true
  let info = null          // { mode, email_verification, trial_days }
  let organisation = ''
  let email = ''
  let password = ''
  let terms = false
  let website = ''         // honeypot — hidden from people, filled by bots
  let submitting = false
  let error = ''
  // What the page shows after the form: 'verify' | 'approval' | 'done'
  let outcome = ''
  let resent = false
  // Verification-link mode
  let verifyState = ''     // 'working' | 'ok' | 'approval' | 'failed' | 'expired'

  onMount(async () => {
    if (verify) {
      loading = false
      await runVerification()
      return
    }
    try {
      info = await getRegistrationInfo()
    } catch {
      info = { mode: 'off' }
    } finally {
      loading = false
    }
  })

  async function runVerification() {
    verifyState = 'working'
    try {
      const data = await verifyEmail(verify.email, verify.code)
      if (data.access_token) {
        verifyState = 'ok'
        setTimeout(goHome, 1200)
      } else if (data.approval_required) {
        verifyState = 'approval'
      } else {
        verifyState = 'ok'
        setTimeout(goLogin, 1500)
      }
    } catch (e) {
      verifyState = e.body?.error === 'code_expired' ? 'expired' : 'failed'
    }
  }

  $: canSubmit = terms && organisation.trim().length >= 2 && email.length > 3 && password.length >= 15 && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    error = ''
    submitting = true
    try {
      const data = await register({
        organisation: organisation.trim(), email: email.trim(), password, accept_terms: true, lang: $locale, website,
      })
      if (data.access_token) {
        outcome = 'done'
        setTimeout(goHome, 800)
      } else if (data.verification_required) {
        outcome = 'verify'
      } else if (data.approval_required) {
        outcome = 'approval'
      } else {
        outcome = 'done'
        setTimeout(goLogin, 800)
      }
    } catch (e) {
      if (e.body?.error === 'email_taken') error = $t('register.email_taken')
      else if (e.body?.error === 'registration_closed') { info = { ...info, mode: 'off' } }
      else error = e.message || 'Failed'
    } finally {
      submitting = false
    }
  }

  async function handleResend() {
    try {
      await resendVerification((verify ? verify.email : email).trim(), $locale)
      resent = true
    } catch (e) {
      error = e.message || 'Failed'
    }
  }

  function goHome() {
    window.location.replace('/#/')
    window.location.reload()
  }

  function goLogin() {
    window.location.replace('/#/')
    window.location.reload()
  }

  function link(label, href) {
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
  }
</script>

<div class="register-page">
  <div class="register-card">
    <div class="brand">M</div>

    {#if loading}
      <p class="subtitle">{$t('common.loading')}</p>

    {:else if verify}
      <!-- The link from the verification e-mail -->
      <h1 class="title">{$t('register.verify_title')}</h1>
      {#if verifyState === 'working'}
        <p class="subtitle">{$t('register.verifying')}</p>
      {:else if verifyState === 'ok'}
        <div class="success">{$t('register.verified')}</div>
      {:else if verifyState === 'approval'}
        <div class="success">{$t('register.verified_awaiting')}</div>
        <p class="hint">{$t('register.awaiting_text')}</p>
      {:else}
        <div class="error">{$t(verifyState === 'expired' ? 'register.verify_expired' : 'register.verify_failed')}</div>
        {#if verifyState === 'expired'}
          {#if resent}
            <div class="success">{$t('register.resent')}</div>
          {:else}
            <button type="button" class="btn-link" on:click={handleResend}>{$t('register.resend')}</button>
          {/if}
        {/if}
      {/if}
      <button type="button" class="btn-link" on:click={goLogin}>{$t('invite.go_login')}</button>

    {:else if info?.mode === 'off'}
      <h1 class="title">{$t('register.title')}</h1>
      <div class="error">{$t('register.closed')}</div>
      <p class="hint">{$t('register.closed_hint')}</p>
      <a class="btn-primary as-link" href="/#pilot">{$t('register.pilot_link')}</a>
      <button type="button" class="btn-link" on:click={goLogin}>{$t('invite.go_login')}</button>

    {:else if outcome === 'verify'}
      <h1 class="title">{$t('register.check_inbox_title')}</h1>
      <div class="success">{$t('register.check_inbox', email.trim())}</div>
      <p class="hint">{$t('register.check_inbox_hint')}</p>
      {#if error}<div class="error">{error}</div>{/if}
      {#if resent}
        <div class="success">{$t('register.resent')}</div>
      {:else}
        <button type="button" class="btn-link" on:click={handleResend}>{$t('register.resend')}</button>
      {/if}

    {:else if outcome === 'approval'}
      <h1 class="title">{$t('register.awaiting_title')}</h1>
      <div class="success">{$t('register.awaiting_text')}</div>
      <button type="button" class="btn-link" on:click={goLogin}>{$t('invite.go_login')}</button>

    {:else if outcome === 'done'}
      <h1 class="title">{$t('register.title')}</h1>
      <div class="success">{$t('register.done')}</div>

    {:else}
      <form on:submit|preventDefault={handleSubmit} autocomplete="on">
        <h1 class="title">{$t('register.title')}</h1>
        <p class="subtitle">{$t('register.subtitle', info?.trial_days ?? 14)}</p>

        {#if error}
          <div class="error">{error}</div>
        {/if}

        <label class="field">
          <span>{$t('register.organisation')}</span>
          <input type="text" bind:value={organisation} required minlength="2" maxlength="128"
                 placeholder={$t('register.organisation_placeholder')} autocomplete="organization" />
          <small>{$t('register.organisation_hint')}</small>
        </label>

        <label class="field">
          <span>{$t('register.email')}</span>
          <input type="email" bind:value={email} required maxlength="256" placeholder="admin@example.com" autocomplete="email" />
        </label>

        <label class="field">
          <span>{$t('register.password')}</span>
          <input type="password" bind:value={password} required minlength="15" maxlength="256" autocomplete="new-password" />
        </label>

        <!-- Honeypot: people never see it, bots fill it in -->
        <label class="hp" aria-hidden="true">
          <span>Website</span>
          <input type="text" bind:value={website} tabindex="-1" autocomplete="off" />
        </label>

        <label class="terms">
          <input type="checkbox" bind:checked={terms} />
          <span>{@html $t('invite.accept_terms', link($t('invite.terms'), '/legal/offer'), link($t('invite.privacy'), '/legal/privacy'))}</span>
        </label>

        {#if info?.mode === 'approve'}
          <p class="hint">{$t('register.approve_hint')}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={!canSubmit}>
          {submitting ? $t('register.submitting') : $t('register.submit')}
        </button>

        <p class="switch">{$t('register.have_account')} <a href="/#/" on:click|preventDefault={goLogin}>{$t('login.sign_in')}</a></p>
      </form>
    {/if}
  </div>
</div>

<style>
  .register-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-4);
    background: var(--bg-primary);
  }

  .register-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 440px;
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

  .hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
    margin: var(--space-3) 0 0;
    text-align: center;
    line-height: 1.5;
  }
  form .hint { text-align: left; }

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
  .field small { color: var(--text-muted); font-size: var(--text-xs); }

  /* Off-screen, not display:none — a bot that skips hidden fields would skip a hidden one */
  .hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }

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
    text-align: center;
    text-decoration: none;
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .as-link { display: inline-block; }

  .btn-link {
    margin-top: var(--space-3);
    background: none;
    border: none;
    color: var(--accent-blue);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .switch {
    margin: var(--space-4) 0 0;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .switch a { color: var(--accent-blue); }

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
