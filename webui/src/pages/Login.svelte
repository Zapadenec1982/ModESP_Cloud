<script>
  import { login } from '../lib/api.js';
  import { navigate } from '../lib/stores.js';

  let email = '';
  let password = '';
  let error = '';
  let loading = false;

  async function handleSubmit() {
    error = '';
    loading = true;
    try {
      await login(email, password);
      navigate('/');
    } catch (e) {
      error = e.message || 'Login failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-page">
  <form class="login-form" on:submit|preventDefault={handleSubmit}>
    <h1 class="login-title">ModESP Cloud</h1>
    <p class="login-subtitle">Sign in to your account</p>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <label class="field">
      <span>Email</span>
      <input type="email" bind:value={email} placeholder="admin@example.com" required autocomplete="email" />
    </label>

    <label class="field">
      <span>Password</span>
      <input type="password" bind:value={password} placeholder="••••••••" required autocomplete="current-password" />
    </label>

    <button type="submit" class="btn-login" disabled={loading}>
      {loading ? 'Signing in...' : 'Sign In'}
    </button>
  </form>
</div>

<style>
  .login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #f5f6fa;
  }

  .login-form {
    background: white;
    padding: 2.5rem;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    width: 100%;
    max-width: 380px;
  }

  .login-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #2d3436;
    margin-bottom: 0.25rem;
  }

  .login-subtitle {
    color: #636e72;
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }

  .error {
    background: #ffeaea;
    color: #d63031;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }

  .field {
    display: block;
    margin-bottom: 1rem;
  }

  .field span {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    color: #2d3436;
    margin-bottom: 0.25rem;
  }

  .field input {
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    font-size: 0.9rem;
    transition: border-color 0.2s;
  }

  .field input:focus {
    outline: none;
    border-color: #00b894;
    box-shadow: 0 0 0 3px rgba(0, 184, 148, 0.15);
  }

  .btn-login {
    width: 100%;
    padding: 0.7rem;
    background: #00b894;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    margin-top: 0.5rem;
  }

  .btn-login:hover:not(:disabled) {
    background: #00a884;
  }

  .btn-login:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
