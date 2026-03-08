<script>
  import { login } from '../lib/api.js'
  import { navigate } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'

  let email = ''
  let password = ''
  let error = ''
  let loading = false

  async function handleSubmit() {
    error = ''
    loading = true
    try {
      await login(email, password)
      navigate('/')
    } catch (e) {
      error = e.message || 'Login failed'
    } finally {
      loading = false
    }
  }
</script>

<div class="login-page">
  <form class="login-form" on:submit|preventDefault={handleSubmit}>
    <div class="login-brand">M</div>
    <h1 class="login-title">{$t('login.title')}</h1>
    <p class="login-subtitle">{$t('login.subtitle')}</p>

    {#if error}
      <div class="error">{error}</div>
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
  </form>
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
</style>
