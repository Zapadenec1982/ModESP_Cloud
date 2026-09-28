<script>
  import { onMount } from 'svelte'
  import {
    getSubscribers,
    createSubscriber,
    deleteSubscriber,
    testNotification,
    getNotificationLog,
    getMyNotificationPrefs,
    updateMyNotificationPrefs,
    testMyNotificationChannel,
    generateMyTelegramLink,
    unlinkMyTelegram,
    getProfile,
    updateProfile,
  } from '../lib/api.js'
  import { isAdmin, authUser } from '../lib/stores.js'
  import { timeAgo } from '../lib/format.js'
  import { t, setLocale, supportedLocales } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'

  let subscribers = []
  let log = []
  let loading = true
  let error = null

  // Add form
  let newChannel = 'telegram'
  let newAddress = ''
  let newLabel = ''
  let adding = false

  // Test status per subscriber
  let testingIds = new Set()

  // ── My notifications (every role) ──
  let prefs = null
  // Own language and time zone (users.locale / users.timezone, plan epic 2.11); '' = as the organisation
  let profile = null
  let savedProfile = { locale: null, timezone: null }
  let savingPrefs = false
  // How many devices actually hold a web push subscription (the mobile app
  // creates them; this WebUI has no service worker and cannot).
  let webpushDevices = 0
  // Channel readiness (product audit item 4): three facts per channel — on the
  // platform at all, this person reachable on it, last delivery — shown apart
  // from the «send here» preference, which used to pass for readiness.
  let channels = null
  let testingChannel = null
  let tgCode = null        // { link_code, expires_at } while linking
  let tgBusy = false
  // Admin: manual Chat ID / FCM entry is an integration path, folded away
  let showAdvanced = false

  async function savePrefs() {
    savingPrefs = true
    try {
      if (profile && ((profile.locale || null) !== savedProfile.locale || (profile.timezone.trim() || null) !== savedProfile.timezone)) {
        const p = await updateProfile({ locale: profile.locale || null, timezone: profile.timezone.trim() || null })
        savedProfile = { locale: p.locale, timezone: p.timezone }
        authUser.update(u => u ? { ...u, locale: p.locale, timezone: p.timezone } : u)
        if (p.locale) setLocale(p.locale)
      }
      prefs = await updateMyNotificationPrefs({
        enabled: prefs.enabled,
        min_severity: prefs.min_severity,
        telegram: prefs.telegram,
        webpush: prefs.webpush,
        email: prefs.email,
        quiet_from: prefs.quiet_from || null,
        quiet_to: prefs.quiet_to || null,
        // Empty means «the time zone on my profile» — the server falls back to
        // users.timezone. Sending 'Europe/Kyiv' here is what pinned a Warsaw
        // user's quiet window to Kyiv.
        quiet_tz: prefs.quiet_tz?.trim() || null,
      })
      webpushDevices = prefs.webpush_devices ?? webpushDevices
      channels = prefs.channels || channels
      toast.success($t('notifications.saved'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      savingPrefs = false
    }
  }

  async function load() {
    try {
      prefs = await getMyNotificationPrefs()
      webpushDevices = prefs.webpush_devices || 0
      channels = prefs.channels || null
      try {
        const p = await getProfile()
        profile = { locale: p.locale || '', timezone: p.timezone || '' }
        savedProfile = { locale: p.locale || null, timezone: p.timezone || null }
      } catch { profile = null }
      if ($isAdmin) {
        const [subs, entries] = await Promise.all([
          getSubscribers(),
          getNotificationLog({ limit: 50 }),
        ])
        subscribers = subs
        log = entries
      }
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleAdd() {
    if (!newAddress.trim()) {
      toast.warning($t('notifications.address_required'))
      return
    }
    adding = true
    try {
      await createSubscriber({
        channel: newChannel,
        address: newAddress.trim(),
        label: newLabel.trim() || undefined,
      })
      toast.success($t('notifications.subscriber_added'))
      newAddress = ''
      newLabel = ''
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      adding = false
    }
  }

  async function handleDelete(sub) {
    try {
      await deleteSubscriber(sub.id)
      toast.success($t('notifications.subscriber_removed'))
      await load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function handleTest(sub) {
    testingIds.add(sub.id)
    testingIds = testingIds
    try {
      const result = await testNotification(sub.id)
      if (result.status === 'sent') {
        toast.success($t('notifications.test_sent', sub.label || sub.address))
      } else {
        toast.error($t('notifications.test_failed', result.error))
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      testingIds.delete(sub.id)
      testingIds = testingIds
    }
  }

  // ── Channel cards ──

  async function refreshChannels() {
    try {
      const fresh = await getMyNotificationPrefs()
      channels = fresh.channels || channels
      webpushDevices = fresh.webpush_devices ?? webpushDevices
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function testChannel(channel) {
    testingChannel = channel
    try {
      const r = await testMyNotificationChannel(channel)
      if (r.status === 'sent') toast.success($t('notifications.test_channel_sent'))
      else toast.error($t('notifications.test_failed', r.error || ''))
    } catch (e) {
      // 409 carries why the channel cannot even be tried — that is the advice
      const reason = e.status === 409 && e.body && e.body.reason
      if (reason) toast.warning($t('notifications.not_ready_' + reason))
      else toast.error(e.message)
    } finally {
      testingChannel = null
      await refreshChannels()
    }
  }

  async function linkTelegram() {
    tgBusy = true
    try {
      tgCode = await generateMyTelegramLink()
    } catch (e) {
      toast.error(e.message)
    } finally {
      tgBusy = false
    }
  }

  async function unlinkTelegram() {
    try {
      await unlinkMyTelegram()
      tgCode = null
      toast.success($t('notifications.tg_unlinked'))
      await refreshChannels()
    } catch (e) {
      toast.error(e.message)
    }
  }

  function tgDeepLink(ch, code) {
    return ch.bot_username ? `https://t.me/${ch.bot_username.replace(/^@/, '')}?start=${code.link_code}` : null
  }

  // The badge says what the channel *is*; `t` is passed in so the markup
  // re-renders when the language changes.
  function channelBadge(name, ch, t) {
    if (!ch.available) return { variant: 'neutral', label: t('notifications.ch_unavailable') }
    if (name === 'telegram') {
      return ch.linked ? { variant: 'success', label: t('notifications.ch_connected') } : { variant: 'warning', label: t('notifications.ch_not_connected') }
    }
    if (name === 'webpush') {
      return ch.devices > 0 ? { variant: 'success', label: t('notifications.ch_connected_devices', ch.devices) } : { variant: 'warning', label: t('notifications.ch_not_connected') }
    }
    return { variant: 'success', label: t('notifications.ch_connected') }
  }

  function lastLine(last, t) {
    if (!last) return t('notifications.ch_never_tested')
    return last.status === 'sent'
      ? t('notifications.ch_last_ok', timeAgo(last.at))
      : t('notifications.ch_last_failed', timeAgo(last.at), last.error || '')
  }

  const CHANNEL_CARDS = [['telegram', 'send', 'Telegram'], ['webpush', 'bell', 'Web Push'], ['email', 'mail', 'Email']]

  function statusVariant(status) {
    if (status === 'sent') return 'success'
    if (status === 'failed') return 'danger'
    return 'neutral'
  }

  onMount(load)
</script>

<div class="notif-page">
  <PageHeader title={$t('pages.notifications')} subtitle={$t('pages.notifications_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="200px" />
    <Skeleton height="300px" />
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load" message={error} />
  {:else}
    <!-- My notifications (plan epic 1.6) -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="user" size={16} />
        <span>{$t('notifications.my_title')}</span>
      </div>
      <form class="prefs-form" on:submit|preventDefault={savePrefs}>
        <p class="field-hint">{$t('notifications.my_hint')}</p>
        <label class="prefs-toggle">
          <input type="checkbox" bind:checked={prefs.enabled} />
          <span>{$t('notifications.enabled')}</span>
        </label>

        <!-- One card per channel. The badge says what the channel *is* (on the
             platform, reachable, last delivery); the checkbox underneath is only
             «send here». The two used to be one tick, and a tick looked like a
             working channel. -->
        {#if channels}
          <p class="field-hint">{$t('notifications.channels_hint')}</p>
          <div class="channel-cards">
            {#each CHANNEL_CARDS as [name, icon, title] (name)}
              {@const ch = channels[name]}
              {@const badge = channelBadge(name, ch, $t)}
              <div class="channel-card" class:is-off={!ch.available}>
                <div class="channel-head">
                  <Icon name={icon} size={16} />
                  <span class="channel-name">{title}</span>
                  <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
                </div>
                <p class="channel-detail">
                  {#if name === 'email'}{$t('notifications.email_to', ch.address || '—')}
                  {:else if name === 'webpush'}{$t('notifications.webpush_how')}
                  {:else if ch.linked}{$t('notifications.tg_linked_hint')}
                  {:else}{$t('notifications.tg_not_linked_hint')}{/if}
                </p>
                <p class="channel-last" class:is-failed={ch.last && ch.last.status !== 'sent'}>{lastLine(ch.last, $t)}</p>
                {#if ch.available}
                  <div class="channel-actions">
                    {#if name === 'telegram' && !ch.linked}
                      <Button variant="primary" size="sm" icon="link" loading={tgBusy} on:click={linkTelegram}>{$t('notifications.connect_telegram')}</Button>
                    {:else if name === 'webpush' && !(ch.devices > 0)}
                      <a class="btn-link" href="/app/" target="_blank" rel="noopener">{$t('notifications.enable_on_phone')} →</a>
                    {:else}
                      <Button variant="secondary" size="sm" icon="send" loading={testingChannel === name} on:click={() => testChannel(name)}>{$t('notifications.check_delivery')}</Button>
                    {/if}
                    {#if name === 'telegram' && ch.linked}
                      <Button variant="ghost" size="sm" on:click={unlinkTelegram}>{$t('notifications.disconnect')}</Button>
                    {/if}
                  </div>
                  {#if name === 'telegram' && !ch.linked && tgCode}
                    <div class="tg-link">
                      {#if tgDeepLink(ch, tgCode)}
                        <a class="btn-link" href={tgDeepLink(ch, tgCode)} target="_blank" rel="noopener">{$t('notifications.tg_open_bot')} →</a>
                      {/if}
                      <span>{$t('notifications.tg_send_code')}</span>
                      <code class="tg-cmd">/start {tgCode.link_code}</code>
                      <span class="field-hint">{$t('notifications.tg_code_expires')}</span>
                      <div><Button variant="ghost" size="sm" icon="refresh" on:click={refreshChannels}>{$t('common.refresh')}</Button></div>
                    </div>
                  {/if}
                {/if}
                <label class="channel-pref">
                  <input type="checkbox" bind:checked={prefs[name]} />
                  <span>{$t('notifications.send_here')}</span>
                </label>
              </div>
            {/each}
          </div>
        {/if}
        <div class="prefs-grid">
          <div class="form-field">
            <label class="field-label" for="pref-sev">{$t('notifications.min_severity')}</label>
            <select id="pref-sev" class="input" bind:value={prefs.min_severity}>
              <option value="info">{$t('alarm.info')}</option>
              <option value="warning">{$t('alarm.warning')}</option>
              <option value="critical">{$t('alarm.critical')}</option>
            </select>
          </div>
          <!-- One time zone: the profile's. Two fields called «time zone» sat
               one under the other, and the profile-wide one was labelled
               «of notifications»; migration 051 made the quiet-hours zone
               follow the profile, so it is shown after the quiet hours as
               the override it is. -->
          {#if profile}
            <div class="form-field">
              <label class="field-label" for="pref-locale">{$t('notifications.pref_locale')}</label>
              <select id="pref-locale" class="input" bind:value={profile.locale}>
                <option value="">{$t('notifications.pref_locale_org')}</option>
                {#each supportedLocales as l}<option value={l.code}>{l.label}</option>{/each}
              </select>
            </div>
            <div class="form-field">
              <label class="field-label" for="pref-user-tz">{$t('notifications.pref_timezone')}</label>
              <input id="pref-user-tz" type="text" class="input" bind:value={profile.timezone} placeholder={$t('notifications.pref_locale_org')} />
            </div>
          {/if}
          <div class="form-field">
            <label class="field-label" for="pref-qf">{$t('notifications.quiet_from')}</label>
            <input id="pref-qf" type="time" class="input" bind:value={prefs.quiet_from} />
          </div>
          <div class="form-field">
            <label class="field-label" for="pref-qt">{$t('notifications.quiet_to')}</label>
            <input id="pref-qt" type="time" class="input" bind:value={prefs.quiet_to} />
          </div>
          <div class="form-field">
            <label class="field-label" for="pref-tz">{$t('notifications.quiet_tz')}</label>
            <input id="pref-tz" type="text" class="input" bind:value={prefs.quiet_tz}
                   placeholder={$t('notifications.quiet_tz_profile')} />
          </div>
        </div>
        <p class="field-hint">{$t('notifications.quiet_hint')} {$t('notifications.pref_timezone_hint')}</p>
        <div class="prefs-actions">
          <Button variant="primary" type="submit" loading={savingPrefs} icon="check">{$t('notifications.save')}</Button>
        </div>
      </form>
    </section>

    {#if $isAdmin}
    <!-- Manual addressees (Chat ID / FCM token) are an integration path, not how
         a person connects a channel — folded away so the page leads with the
         person's own channels. -->
    <button type="button" class="advanced-toggle" on:click={() => showAdvanced = !showAdvanced} aria-expanded={showAdvanced}>
      <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />
      <span>{$t('notifications.advanced')}</span>
      <Badge variant="neutral" size="sm">{subscribers.length}</Badge>
    </button>
    {#if showAdvanced}
    <p class="field-hint advanced-hint">{$t('notifications.advanced_hint')}</p>
    <!-- Add Subscriber -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="plus" size={16} />
        <span>{$t('notifications.add_subscriber')}</span>
      </div>
      <form on:submit|preventDefault={handleAdd} class="add-form">
        <div class="form-field">
          <label class="field-label" for="sub-channel">{$t('notifications.channel')}</label>
          <select id="sub-channel" bind:value={newChannel} class="input">
            <option value="telegram">Telegram</option>
            <option value="fcm">FCM</option>
          </select>
        </div>
        <div class="form-field flex-grow">
          <label class="field-label" for="sub-address">{$t('notifications.address')}</label>
          <input
            id="sub-address"
            type="text"
            bind:value={newAddress}
            placeholder={newChannel === 'telegram' ? $t('notifications.chat_id') : $t('notifications.fcm_token')}
            class="input"
          />
        </div>
        <div class="form-field">
          <label class="field-label" for="sub-label">{$t('notifications.label')}</label>
          <input id="sub-label" type="text" bind:value={newLabel} placeholder={$t('notifications.optional')} class="input" />
        </div>
        <div class="form-field form-action">
          <Button variant="primary" type="submit" loading={adding} icon="plus">{$t('common.add')}</Button>
        </div>
      </form>
    </section>

    <!-- Subscribers -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="bell" size={16} />
        <span>{$t('notifications.subscribers')}</span>
        <Badge variant="neutral" size="sm">{subscribers.length}</Badge>
      </div>

      {#if subscribers.length === 0}
        <EmptyState
          icon="bell"
          title={$t('notifications.no_subscribers')}
          message={$t('notifications.no_subscribers_hint')}
        />
      {:else}
        <div class="sub-list">
          {#each subscribers as sub (sub.id)}
            <div class="sub-row">
              <div class="sub-channel">
                <Badge variant={sub.channel === 'telegram' ? 'info' : 'warning'} size="sm">
                  {sub.channel}
                </Badge>
              </div>
              <div class="sub-info">
                <span class="sub-address font-mono">{sub.address}</span>
                {#if sub.label}
                  <span class="sub-label">{sub.label}</span>
                {/if}
              </div>
              <span class="sub-since">{timeAgo(sub.created_at)}</span>
              <div class="sub-actions">
                <Button
                  variant="secondary" size="sm"
                  loading={testingIds.has(sub.id)}
                  on:click={() => handleTest(sub)}
                >{$t('common.test')}</Button>
                <Button variant="danger" size="sm" on:click={() => handleDelete(sub)} aria-label="Remove {sub.label || sub.address}">
                  <Icon name="trash" size={13} />
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    {/if}

    <!-- Delivery Log -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="activity" size={16} />
        <span>{$t('notifications.delivery_log')}</span>
      </div>

      {#if log.length === 0}
        <EmptyState icon="clock" title={$t('notifications.no_log')} message={$t('notifications.no_log_hint')} />
      {:else}
        <div class="log-table">
          <div class="log-header">
            <span class="th">{$t('notifications.col_time')}</span>
            <span class="th">{$t('notifications.col_channel')}</span>
            <span class="th">{$t('notifications.col_device')}</span>
            <span class="th">{$t('notifications.col_alarm')}</span>
            <span class="th">{$t('notifications.col_status')}</span>
            <span class="th">{$t('notifications.col_subscriber')}</span>
          </div>
          {#each log as entry (entry.id)}
            <div class="log-row">
              <span class="td text-muted">{timeAgo(entry.created_at)}</span>
              <span class="td">
                <Badge variant={entry.channel === 'telegram' ? 'info' : 'warning'} size="sm">
                  {entry.channel}
                </Badge>
              </span>
              <span class="td font-mono">{entry.device_id || '—'}</span>
              <span class="td">{entry.alarm_code || '—'}</span>
              <span class="td">
                <Badge variant={statusVariant(entry.status)} size="sm">{entry.status}</Badge>
                {#if entry.error_message}
                  <span class="error-indicator" title={entry.error_message}>
                    <Icon name="info" size={12} />
                  </span>
                {/if}
              </span>
              <span class="td text-muted">{entry.subscriber_label || entry.subscriber_address || '—'}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    {/if}
  {/if}
</div>

<style>
  .prefs-form { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .prefs-toggle { display: flex; align-items: center; gap: var(--space-2); font-weight: 500; }
  .prefs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
  .prefs-actions { display: flex; justify-content: flex-end; }

  /* Channel cards */
  .channel-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
  .channel-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-tertiary);
  }
  .channel-card.is-off { opacity: 0.7; }
  .channel-head { display: flex; align-items: center; gap: var(--space-2); }
  .channel-name { font-weight: 600; flex: 1; }
  .channel-detail, .channel-last { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }
  .channel-last.is-failed { color: var(--accent-red); }
  .channel-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  .channel-pref {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: auto;
    padding-top: var(--space-2);
    border-top: 1px dashed var(--border-muted);
    font-size: var(--text-sm);
  }
  .btn-link { font-size: var(--text-sm); color: var(--accent-blue); text-decoration: none; }
  .btn-link:hover { text-decoration: underline; }
  .tg-link { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); }
  .tg-cmd {
    font-family: var(--font-mono);
    background: var(--bg-surface);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    user-select: all;
    align-self: flex-start;
  }
  .advanced-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .advanced-hint { margin: 0; }

  .notif-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: fade-in 0.3s ease-out;
  }

  .section-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Add form */
  .add-form {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
    padding: var(--space-4);
    flex-wrap: wrap;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-field.flex-grow {
    flex: 1;
    min-width: 160px;
  }

  .form-action {
    padding-top: 18px;
  }

  .field-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }

  .input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input::placeholder {
    color: var(--text-muted);
  }

  select.input {
    cursor: pointer;
  }

  /* Subscribers list */
  .sub-list {
    display: flex;
    flex-direction: column;
  }

  .sub-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    transition: background var(--transition-fast);
  }

  .sub-row:last-child {
    border-bottom: none;
  }

  .sub-row:hover {
    background: var(--bg-tertiary);
  }

  .sub-channel {
    flex-shrink: 0;
    min-width: 80px;
  }

  .sub-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .sub-address {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .sub-since {
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .sub-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  /* Log table */
  .log-table {
    overflow-x: auto;
  }

  .log-header {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-default);
  }

  .th {
    flex: 1;
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .log-row {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    align-items: center;
  }

  .log-row:last-child {
    border-bottom: none;
  }

  .td {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--text-primary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .text-muted {
    color: var(--text-muted);
  }

  .font-mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .error-indicator {
    color: var(--accent-red);
    cursor: help;
    display: flex;
  }

  @media (max-width: 768px) {
    .log-header { display: none; }
    .log-row { flex-wrap: wrap; gap: var(--space-2); }
    .add-form { flex-direction: column; }
    .form-field.flex-grow { min-width: auto; }
  }
</style>
