<script>
  // Own account security (plan epic 2.9): the second factor and the list of
  // sessions. Every role — an account is an account.
  import { onMount } from 'svelte'
  import {
    getMfaStatus, setupMfa, enableMfa, disableMfa, regenerateBackupCodes,
    getSessions, revokeSession, revokeOtherSessions, logout,
  } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { formatDate } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'

  let loading = true
  let mfa = null            // { enabled, enabled_at, pending, backup_codes_left }
  let sessions = []

  // MFA setup wizard
  let setup = null          // { secret, otpauth_url, qr }
  let setupCode = ''
  let enabling = false
  let backupCodes = null    // shown once after enabling / regenerating
  // Disable / regenerate forms
  let mode = ''             // '' | 'disable' | 'regen'
  let password = ''
  let code = ''
  let busy = false
  let revoking = null

  onMount(load)

  async function load() {
    loading = true
    try {
      ;[mfa, sessions] = await Promise.all([getMfaStatus(), getSessions()])
    } catch (e) {
      toast.error(e.message)
    } finally {
      loading = false
    }
  }

  async function startSetup() {
    try {
      setup = await setupMfa()
      setupCode = ''
      backupCodes = null
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function finishSetup() {
    if (!setupCode.trim()) return
    enabling = true
    try {
      const res = await enableMfa(setupCode.trim())
      backupCodes = res.backup_codes
      setup = null
      toast.success($t('security.mfa_enabled_toast'))
      await load()
    } catch (e) {
      toast.error(e.code === 'invalid_mfa_code' ? $t('security.mfa_code_wrong') : e.message)
    } finally {
      enabling = false
    }
  }

  function openForm(which) {
    mode = mode === which ? '' : which
    password = ''
    code = ''
  }

  async function submitDisable() {
    busy = true
    try {
      await disableMfa(password, code.trim())
      mode = ''
      backupCodes = null
      toast.success($t('security.mfa_disabled_toast'))
      await load()
    } catch (e) {
      toast.error(e.code === 'invalid_mfa_code' ? $t('security.mfa_code_wrong') : e.message)
    } finally {
      busy = false
    }
  }

  async function submitRegen() {
    busy = true
    try {
      const res = await regenerateBackupCodes(code.trim())
      backupCodes = res.backup_codes
      mode = ''
      await load()
    } catch (e) {
      toast.error(e.code === 'invalid_mfa_code' ? $t('security.mfa_code_wrong') : e.message)
    } finally {
      busy = false
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'))
      toast.success($t('security.codes_copied'))
    } catch {
      toast.error($t('security.codes_copy_failed'))
    }
  }

  async function endSession(s) {
    if (s.current && !confirm($t('security.end_current_confirm'))) return
    revoking = s.id
    try {
      const res = await revokeSession(s.id)
      if (res.current) {
        await logout()
        window.location.reload()
        return
      }
      sessions = sessions.filter(x => x.id !== s.id)
    } catch (e) {
      toast.error(e.message)
    } finally {
      revoking = null
    }
  }

  async function endOthers() {
    if (!confirm($t('security.end_others_confirm'))) return
    busy = true
    try {
      const res = await revokeOtherSessions()
      toast.success($t('security.ended_n', res.revoked))
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      busy = false
    }
  }

  /** "Chrome · Windows" out of a User-Agent string, or the raw string when it is nothing familiar. */
  function device(ua) {
    if (!ua) return $t('security.unknown_device')
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null
    if (!browser && !os) return ua.length > 48 ? ua.slice(0, 48) + '…' : ua
    return [browser, os].filter(Boolean).join(' · ')
  }

  $: otherCount = sessions.filter(s => !s.current).length
</script>

<div class="security">
  <PageHeader title={$t('pages.security')} subtitle={$t('pages.security_sub')}>
    <Button variant="secondary" size="sm" on:click={load}><Icon name="refresh" size={14} /> {$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading && !mfa}
    <Skeleton height="320px" />
  {:else}
    <!-- ── Second factor ── -->
    <section class="card">
      <div class="card-head">
        <h2><Icon name="shield" size={18} /> {$t('security.mfa_title')}</h2>
        {#if mfa?.enabled}
          <Badge variant="success" size="sm">{$t('security.mfa_on')}</Badge>
        {:else}
          <Badge variant="warning" size="sm">{$t('security.mfa_off')}</Badge>
        {/if}
      </div>
      <p class="muted">{$t('security.mfa_intro')}</p>

      {#if backupCodes}
        <div class="codes-box">
          <strong>{$t('security.backup_title')}</strong>
          <p class="muted small">{$t('security.backup_hint')}</p>
          <ol class="codes">
            {#each backupCodes as c}<li><code>{c}</code></li>{/each}
          </ol>
          <div class="row">
            <Button size="sm" variant="secondary" on:click={copyCodes}>{$t('security.copy_codes')}</Button>
            <Button size="sm" variant="ghost" on:click={() => backupCodes = null}>{$t('security.codes_saved')}</Button>
          </div>
        </div>
      {/if}

      {#if mfa?.enabled}
        <div class="status-line">
          {$t('security.mfa_since', formatDate(mfa.enabled_at))} ·
          {$t('security.backup_left', mfa.backup_codes_left)}
        </div>
        <div class="row">
          <Button size="sm" variant="secondary" on:click={() => openForm('regen')}>{$t('security.new_backup_codes')}</Button>
          <Button size="sm" variant="danger" on:click={() => openForm('disable')}>{$t('security.mfa_disable')}</Button>
        </div>
        {#if mode === 'regen'}
          <form class="inline-form" on:submit|preventDefault={submitRegen}>
            <label><span>{$t('security.code_label')}</span>
              <input type="text" bind:value={code} inputmode="numeric" autocomplete="one-time-code" maxlength="16" required /></label>
            <Button size="sm" type="submit" disabled={busy || !code.trim()}>{$t('security.confirm')}</Button>
          </form>
        {:else if mode === 'disable'}
          <form class="inline-form" on:submit|preventDefault={submitDisable}>
            <label><span>{$t('security.password_label')}</span>
              <input type="password" bind:value={password} autocomplete="current-password" required /></label>
            <label><span>{$t('security.code_label')}</span>
              <input type="text" bind:value={code} inputmode="numeric" autocomplete="one-time-code" maxlength="16" required /></label>
            <Button size="sm" variant="danger" type="submit" disabled={busy || !password || !code.trim()}>{$t('security.mfa_disable')}</Button>
          </form>
        {/if}
      {:else if setup}
        <div class="setup">
          <div class="qr"><img src={setup.qr} alt="QR" width="220" height="220" /></div>
          <div class="setup-text">
            <ol class="steps">
              <li>{$t('security.setup_step1')}</li>
              <li>{$t('security.setup_step2')} <code class="secret">{setup.secret}</code></li>
              <li>{$t('security.setup_step3')}</li>
            </ol>
            <form class="inline-form" on:submit|preventDefault={finishSetup}>
              <label><span>{$t('security.code_label')}</span>
                <input type="text" bind:value={setupCode} inputmode="numeric" autocomplete="one-time-code" maxlength="8" required /></label>
              <Button size="sm" type="submit" disabled={enabling || setupCode.trim().length < 6}>{enabling ? $t('security.enabling') : $t('security.mfa_enable')}</Button>
              <Button size="sm" variant="ghost" type="button" on:click={() => setup = null}>{$t('common.cancel')}</Button>
            </form>
            <p class="muted small">{$t('security.enable_note')}</p>
          </div>
        </div>
      {:else}
        <div class="row">
          <Button size="sm" on:click={startSetup}>{$t('security.mfa_setup')}</Button>
        </div>
      {/if}
    </section>

    <!-- ── Sessions ── -->
    <section class="card">
      <div class="card-head">
        <h2><Icon name="globe" size={18} /> {$t('security.sessions_title')}</h2>
        <span class="count">{sessions.length}</span>
      </div>
      <p class="muted">{$t('security.sessions_intro')}</p>

      <div class="table">
        <div class="thead">
          <span>{$t('security.col_device')}</span>
          <span>{$t('security.col_ip')}</span>
          <span>{$t('security.col_org')}</span>
          <span>{$t('security.col_last')}</span>
          <span>{$t('security.col_since')}</span>
          <span></span>
        </div>
        {#each sessions as s (s.id)}
          <div class="trow" class:current={s.current}>
            <span class="cell device">
              {device(s.user_agent)}
              {#if s.current}<Badge variant="info" size="sm">{$t('security.this_device')}</Badge>{/if}
            </span>
            <span class="cell mono">{s.ip || '—'}</span>
            <span class="cell">{s.tenant_name || '—'}</span>
            <span class="cell">{s.last_used_at ? formatDate(s.last_used_at) : '—'}</span>
            <span class="cell">{formatDate(s.created_at)}</span>
            <span class="cell actions">
              <Button size="sm" variant={s.current ? 'ghost' : 'danger'} disabled={revoking === s.id} on:click={() => endSession(s)}>
                {s.current ? $t('security.sign_out') : $t('security.end_session')}
              </Button>
            </span>
          </div>
        {/each}
      </div>

      {#if otherCount > 0}
        <div class="row">
          <Button size="sm" variant="danger" disabled={busy} on:click={endOthers}>{$t('security.end_others', otherCount)}</Button>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .security { display: flex; flex-direction: column; gap: var(--space-5); }
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
  .card-head h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .count { font-size: var(--text-xs); color: var(--text-muted); background: var(--bg-tertiary); border-radius: 999px; padding: 2px 8px; }
  .muted { color: var(--text-muted); font-size: var(--text-sm); margin: 0 0 var(--space-3); line-height: 1.5; }
  .small { font-size: var(--text-xs); }
  .row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
  .status-line { font-size: var(--text-sm); color: var(--text-secondary); }

  .inline-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
  .inline-form label { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-xs); color: var(--text-muted); }
  .inline-form input {
    padding: var(--space-2) var(--space-3); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    background: var(--bg-tertiary); color: var(--text-primary); font-size: var(--text-base); min-width: 160px;
  }

  .setup { display: flex; gap: var(--space-5); flex-wrap: wrap; align-items: flex-start; }
  .qr { background: #fff; padding: var(--space-2); border-radius: var(--radius-md); line-height: 0; }
  .setup-text { flex: 1; min-width: 260px; }
  .steps { margin: 0; padding-left: 1.2em; font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }
  .secret { font-family: var(--font-mono, monospace); font-size: var(--text-xs); letter-spacing: 1px; word-break: break-all; }

  .codes-box { border: 1px solid rgba(210, 153, 34, 0.5); background: rgba(210, 153, 34, 0.1); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); }
  .codes { columns: 2; margin: var(--space-2) 0; padding-left: 1.4em; font-size: var(--text-sm); }
  .codes code { font-family: var(--font-mono, monospace); letter-spacing: 1px; }

  .table { display: flex; flex-direction: column; font-size: var(--text-sm); overflow-x: auto; }
  .thead, .trow { display: grid; grid-template-columns: 2fr 1.2fr 1.4fr 1.4fr 1.4fr auto; gap: var(--space-3); align-items: center; padding: var(--space-2) 0; min-width: 720px; }
  .thead { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); border-bottom: 1px solid var(--border-default); }
  .trow { border-bottom: 1px solid var(--border-muted); }
  .trow.current { background: rgba(59, 130, 246, 0.06); }
  .cell.device { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; color: var(--text-primary); }
  .mono { font-family: var(--font-mono, monospace); font-size: var(--text-xs); }
  .actions { text-align: right; }
</style>
