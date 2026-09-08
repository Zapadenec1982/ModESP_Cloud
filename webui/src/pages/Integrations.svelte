<script>
  // Integrations (plan epic 2.6): the organisation's API keys and webhooks.
  // Admin-only. A key or a signing secret is shown exactly once, right after
  // it is created; the lists never carry it again.
  import { onMount } from 'svelte'
  import {
    getApiKeys, createApiKey, revokeApiKey,
    getWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, rotateWebhookSecret,
    getWebhookDeliveries, redeliverWebhook,
  } from '../lib/api.js'
  import { hasPlanFeature, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { formatDate } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'

  const SCOPES = ['read', 'write', 'admin']
  const EXPIRY = ['', '30', '90', '365']
  const DELIVERY_STATUSES = ['', 'pending', 'ok', 'failed', 'dead']
  const API_BASE = `${window.location.origin}/api`

  let loading = true
  let keys = []
  let hooks = []
  let events = []
  $: apiAllowed = $isSuperAdmin || $hasPlanFeature('api')

  // ── API keys ──
  let keyForm = null            // null | { name, scope, expires }
  let keySaving = false
  let revealedKey = null        // { name, key } shown once after creation

  // ── Webhooks ──
  let hookForm = null           // null | { id?, name, url, events: Set, enabled }
  let hookSaving = false
  let revealedSecret = null     // { name, secret, rotated }
  let testing = null
  let openDeliveries = null     // hook id whose deliveries are expanded
  let deliveries = []
  let deliveriesLoading = false
  let deliveryFilter = ''
  let expandedPayload = null

  async function load() {
    loading = true
    try {
      const [k, w] = await Promise.all([getApiKeys(), getWebhooks()])
      keys = k || []
      hooks = w.data || []
      events = w.meta?.events || []
    } catch (e) {
      toast.error(e.message)
    } finally {
      loading = false
    }
  }

  onMount(load)

  async function copy(text, doneKey) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success($t(doneKey || 'integrations.copied'))
    } catch {
      toast.error($t('integrations.copy_failed'))
    }
  }

  // ── API keys ──

  function openKeyForm() {
    keyForm = { name: '', scope: 'read', expires: '' }
    revealedKey = null
  }

  async function saveKey() {
    if (!keyForm.name.trim()) return
    keySaving = true
    try {
      const body = { name: keyForm.name.trim(), scope: keyForm.scope }
      if (keyForm.expires) body.expires_in_days = Number(keyForm.expires)
      const row = await createApiKey(body)
      revealedKey = { name: row.name, key: row.key }
      keyForm = null
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      keySaving = false
    }
  }

  async function revoke(k) {
    if (!confirm($t('integrations.key_revoke_confirm', k.name))) return
    try {
      await revokeApiKey(k.id)
      toast.success($t('integrations.key_revoked'))
      await load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const keyState = (k) => (k.revoked_at ? 'revoked' : (k.expires_at && new Date(k.expires_at) < new Date()) ? 'expired' : 'active')
  const keyVariant = (st) => (st === 'active' ? 'success' : 'neutral')
  const scopeVariant = (s) => (s === 'admin' ? 'danger' : s === 'write' ? 'warning' : 'info')

  // ── Webhooks ──

  function openHookForm(h) {
    revealedSecret = null
    hookForm = h
      ? { id: h.id, name: h.name, url: h.url, events: new Set(h.events), enabled: h.enabled }
      : { name: '', url: '', events: new Set(['alarm.raised', 'alarm.cleared']), enabled: true }
  }

  function toggleEvent(ev) {
    const next = new Set(hookForm.events)
    if (ev === '*') { next.clear(); next.add('*') }
    else { next.delete('*'); if (next.has(ev)) next.delete(ev); else next.add(ev) }
    hookForm = { ...hookForm, events: next }
  }

  async function saveHook() {
    if (!hookForm.name.trim() || !hookForm.url.trim()) return
    if (hookForm.events.size === 0) { toast.error($t('integrations.hook_events_required')); return }
    hookSaving = true
    try {
      const body = { name: hookForm.name.trim(), url: hookForm.url.trim(), events: [...hookForm.events], enabled: hookForm.enabled }
      if (hookForm.id) {
        await updateWebhook(hookForm.id, body)
        toast.success($t('integrations.hook_saved'))
      } else {
        const row = await createWebhook(body)
        revealedSecret = { name: row.name, secret: row.secret, rotated: false }
      }
      hookForm = null
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      hookSaving = false
    }
  }

  async function toggleHook(h) {
    try {
      await updateWebhook(h.id, { enabled: !h.enabled })
      await load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function removeHook(h) {
    if (!confirm($t('integrations.hook_delete_confirm', h.name))) return
    try {
      await deleteWebhook(h.id)
      toast.success($t('integrations.hook_deleted'))
      if (openDeliveries === h.id) openDeliveries = null
      await load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function ping(h) {
    testing = h.id
    try {
      const r = await testWebhook(h.id)
      if (r.ok) toast.success($t('integrations.hook_test_ok', r.status_code, r.duration_ms))
      else toast.error($t('integrations.hook_test_failed', r.status_code || '—', r.error || ''), 8000)
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      testing = null
    }
  }

  async function rotate(h) {
    if (!confirm($t('integrations.hook_rotate_confirm', h.name))) return
    try {
      const r = await rotateWebhookSecret(h.id)
      revealedSecret = { name: h.name, secret: r.secret, rotated: true }
      hookForm = null
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function showDeliveries(h) {
    if (openDeliveries === h.id) { openDeliveries = null; return }
    openDeliveries = h.id
    expandedPayload = null
    await loadDeliveries()
  }

  async function loadDeliveries() {
    if (!openDeliveries) return
    deliveriesLoading = true
    try {
      deliveries = await getWebhookDeliveries(openDeliveries, { limit: 50, status: deliveryFilter })
    } catch (e) {
      toast.error(e.message)
      deliveries = []
    } finally {
      deliveriesLoading = false
    }
  }

  async function redeliver(d) {
    try {
      await redeliverWebhook(openDeliveries, d.id)
      toast.success($t('integrations.redelivery_queued'))
      await loadDeliveries()
      await load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const hookVariant = (h) => (h.enabled ? (h.last_status && h.last_status >= 400 ? 'warning' : 'success') : 'neutral')
  const deliveryVariant = (st) => (st === 'ok' ? 'success' : st === 'pending' ? 'warning' : st === 'failed' ? 'warning' : 'danger')
  const eventLabel = (ev) => (ev === '*' ? $t('integrations.event_all') : ev)
  const shortUrl = (u) => (u.length > 60 ? u.slice(0, 57) + '…' : u)
  const answerText = (d) => {
    const parts = []
    if (d.status_code) parts.push(`HTTP ${d.status_code}`)
    if (d.duration_ms != null) parts.push(`${d.duration_ms} ms`)
    return parts.length ? parts.join(' · ') : (d.error ? '' : '—')
  }
</script>

<div class="integrations">
  <PageHeader title={$t('pages.integrations')} subtitle={$t('pages.integrations_sub')}>
    <Button variant="secondary" size="sm" on:click={load}><Icon name="refresh" size={14} /> {$t('common.refresh')}</Button>
  </PageHeader>

  {#if !loading && !apiAllowed}
    <div class="notice">
      <Icon name="alert-triangle" size={16} />
      <span>{$t('integrations.plan_notice')}</span>
    </div>
  {/if}

  <!-- ── API keys ── -->
  <section class="card">
    <div class="card-head">
      <h2><Icon name="key" size={18} /> {$t('integrations.keys_title')}</h2>
      <div class="head-actions">
        <span class="count">{keys.filter(k => keyState(k) === 'active').length}</span>
        <Button size="sm" on:click={openKeyForm} disabled={!apiAllowed || !!keyForm}><Icon name="plus" size={14} /> {$t('integrations.key_new')}</Button>
      </div>
    </div>
    <p class="muted">{$t('integrations.keys_intro')}</p>

    {#if revealedKey}
      <div class="reveal">
        <strong>{$t('integrations.key_created', revealedKey.name)}</strong>
        <p class="muted">{$t('integrations.shown_once')}</p>
        <div class="secret-row">
          <code>{revealedKey.key}</code>
          <Button size="sm" variant="secondary" on:click={() => copy(revealedKey.key)}><Icon name="clipboard" size={14} /> {$t('integrations.copy')}</Button>
        </div>
        <pre class="usage">curl -H "Authorization: Bearer {revealedKey.key}" {API_BASE}/devices</pre>
        <div class="row"><Button size="sm" variant="ghost" on:click={() => (revealedKey = null)}>{$t('integrations.done')}</Button></div>
      </div>
    {/if}

    {#if keyForm}
      <form class="inline-form" on:submit|preventDefault={saveKey}>
        <label>
          <span>{$t('integrations.key_name')}</span>
          <input type="text" bind:value={keyForm.name} maxlength="80" placeholder="CMMS, Grafana, 1C…" required disabled={keySaving} />
        </label>
        <label>
          <span>{$t('integrations.key_scope')}</span>
          <select bind:value={keyForm.scope} disabled={keySaving}>
            {#each SCOPES as s}<option value={s}>{$t('integrations.scope_' + s)}</option>{/each}
          </select>
        </label>
        <label>
          <span>{$t('integrations.key_expires')}</span>
          <select bind:value={keyForm.expires} disabled={keySaving}>
            {#each EXPIRY as d}<option value={d}>{d ? $t('integrations.key_expires_days', d) : $t('integrations.key_expires_never')}</option>{/each}
          </select>
        </label>
        <p class="muted small wide">{$t('integrations.scope_hint_' + keyForm.scope)}</p>
        <div class="row wide">
          <Button size="sm" type="submit" disabled={keySaving}>{$t('integrations.key_create')}</Button>
          <Button size="sm" variant="ghost" type="button" on:click={() => (keyForm = null)} disabled={keySaving}>{$t('common.cancel')}</Button>
        </div>
      </form>
    {/if}

    {#if loading && keys.length === 0}
      <Skeleton height="80px" />
    {:else if keys.length === 0}
      <p class="muted">{$t('integrations.keys_none')}</p>
    {:else}
      <div class="table">
        <div class="thead keys">
          <span>{$t('integrations.col_name')}</span>
          <span>{$t('integrations.col_prefix')}</span>
          <span>{$t('integrations.col_scope')}</span>
          <span>{$t('integrations.col_created')}</span>
          <span>{$t('integrations.col_last_used')}</span>
          <span>{$t('integrations.col_expires')}</span>
          <span></span>
        </div>
        {#each keys as k (k.id)}
          {@const st = keyState(k)}
          <div class="trow keys" class:off={st !== 'active'}>
            <span class="cell"><strong>{k.name}</strong><Badge variant={keyVariant(st)} size="sm">{$t('integrations.key_state_' + st)}</Badge></span>
            <span class="cell mono">{k.prefix}…</span>
            <span class="cell"><Badge variant={scopeVariant(k.scope)} size="sm">{$t('integrations.scope_' + k.scope)}</Badge></span>
            <span class="cell">{formatDate(k.created_at)}</span>
            <span class="cell">{k.last_used_at ? formatDate(k.last_used_at) : $t('integrations.never_used')}</span>
            <span class="cell">{k.expires_at ? formatDate(k.expires_at) : '—'}</span>
            <span class="cell actions">
              {#if st === 'active'}
                <Button size="sm" variant="ghost" on:click={() => revoke(k)} title={$t('integrations.key_revoke')}><Icon name="trash" size={14} /></Button>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
    <p class="muted small">{$t('integrations.keys_hint')} <code class="inline">{API_BASE}</code> · <a href="/api/docs" target="_blank" rel="noopener">{$t('integrations.docs_link')}</a></p>
  </section>

  <!-- ── Webhooks ── -->
  <section class="card">
    <div class="card-head">
      <h2><Icon name="zap" size={18} /> {$t('integrations.hooks_title')}</h2>
      <div class="head-actions">
        <span class="count">{hooks.length}</span>
        <Button size="sm" on:click={() => openHookForm(null)} disabled={!apiAllowed || !!hookForm}><Icon name="plus" size={14} /> {$t('integrations.hook_new')}</Button>
      </div>
    </div>
    <p class="muted">{$t('integrations.hooks_intro')}</p>

    {#if revealedSecret}
      <div class="reveal">
        <strong>{$t(revealedSecret.rotated ? 'integrations.hook_secret_rotated' : 'integrations.hook_created', revealedSecret.name)}</strong>
        <p class="muted">{$t('integrations.shown_once')}</p>
        <div class="secret-row">
          <code>{revealedSecret.secret}</code>
          <Button size="sm" variant="secondary" on:click={() => copy(revealedSecret.secret)}><Icon name="clipboard" size={14} /> {$t('integrations.copy')}</Button>
        </div>
        <p class="muted small">{$t('integrations.signature_hint')}</p>
        <pre class="usage">X-ModESP-Signature: v1=HMAC_SHA256(secret, "&#123;X-ModESP-Timestamp&#125;." + body)</pre>
        <div class="row"><Button size="sm" variant="ghost" on:click={() => (revealedSecret = null)}>{$t('integrations.done')}</Button></div>
      </div>
    {/if}

    {#if hookForm}
      <form class="inline-form" on:submit|preventDefault={saveHook}>
        <label>
          <span>{$t('integrations.hook_name')}</span>
          <input type="text" bind:value={hookForm.name} maxlength="80" required disabled={hookSaving} />
        </label>
        <label class="wide2">
          <span>{$t('integrations.hook_url')}</span>
          <input type="url" bind:value={hookForm.url} maxlength="2048" placeholder="https://example.com/modesp/webhook" required disabled={hookSaving} />
        </label>
        <div class="wide">
          <span class="label">{$t('integrations.hook_events')}</span>
          <div class="events">
            <label class="check all"><input type="checkbox" checked={hookForm.events.has('*')} on:change={() => toggleEvent('*')} disabled={hookSaving} /> {$t('integrations.event_all')}</label>
            {#each events as ev}
              <label class="check"><input type="checkbox" checked={hookForm.events.has(ev) || hookForm.events.has('*')} on:change={() => toggleEvent(ev)} disabled={hookSaving || hookForm.events.has('*')} /> <code class="inline">{ev}</code></label>
            {/each}
          </div>
        </div>
        <label class="check wide">
          <input type="checkbox" bind:checked={hookForm.enabled} disabled={hookSaving} /> {$t('integrations.hook_enabled')}
        </label>
        <p class="muted small wide">{$t('integrations.hook_url_hint')}</p>
        <div class="row wide">
          <Button size="sm" type="submit" disabled={hookSaving}>{hookForm.id ? $t('integrations.hook_save') : $t('integrations.hook_create')}</Button>
          <Button size="sm" variant="ghost" type="button" on:click={() => (hookForm = null)} disabled={hookSaving}>{$t('common.cancel')}</Button>
        </div>
      </form>
    {/if}

    {#if loading && hooks.length === 0}
      <Skeleton height="80px" />
    {:else if hooks.length === 0}
      <p class="muted">{$t('integrations.hooks_none')}</p>
    {:else}
      <div class="table">
        <div class="thead hooks">
          <span>{$t('integrations.col_webhook')}</span>
          <span>{$t('integrations.col_events')}</span>
          <span>{$t('integrations.col_state')}</span>
          <span>{$t('integrations.col_last_delivery')}</span>
          <span>{$t('integrations.col_queue')}</span>
          <span></span>
        </div>
        {#each hooks as h (h.id)}
          <div class="trow hooks" class:off={!h.enabled}>
            <span class="cell">
              <strong>{h.name}</strong>
              <small class="mono" title={h.url}>{shortUrl(h.url)}</small>
            </span>
            <span class="cell events-cell" title={h.events.join(', ')}>
              {#if h.events.includes('*')}{$t('integrations.event_all')}{:else}{$t('integrations.events_count', h.events.length)}{/if}
            </span>
            <span class="cell">
              <Badge variant={hookVariant(h)} size="sm">{h.enabled ? $t('integrations.hook_on') : $t('integrations.hook_off')}</Badge>
              {#if !h.enabled && h.disabled_reason === 'failures'}<small class="err">{$t('integrations.hook_disabled_failures')}</small>{/if}
              {#if h.enabled && h.failures > 0}<small class="err">{$t('integrations.hook_failures', h.failures)}</small>{/if}
            </span>
            <span class="cell">
              {#if h.last_delivery_at}
                {formatDate(h.last_delivery_at)}
                <small>{h.last_status ? `HTTP ${h.last_status}` : $t('integrations.no_answer')}</small>
              {:else}—{/if}
            </span>
            <span class="cell">
              {#if h.pending}<Badge variant="warning" size="sm">{$t('integrations.queue_pending', h.pending)}</Badge>{/if}
              {#if h.dead}<Badge variant="danger" size="sm">{$t('integrations.queue_dead', h.dead)}</Badge>{/if}
              {#if !h.pending && !h.dead}—{/if}
            </span>
            <span class="cell actions">
              <Button size="sm" variant="secondary" disabled={testing === h.id} on:click={() => ping(h)}>{testing === h.id ? $t('integrations.testing') : $t('integrations.hook_test')}</Button>
              <Button size="sm" variant={openDeliveries === h.id ? 'primary' : 'ghost'} on:click={() => showDeliveries(h)}>{$t('integrations.deliveries')}</Button>
              <Button size="sm" variant="ghost" on:click={() => toggleHook(h)}>{h.enabled ? $t('integrations.hook_disable') : $t('integrations.hook_enable')}</Button>
              <Button size="sm" variant="ghost" on:click={() => openHookForm(h)} title={$t('integrations.hook_edit')}><Icon name="edit" size={14} /></Button>
              <Button size="sm" variant="ghost" on:click={() => rotate(h)} title={$t('integrations.hook_rotate')}><Icon name="refresh" size={14} /></Button>
              <Button size="sm" variant="ghost" on:click={() => removeHook(h)} title={$t('common.delete')}><Icon name="trash" size={14} /></Button>
            </span>
          </div>
          {#if openDeliveries === h.id}
            <div class="deliveries">
              <div class="filters">
                <strong>{$t('integrations.deliveries_title', h.name)}</strong>
                <select bind:value={deliveryFilter} on:change={loadDeliveries}>
                  {#each DELIVERY_STATUSES as st}<option value={st}>{st ? $t('integrations.delivery_' + st) : $t('integrations.delivery_any')}</option>{/each}
                </select>
                <Button size="sm" variant="ghost" on:click={loadDeliveries}><Icon name="refresh" size={14} /></Button>
              </div>
              {#if deliveriesLoading && deliveries.length === 0}
                <Skeleton height="60px" />
              {:else if deliveries.length === 0}
                <p class="muted">{$t('integrations.deliveries_none')}</p>
              {:else}
                <div class="thead dlv">
                  <span>{$t('integrations.col_time')}</span>
                  <span>{$t('integrations.col_event')}</span>
                  <span>{$t('integrations.col_state')}</span>
                  <span>{$t('integrations.col_attempts')}</span>
                  <span>{$t('integrations.col_answer')}</span>
                  <span></span>
                </div>
                {#each deliveries as d (d.id)}
                  <div class="trow dlv">
                    <span class="cell">{formatDate(d.created_at)}</span>
                    <span class="cell mono">{d.event}</span>
                    <span class="cell">
                      <Badge variant={deliveryVariant(d.status)} size="sm">{$t('integrations.delivery_' + d.status)}</Badge>
                      {#if d.status === 'pending' && d.next_attempt_at}<small>{$t('integrations.next_attempt', formatDate(d.next_attempt_at))}</small>{/if}
                    </span>
                    <span class="cell">{d.attempts}</span>
                    <span class="cell">
                      {answerText(d)}
                      {#if d.error}<small class="err" title={d.error}>{d.error}</small>{/if}
                    </span>
                    <span class="cell actions">
                      <Button size="sm" variant="ghost" on:click={() => (expandedPayload = expandedPayload === d.id ? null : d.id)}>{$t('integrations.payload')}</Button>
                      {#if d.status !== 'pending'}
                        <Button size="sm" variant="ghost" on:click={() => redeliver(d)}>{$t('integrations.redeliver')}</Button>
                      {/if}
                    </span>
                  </div>
                  {#if expandedPayload === d.id}
                    <pre class="payload">{JSON.stringify(d.payload, null, 2)}</pre>
                  {/if}
                {/each}
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    <p class="muted small">{$t('integrations.hooks_hint')}</p>
  </section>
</div>

<style>
  .integrations { display: flex; flex-direction: column; gap: var(--space-4); }
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
  .card-head h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .head-actions { display: flex; align-items: center; gap: var(--space-2); }
  .count { font-size: var(--text-xs); color: var(--text-muted); background: var(--bg-tertiary); border-radius: 999px; padding: 2px 8px; }
  .muted { color: var(--text-muted); font-size: var(--text-sm); margin: 0 0 var(--space-3); line-height: 1.5; }
  .muted.small { font-size: var(--text-xs); margin: var(--space-2) 0 0; }
  .row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
  .wide { grid-column: 1 / -1; }
  .wide2 { grid-column: span 2; }

  .notice {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-3); border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent-orange, #f59e0b) 12%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--accent-orange, #f59e0b) 40%, transparent);
    color: var(--text-primary); font-size: var(--text-sm);
  }

  .reveal {
    padding: var(--space-3); margin-bottom: var(--space-3);
    background: color-mix(in srgb, var(--accent-green, #22c55e) 10%, var(--bg-tertiary));
    border: 1px solid color-mix(in srgb, var(--accent-green, #22c55e) 40%, transparent);
    border-radius: var(--radius-sm);
  }
  .reveal strong { color: var(--text-primary); }
  .reveal .muted { margin: var(--space-1) 0 var(--space-2); }
  .secret-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .secret-row code {
    flex: 1 1 320px; padding: var(--space-2) var(--space-3);
    background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-primary); word-break: break-all; user-select: all;
  }
  .usage, .payload {
    margin: var(--space-2) 0 0; padding: var(--space-2) var(--space-3);
    background: var(--bg-primary); border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
    font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-all; overflow-x: auto;
  }
  .payload { max-height: 320px; overflow: auto; }
  code.inline { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-secondary); }
  .muted a { color: var(--accent-blue, #3b82f6); text-decoration: none; }
  .muted a:hover { text-decoration: underline; }

  .inline-form {
    display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: var(--space-3);
    padding: var(--space-3); margin-bottom: var(--space-3);
    background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  }
  .inline-form label, .inline-form .label { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-xs); color: var(--text-muted); }
  .inline-form .row { margin-top: 0; }
  .inline-form .muted { margin: 0; }
  .inline-form input, .inline-form select, .filters select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    color: var(--text-primary); font-family: var(--font-sans); font-size: var(--text-sm);
  }
  .events { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); margin-top: var(--space-2); }
  .check { display: flex; flex-direction: row !important; align-items: center; gap: var(--space-2); font-size: var(--text-sm) !important; color: var(--text-secondary) !important; }
  .check.all { font-weight: 600; color: var(--text-primary) !important; flex-basis: 100%; }

  .table { display: flex; flex-direction: column; font-size: var(--text-sm); overflow-x: auto; }
  .thead, .trow { display: grid; gap: var(--space-3); align-items: center; padding: var(--space-2) 0; }
  .thead.keys, .trow.keys { grid-template-columns: 1.4fr 1fr 0.8fr 1fr 1fr 1fr auto; min-width: 860px; }
  .thead.hooks, .trow.hooks { grid-template-columns: 1.8fr 0.8fr 1fr 1.1fr 0.9fr auto; min-width: 960px; }
  .thead.dlv, .trow.dlv { grid-template-columns: 1fr 1.2fr 1fr 0.5fr 1.4fr auto; min-width: 760px; }
  .thead { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); border-bottom: 1px solid var(--border-default); }
  .trow { border-bottom: 1px solid var(--border-muted); }
  .trow.off { opacity: 0.6; }
  .cell { color: var(--text-secondary); word-break: break-word; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
  .cell strong { color: var(--text-primary); font-weight: 600; }
  .cell small { color: var(--text-muted); font-size: var(--text-xs); }
  .cell small.err { color: var(--accent-red); }
  .cell.mono, .cell small.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .cell.actions { flex-direction: row; flex-wrap: wrap; gap: var(--space-1); justify-content: flex-end; align-items: center; }
  .events-cell { cursor: help; }

  .deliveries {
    margin: 0 0 var(--space-2); padding: var(--space-3);
    background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
    min-width: 960px;
  }
  .filters { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
  .filters strong { flex: 1; color: var(--text-primary); font-size: var(--text-sm); }

  @media (max-width: 900px) {
    .inline-form { grid-template-columns: 1fr 1fr; }
    .wide2 { grid-column: 1 / -1; }
  }
</style>
