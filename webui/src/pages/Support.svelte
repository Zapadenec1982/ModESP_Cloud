<script>
  // Support (plan epic 2.13): where to reach support, the form, and the
  // requests — one's own, the organisation's (admin) or every organisation's
  // (superadmin, who also moves them between new / open / closed).
  import { onMount } from 'svelte'
  import { location, querystring } from 'svelte-spa-router'
  import { getSupportInfo, createSupportRequest, getSupportRequests, updateSupportRequest } from '../lib/api.js'
  import { authUser, currentTenant, isAdmin, isSuperAdmin } from '../lib/stores.js'
  import { t, locale } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  const CATEGORIES = ['question', 'problem', 'billing', 'feature', 'other']
  const APP_VERSION = import.meta.env.VITE_APP_VERSION || ''

  let info = null
  let requests = []
  let openCount = 0
  let loading = true
  let error = null

  // Form
  let category = 'question'
  let subject = ''
  let message = ''
  let attach = true
  let sending = false

  // Superadmin filters
  let filterStatus = ''
  let filterTenant = ''

  // The page the person came from is the most useful bit of context; the
  // sidebar link remembers it before the router settles on /support.
  let previousPage = ''
  try { previousPage = sessionStorage.getItem('modesp_support_from') || '' } catch { /* ignore */ }

  $: diagnostics = {
    page: previousPage || `#${$location}`,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 512) : undefined,
    app_version: APP_VERSION || undefined,
    locale: $locale,
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined } })(),
  }

  async function load() {
    loading = true
    error = null
    try {
      const params = {}
      if ($isSuperAdmin) {
        if (filterStatus) params.status = filterStatus
        if (filterTenant) params.tenant_id = filterTenant
      }
      const [i, r] = await Promise.all([getSupportInfo(), getSupportRequests(params)])
      info = i
      requests = r.data
      openCount = r.meta?.open || 0
    } catch (err) {
      error = err.message
    } finally {
      loading = false
    }
  }

  onMount(() => {
    const q = new URLSearchParams($querystring || '')
    if (q.get('tenant_id')) filterTenant = q.get('tenant_id')
    load()
  })

  async function send() {
    if (subject.trim().length < 3) { toast.error($t('support.subject_short')); return }
    if (message.trim().length < 10) { toast.error($t('support.message_short')); return }
    sending = true
    try {
      const body = { category, subject: subject.trim(), message: message.trim() }
      if (attach) body.context = Object.fromEntries(Object.entries(diagnostics).filter(([, v]) => v))
      const res = await createSupportRequest(body)
      toast.success(res.emailed ? $t('support.sent') : $t('support.sent_no_mail'), 6000)
      subject = ''
      message = ''
      category = 'question'
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      sending = false
    }
  }

  async function setStatus(r, status) {
    try {
      await updateSupportRequest(r.id, status)
      await load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const fmtTime = (d) => d ? new Date(d).toLocaleString($t('time.locale_code'), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  function statusColor(s) { return { new: 'warning', open: 'info', closed: 'neutral' }[s] || 'neutral' }

  $: listTitle = $isSuperAdmin ? $t('support.all_requests') : $isAdmin ? $t('support.org_requests') : $t('support.my_requests')
</script>

<div class="support-page">
  <PageHeader title={$t('pages.support')} subtitle={$t('pages.support_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  <div class="layout">
    <!-- Contact + form -->
    <section class="section-card">
      <div class="section-header"><h2><Icon name="help-circle" size={16} /> {$t('support.title')}</h2></div>
      <div class="body">
        <p class="intro">{$t('support.intro')}</p>
        {#if info && (info.email || info.telegram || info.docs_url)}
          <ul class="contacts">
            {#if info.email}<li><Icon name="send" size={14} /> <a href="mailto:{info.email}">{info.email}</a></li>{/if}
            {#if info.telegram}<li><Icon name="bell" size={14} /> <a href="https://t.me/{info.telegram.replace(/^@/, '')}" target="_blank" rel="noopener">{info.telegram}</a></li>{/if}
            {#if info.docs_url}<li><Icon name="file-text" size={14} /> <a href={info.docs_url} target="_blank" rel="noopener">{$t('support.docs')}</a></li>{/if}
          </ul>
        {/if}

        <form class="form" on:submit|preventDefault={send}>
          <label class="field">
            <span class="field-label">{$t('support.category')}</span>
            <select bind:value={category}>
              {#each CATEGORIES as c}<option value={c}>{$t('support.cat_' + c)}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span class="field-label">{$t('support.subject')}</span>
            <input type="text" bind:value={subject} maxlength="160" placeholder={$t('support.subject_placeholder')} required />
          </label>
          <label class="field">
            <span class="field-label">{$t('support.message')}</span>
            <textarea rows="6" bind:value={message} maxlength="5000" placeholder={$t('support.message_placeholder')} required></textarea>
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={attach} />
            <span>{$t('support.attach')}</span>
          </label>
          {#if attach}
            <div class="diag">
              <span>{$t('support.attach_hint')}</span>
              <code>{$currentTenant?.name || ''} · {$authUser?.email || ''} · {diagnostics.page}{diagnostics.app_version ? ' · v' + diagnostics.app_version : ''} · {diagnostics.timezone || ''}</code>
            </div>
          {/if}
          <div class="actions">
            <Button variant="primary" type="submit" loading={sending} icon="send">{$t('support.send')}</Button>
          </div>
        </form>
      </div>
    </section>

    <!-- Requests -->
    <section class="section-card">
      <div class="section-header">
        <h2><Icon name="clipboard" size={16} /> {listTitle}</h2>
        {#if $isSuperAdmin}
          <span class="count-badge" title={$t('support.open_count')}>{openCount}</span>
          <select class="filter" bind:value={filterStatus} on:change={load}>
            <option value="">{$t('support.all')}</option>
            <option value="new">{$t('support.status_new')}</option>
            <option value="open">{$t('support.status_open')}</option>
            <option value="closed">{$t('support.status_closed')}</option>
          </select>
          {#if filterTenant}
            <button class="chip" on:click={() => { filterTenant = ''; load() }} title={$t('audit.clear')}>
              {$t('support.one_org')} <Icon name="x" size={12} />
            </button>
          {/if}
        {/if}
      </div>
      {#if loading}
        <Skeleton height="200px" />
      {:else if error}
        <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
      {:else if requests.length === 0}
        <p class="empty">{$t('support.no_requests')}</p>
      {:else}
        <div class="list">
          {#each requests as r (r.id)}
            <details class="req">
              <summary>
                <span class="r-time">{fmtTime(r.created_at)}</span>
                <span class="r-subject" title={r.subject}>
                  <Badge variant="neutral" size="sm">{$t('support.cat_' + r.category)}</Badge>
                  {r.subject}
                </span>
                {#if $isSuperAdmin}<span class="r-org" title={r.tenant_slug}>{r.tenant_name}</span>{/if}
                {#if $isAdmin}<span class="r-user" title={r.user_email}>{r.user_email}</span>{/if}
                <span class="r-status"><Badge variant={statusColor(r.status)} size="sm">{$t('support.status_' + r.status)}</Badge></span>
              </summary>
              <div class="req-body">
                <p>{r.message}</p>
                {#if r.context}
                  <dl class="ctx">
                    {#each Object.entries(r.context) as [k, v]}
                      <div><dt>{k}</dt><dd>{v}</dd></div>
                    {/each}
                  </dl>
                {/if}
                {#if $isSuperAdmin}
                  <div class="req-actions">
                    {#if r.tenant_id}<a class="link" href="#/tenants/{r.tenant_id}">{$t('tenants.open_card')} →</a>{/if}
                    {#if r.status !== 'open'}<Button variant="secondary" size="sm" on:click={() => setStatus(r, 'open')}>{$t('support.set_open')}</Button>{/if}
                    {#if r.status !== 'closed'}<Button variant="secondary" size="sm" on:click={() => setStatus(r, 'closed')}>{$t('support.set_closed')}</Button>{/if}
                  </div>
                {:else if r.emailed_at === null}
                  <span class="muted">{$t('support.not_mailed')}</span>
                {/if}
              </div>
            </details>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .support-page { max-width: 1400px; margin: 0 auto; }
  .layout { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.4fr); gap: var(--space-4); }
  @media (max-width: 960px) { .layout { grid-template-columns: 1fr; } }
  .section-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); overflow: hidden; align-self: start; }
  .section-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-muted); flex-wrap: wrap; }
  .section-header h2 { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); }
  .count-badge { font-size: var(--text-xs); color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 8px; border-radius: 999px; }
  .filter, .chip {
    margin-left: auto; padding: var(--space-1) var(--space-2); background: var(--bg-primary); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-xs); font-family: var(--font-sans);
  }
  .chip { margin-left: 0; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-muted); }
  .body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .intro { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; }
  .contacts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); }
  .contacts li { display: flex; align-items: center; gap: var(--space-2); color: var(--text-muted); }
  .contacts a { color: var(--accent-blue); text-decoration: none; }
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field-label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .field input, .field select, .field textarea {
    padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default);
    border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: var(--font-sans);
  }
  .field textarea { resize: vertical; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent-blue); box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.15); }
  .check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); cursor: pointer; }
  .diag { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-xs); color: var(--text-muted); }
  .diag code { font-family: var(--font-mono); background: var(--bg-tertiary); padding: 4px 8px; border-radius: var(--radius-sm); overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; }
  .empty { margin: 0; padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
  .list { display: flex; flex-direction: column; }
  .req { border-bottom: 1px solid var(--border-muted); }
  .req:last-child { border-bottom: none; }
  .req summary { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); cursor: pointer; font-size: var(--text-sm); color: var(--text-secondary); list-style: none; }
  .req summary::-webkit-details-marker { display: none; }
  .req summary:hover { background: var(--bg-hover); }
  .req summary > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r-time { flex: 0 0 110px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .r-subject { flex: 2; min-width: 160px; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); }
  .r-org, .r-user { flex: 1; min-width: 100px; color: var(--text-muted); font-size: var(--text-xs); }
  .r-status { flex: 0 0 auto; }
  .req-body { padding: 0 var(--space-4) var(--space-3) calc(var(--space-4) + 110px + var(--space-3)); font-size: var(--text-sm); color: var(--text-secondary); display: flex; flex-direction: column; gap: var(--space-2); }
  .req-body p { margin: 0; white-space: pre-wrap; color: var(--text-primary); line-height: 1.5; }
  .ctx { margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-xs); }
  .ctx > div { display: flex; gap: 4px; }
  .ctx dt { color: var(--text-muted); }
  .ctx dd { margin: 0; font-family: var(--font-mono); overflow-wrap: anywhere; }
  .req-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .link { color: var(--accent-blue); text-decoration: none; font-size: var(--text-xs); margin-right: auto; }
  .muted { color: var(--text-muted); font-size: var(--text-xs); }
  @media (max-width: 768px) {
    .req summary { flex-wrap: wrap; }
    .req-body { padding-left: var(--space-4); }
  }
</style>
