<script>
  /**
   * Public status links of one site (Part 2 §7.7): mint, list, revoke. Admin
   * only — every endpoint behind it is maybeAuthorize('admin'). Shared by the
   * sites table (inside a modal) and the site page (inline section).
   *
   * The raw token exists in the browser's memory for exactly one render after
   * minting: the server stores sha256(token) and nothing else.
   */
  import { onMount } from 'svelte'
  import { getSitePublicLinks, createSitePublicLink, revokeSitePublicLink } from '../lib/api.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import Icon from './ui/Icon.svelte'
  import Skeleton from './ui/Skeleton.svelte'

  /** The site row: { id, name }. */
  export let site

  let links = []
  let loading = true
  let linkLabel = ''
  let linkDays = 90
  let busy = false
  let mintedToken = null    // shown exactly once, never recoverable afterwards

  async function load() {
    loading = true
    try {
      links = await getSitePublicLinks(site.id)
    } catch (e) {
      toast.error(e.message)
      links = []
    } finally {
      loading = false
    }
  }

  /**
   * The shareable address. The token lives in the HASH FRAGMENT, which browsers
   * never send to a server — so it appears in no access log and in no Referer.
   * App.svelte reads it from there and passes it in the X-Site-Token header.
   */
  function publicUrl(token) {
    const { origin, pathname } = window.location
    return `${origin}${pathname}#/public/site/${encodeURIComponent(token)}`
  }

  async function mint() {
    busy = true
    try {
      const created = await createSitePublicLink(site.id, {
        label: linkLabel.trim() || undefined,
        expires_in_days: Number(linkDays) || undefined,
      })
      // The raw token is in this response and nowhere else, ever again.
      mintedToken = created.token || null
      links = [created, ...links]
      linkLabel = ''
      toast.success($t('site.public_link_created'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      busy = false
    }
  }

  async function revoke(link) {
    if (!window.confirm($t('site.public_link_revoke_confirm'))) return
    try {
      await revokeSitePublicLink(site.id, link.id)
      toast.success($t('site.public_link_revoked'))
      links = links.map(l => (l.id === link.id ? { ...l, active: false, revoked_at: new Date().toISOString() } : l))
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function copyUrl(token) {
    try {
      await navigator.clipboard.writeText(publicUrl(token))
      toast.success($t('site.public_link_copied'))
    } catch {
      // Clipboard access can be denied outright; the value is on screen anyway.
      toast.warning($t('site.public_link_token_once'))
    }
  }

  function formatDate(value) {
    if (!value) return '—'
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  onMount(load)
</script>

<div class="public-links">
  {#if mintedToken}
    <!-- The ONLY moment this value exists outside the browser's memory:
         the server stores sha256(token) and nothing else. -->
    <div class="token-box">
      <p class="token-warn">
        <Icon name="alert-triangle" size={14} />
        {$t('site.public_link_token_once')}
      </p>
      <div class="token-row">
        <input class="token-input font-mono" type="text" readonly value={publicUrl(mintedToken)} />
        <button class="tbl-btn" on:click={() => copyUrl(mintedToken)}>
          {$t('site.public_link_copy')}
        </button>
      </div>
    </div>
  {/if}

  <div class="mint-row">
    <div class="form-group grow">
      <label for="link-label-{site.id}">{$t('site.public_link_label')}</label>
      <input id="link-label-{site.id}" type="text" maxlength="128" bind:value={linkLabel}
        placeholder={$t('site.public_link_label_placeholder')} />
    </div>
    <div class="form-group">
      <label for="link-days-{site.id}">{$t('site.public_link_expires_in')}</label>
      <!-- 1..365: the same bound createLinkSchema enforces server-side, so
           the form cannot produce a 400 the user has no way to read. -->
      <input id="link-days-{site.id}" type="number" min="1" max="365" bind:value={linkDays} />
    </div>
    <button class="btn btn-primary" on:click={mint} disabled={busy}>
      {$t('site.public_link_new')}
    </button>
  </div>

  {#if loading}
    <Skeleton height="120px" />
  {:else if links.length === 0}
    <p class="hint">{$t('site.public_link_none')}</p>
  {:else}
    <div class="table-wrap">
      <table class="links-table">
        <thead>
          <tr>
            <th>{$t('site.public_link_label')}</th>
            <th>{$t('site.public_link_expires')}</th>
            <th class="num">{$t('site.public_link_views')}</th>
            <th>{$t('site.public_link_last_viewed')}</th>
            <th class="actions-col"></th>
          </tr>
        </thead>
        <tbody>
          {#each links as link (link.id)}
            <tr>
              <td>{link.label || '—'}</td>
              <td>
                {formatDate(link.expires_at)}
                <span class="link-state" class:active={link.active}>
                  {link.active ? $t('site.public_link_active') : $t('site.public_link_expired')}
                </span>
              </td>
              <td class="num font-mono">{link.view_count ?? 0}</td>
              <td>{formatDate(link.last_viewed)}</td>
              <td class="actions-col">
                {#if link.active}
                  <button class="tbl-btn danger" on:click={() => revoke(link)}>
                    {$t('site.public_link_revoke')}
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .public-links {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .mint-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-group.grow {
    flex: 1;
    min-width: 160px;
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

  .token-box {
    padding: var(--space-3);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .token-warn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent-yellow);
    font-size: var(--text-xs);
  }

  .token-row {
    display: flex;
    gap: var(--space-2);
  }

  .token-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-xs);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .links-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .links-table th {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-default);
    white-space: nowrap;
  }

  .links-table td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-primary);
    vertical-align: top;
  }

  .num {
    text-align: right;
  }

  .actions-col {
    text-align: right;
    white-space: nowrap;
  }

  .link-state {
    display: inline-block;
    margin-left: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .link-state.active {
    color: var(--accent-green);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .tbl-btn {
    padding: var(--space-1) var(--space-2);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .tbl-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .tbl-btn.danger:hover:not(:disabled) {
    color: var(--accent-red);
    border-color: var(--accent-red);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
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

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
