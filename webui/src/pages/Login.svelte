<script>
  import { onMount } from 'svelte'
  import { login, verifyMfa, selectTenant, resetPassword, forgotPassword, getRegistrationInfo, resendVerification } from '../lib/api.js'
  import { navigate } from '../lib/stores.js'
  import { t, locale } from '../lib/i18n.js'

  // Platform status page (external probe), same source as the sidebar link
  const statusUrl = import.meta.env.VITE_STATUS_PAGE_URL || ''

  let email = ''
  let password = ''
  let error = ''
  let loading = false

  // Steps: 'credentials' | 'mfa' | 'tenant_select' | 'forgot' | 'reset_password'
  let step = 'credentials'
  let pendingToken = null
  // Second factor (plan epic 2.9): the password was right, a code is still needed
  let mfaToken = null
  let mfaCode = ''
  let tenants = []
  let selectedTenantId = null

  // Reset password fields
  let resetCode = ''
  let newPassword = ''
  let resetSuccess = false
  let forgotSent = false

  // Self-registration (plan epic 2.1): the link shows when the server has it
  // open; an unverified or not-yet-approved administrator is told what to do.
  let registrationOpen = false
  let unverified = false
  let pendingApproval = false
  let resent = false

  onMount(async () => {
    try {
      const info = await getRegistrationInfo()
      registrationOpen = info.mode !== 'off'
    } catch {
      registrationOpen = false
    }
  })

  async function handleResend() {
    try {
      await resendVerification(email, $locale)
      resent = true
    } catch (e) {
      error = e.message || 'Request failed'
    }
  }

  // #/reset?email=…&code=… — the link from the password-reset email lands here
  // with the code prefilled; the fragment never reaches the server.
  {
    const hash = typeof window !== 'undefined' ? (window.location.hash || '') : ''
    if (hash.startsWith('#/reset')) {
      const q = new URLSearchParams(hash.split('?')[1] || '')
      if (q.get('code')) {
        email = q.get('email') || ''
        resetCode = q.get('code')
        step = 'reset_password'
      }
    }
  }

  async function handleSubmit() {
    error = ''
    unverified = false
    pendingApproval = false
    resent = false
    loading = true
    try {
      afterLogin(await login(email, password))
    } catch (e) {
      if (e.code === 'email_not_verified') unverified = true
      else if (e.code === 'pending_approval') pendingApproval = true
      else error = e.message || 'Login failed'
    } finally {
      loading = false
    }
  }

  // Where a successful password (or code) leads: the second factor, the
  // organisation choice, or straight in.
  function afterLogin(result) {
    if (result.requireMfa) {
      mfaToken = result.mfaToken
      mfaCode = ''
      step = 'mfa'
    } else if (result.requireTenantSelect) {
      // Multiple tenants — show selection
      pendingToken = result.pendingToken
      tenants = result.tenants
      // Default: last used tenant from localStorage, or first
      const lastTenant = localStorage.getItem('modesp_last_tenant')
      selectedTenantId = tenants.find(t => t.id === lastTenant)?.id || tenants[0]?.id
      step = 'tenant_select'
    } else {
      // Single tenant — direct login
      navigate('/')
    }
  }

  async function handleMfa() {
    error = ''
    loading = true
    try {
      afterLogin(await verifyMfa(mfaToken, mfaCode.trim()))
    } catch (e) {
      if (e.code === 'invalid_mfa_code') error = $t('login.mfa_wrong')
      else if (e.code === 'invalid_token' || e.status === 429) { backToCredentials(); error = $t('login.mfa_expired') }
      else error = e.message || 'Login failed'
    } finally {
      loading = false
    }
  }

  async function handleSelectTenant() {
    if (!selectedTenantId) return
    error = ''
    loading = true
    try {
      await selectTenant(pendingToken, selectedTenantId)
      navigate('/')
    } catch (e) {
      error = e.message || 'Tenant selection failed'
    } finally {
      loading = false
    }
  }

  async function handleResetPassword() {
    error = ''
    loading = true
    try {
      await resetPassword(email, resetCode, newPassword)
      resetSuccess = true
      // Auto-return to credentials after 3s
      setTimeout(() => backToCredentials(), 3000)
    } catch (e) {
      error = e.message || 'Password reset failed'
    } finally {
      loading = false
    }
  }

  function showForgotForm() {
    step = 'forgot'
    error = ''
    forgotSent = false
  }

  async function handleForgot() {
    error = ''
    loading = true
    try {
      await forgotPassword(email, $locale)
      forgotSent = true
    } catch (e) {
      error = e.message || 'Request failed'
    } finally {
      loading = false
    }
  }

  function showResetForm() {
    step = 'reset_password'
    error = ''
    resetCode = ''
    newPassword = ''
    resetSuccess = false
  }

  function backToCredentials() {
    step = 'credentials'
    pendingToken = null
    mfaToken = null
    mfaCode = ''
    tenants = []
    selectedTenantId = null
    resetCode = ''
    newPassword = ''
    resetSuccess = false
    forgotSent = false
    unverified = false
    pendingApproval = false
    resent = false
    error = ''
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#/reset')) {
      history.replaceState(null, '', '#/')
    }
  }
</script>

<div class="login-page">
  {#if step === 'credentials'}
    <form class="login-form" on:submit|preventDefault={handleSubmit}>
      <div class="login-brand">M</div>
      <h1 class="login-title">{$t('login.title')}</h1>
      <p class="login-subtitle">{$t('login.subtitle')}</p>

      {#if error}
        <div class="error">{error}</div>
      {/if}
      {#if unverified}
        <div class="notice">
          {$t('login.not_verified')}
          {#if resent}
            <span class="resent">{$t('login.resent')}</span>
          {:else}
            <button type="button" class="link-btn" on:click={handleResend}>{$t('login.resend')}</button>
          {/if}
        </div>
      {/if}
      {#if pendingApproval}
        <div class="notice">{$t('login.pending_approval')}</div>
      {/if}

      <label class="field">
        <span>{$t('login.email')}</span>
        <input type="email" bind:value={email} placeholder="admin@example.com" required autocomplete="email" />
      </label>

      <label class="field">
        <span>{$t('login.password')}</span>
        <input type="password" bind:value={password} placeholder="••••••••" required autocomplete="current-password" />
      </label>

      <button type="submit" class="btn-login" disabled={loading}>
        {loading ? $t('login.signing_in') : $t('login.sign_in')}
      </button>

      <button type="button" class="btn-forgot" on:click={showForgotForm}>
        {$t('login.forgot_password')}
      </button>

      {#if registrationOpen}
        <!-- Self-registration (plan epic 2.1): the hash change reloads into the standalone page -->
        <p class="register-link">{$t('login.no_account')} <a href="#/register">{$t('login.create_org')}</a></p>
      {/if}
    </form>

  {:else if step === 'mfa'}
    <!-- Second factor (plan epic 2.9): a code from the authenticator app or a backup code -->
    <form class="login-form" on:submit|preventDefault={handleMfa}>
      <div class="login-brand">M</div>
      <h1 class="login-title">{$t('login.mfa_title')}</h1>
      <p class="login-subtitle">{$t('login.mfa_subtitle')}</p>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <label class="field">
        <span>{$t('login.mfa_code')}</span>
        <!-- svelte-ignore a11y-autofocus -->
        <input type="text" bind:value={mfaCode} inputmode="numeric" autocomplete="one-time-code" maxlength="16" placeholder="123456" required autofocus />
      </label>
      <p class="mfa-hint">{$t('login.mfa_backup_hint')}</p>

      <button type="submit" class="btn-login" disabled={loading || !mfaCode.trim()}>
        {loading ? $t('login.mfa_verifying') : $t('login.mfa_submit')}
      </button>
      <button type="button" class="btn-back" on:click={backToCredentials}>
        ← {$t('login.back')}
      </button>
    </form>

  {:else if step === 'forgot'}
    <!-- Self-service reset: email → link (plan epic 1.5); the admin code stays as fallback -->
    <form class="login-form" on:submit|preventDefault={handleForgot}>
      <div class="login-brand">M</div>
      <h1 class="login-title">{$t('login.forgot_title')}</h1>
      <p class="login-subtitle">{$t('login.forgot_subtitle')}</p>

      {#if forgotSent}
        <div class="success">{$t('login.forgot_sent')}</div>
      {:else}
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <label class="field">
          <span>{$t('login.email')}</span>
          <input type="email" bind:value={email} placeholder="admin@example.com" required autocomplete="email" />
        </label>
        <button type="submit" class="btn-login" disabled={loading || !email}>
          {loading ? $t('login.sending') : $t('login.forgot_submit')}
        </button>
      {/if}

      <button type="button" class="btn-forgot" on:click={showResetForm}>
        {$t('login.have_code')}
      </button>
      <button type="button" class="btn-back" on:click={backToCredentials}>
        ← {$t('common.back')}
      </button>
    </form>

  {:else if step === 'reset_password'}
    <!-- Password reset step -->
    <form class="login-form" on:submit|preventDefault={handleResetPassword}>
      <div class="login-brand">M</div>
      <h1 class="login-title">{$t('login.reset_title')}</h1>
      <p class="login-subtitle">{$t('login.reset_subtitle')}</p>

      {#if resetSuccess}
        <div class="success">{$t('login.reset_success')}</div>
      {:else}
        {#if error}
          <div class="error">{error}</div>
        {/if}

        <label class="field">
          <span>{$t('login.email')}</span>
          <input type="email" bind:value={email} placeholder="admin@example.com" required autocomplete="email" />
        </label>

        <label class="field">
          <span>{$t('login.reset_code')}</span>
          <input type="text" bind:value={resetCode} placeholder="0a1b2c3d4e5f6789" required
                 maxlength="16" autocomplete="one-time-code" class="mono-input" />
        </label>

        <label class="field">
          <span>{$t('login.new_password')}</span>
          <input type="password" bind:value={newPassword} placeholder={$t('password.min_length')} required
                 minlength="15" autocomplete="new-password" />
        </label>

        <button type="submit" class="btn-login" disabled={loading || resetCode.length !== 16 || newPassword.length < 15}>
          {loading ? $t('login.resetting') : $t('login.reset_submit')}
        </button>
      {/if}

      <button type="button" class="btn-back" on:click={backToCredentials}>
        ← {$t('common.back')}
      </button>
    </form>

  {:else}
    <!-- Tenant selection step -->
    <div class="login-form">
      <div class="login-brand">M</div>
      <h1 class="login-title">{$t('auth.select_workspace')}</h1>
      <p class="login-subtitle">{email}</p>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <div class="tenant-list">
        {#each tenants as tenant}
          <button
            type="button"
            class="tenant-card"
            class:selected={selectedTenantId === tenant.id}
            on:click={() => { selectedTenantId = tenant.id }}
          >
            <span class="tenant-avatar">{tenant.name.charAt(0).toUpperCase()}</span>
            <div class="tenant-info">
              <span class="tenant-name">{tenant.name}</span>
              <span class="tenant-slug">{tenant.slug}</span>
            </div>
            {#if selectedTenantId === tenant.id}
              <span class="tenant-check">✓</span>
            {/if}
          </button>
        {/each}
      </div>

      <button type="button" class="btn-login" disabled={loading || !selectedTenantId} on:click={handleSelectTenant}>
        {loading ? $t('login.signing_in') : $t('login.sign_in')}
      </button>

      <button type="button" class="btn-back" on:click={backToCredentials}>
        ← {$t('common.back')}
      </button>
    </div>
  {/if}
  <footer class="login-links">
    <a href="/">{$t('login.about')}</a>
    <a href="/legal/offer" target="_blank" rel="noopener">{$t('login.terms')}</a>
    <a href="/legal/privacy" target="_blank" rel="noopener">{$t('login.privacy')}</a>
    {#if statusUrl}<a href={statusUrl} target="_blank" rel="noopener">{$t('login.status')}</a>{/if}
  </footer>
</div>

<style>
  .login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--bg-primary);
  }

  .login-form {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .login-brand {
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

  .login-title {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: var(--space-1);
  }

  .login-subtitle {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin-bottom: var(--space-5);
  }

  .error {
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
    width: 100%;
    text-align: center;
  }

  .mfa-hint {
    width: 100%;
    color: var(--text-muted);
    font-size: var(--text-xs);
    margin: calc(-1 * var(--space-2)) 0 var(--space-3);
  }

  .success {
    background: rgba(63, 185, 80, 0.1);
    color: var(--accent-green, #3fb950);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
    width: 100%;
    text-align: center;
  }

  .field {
    display: block;
    width: 100%;
    margin-bottom: var(--space-3);
  }

  .field span {
    display: block;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }

  .field input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    transition: border-color var(--transition-fast);
  }

  .field input::placeholder {
    color: var(--text-muted);
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
  }

  .mono-input {
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.05em;
  }

  .btn-login {
    width: 100%;
    padding: var(--space-3);
    background: var(--accent-blue);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition-fast);
    margin-top: var(--space-2);
  }

  .btn-login:hover:not(:disabled) {
    background: #4c94e8;
  }

  .btn-login:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .login-links {
    position: fixed;
    bottom: var(--space-4);
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    gap: var(--space-4);
    font-size: var(--text-xs);
  }

  .login-links a {
    color: var(--text-muted);
    text-decoration: none;
  }

  .login-links a:hover {
    color: var(--text-primary);
    text-decoration: underline;
  }

  .btn-forgot {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    margin-top: var(--space-3);
    padding: var(--space-1) var(--space-2);
  }

  .btn-forgot:hover {
    color: var(--accent-blue);
  }

  /* Tenant selection */
  .tenant-list {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    max-height: 300px;
    overflow-y: auto;
  }

  .tenant-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border: 2px solid var(--border-default);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
    font-family: var(--font-sans);
  }

  .tenant-card:hover {
    border-color: var(--text-muted);
  }

  .tenant-card.selected {
    border-color: var(--accent-blue);
    background: rgba(88, 166, 255, 0.06);
  }

  .tenant-avatar {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    background: var(--accent-blue);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: var(--text-lg);
    flex-shrink: 0;
  }

  .tenant-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tenant-name {
    font-weight: 600;
    color: var(--text-primary);
    font-size: var(--text-base);
  }

  .tenant-slug {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .tenant-check {
    color: var(--accent-blue);
    font-weight: 700;
    font-size: var(--text-lg);
  }

  .btn-back {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    margin-top: var(--space-3);
    padding: var(--space-1) var(--space-2);
  }

  .btn-back:hover {
    color: var(--text-secondary);
  }

  /* Self-registration (plan epic 2.1) */
  .notice {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
    text-align: center;
    background: rgba(210, 153, 34, 0.12);
    color: var(--text-primary);
    line-height: 1.5;
  }
  .notice .resent { display: block; color: var(--accent-green, #3fb950); }
  .link-btn {
    display: block;
    margin: var(--space-1) auto 0;
    background: none;
    border: none;
    color: var(--accent-blue);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .register-link {
    margin: var(--space-4) 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-align: center;
  }
  .register-link a { color: var(--accent-blue); font-weight: 600; text-decoration: none; }
</style>
