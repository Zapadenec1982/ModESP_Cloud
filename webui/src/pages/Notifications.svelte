<script>
  import { onMount } from 'svelte'
  import {
    getSubscribers,
    createSubscriber,
    deleteSubscriber,
    testNotification,
    getNotificationLog,
  } from '../lib/api.js'
  import { timeAgo } from '../lib/format.js'
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

  async function load() {
    try {
      const [subs, entries] = await Promise.all([
        getSubscribers(),
        getNotificationLog({ limit: 50 }),
      ])
      subscribers = subs
      log = entries
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleAdd() {
    if (!newAddress.trim()) {
      toast.warning('Address is required')
      return
    }
    adding = true
    try {
      await createSubscriber({
        channel: newChannel,
        address: newAddress.trim(),
        label: newLabel.trim() || undefined,
      })
      toast.success('Subscriber added')
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
      toast.success('Subscriber removed')
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
        toast.success(`Test sent to ${sub.label || sub.address}`)
      } else {
        toast.error(`Test failed: ${result.error}`)
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      testingIds.delete(sub.id)
      testingIds = testingIds
    }
  }

  function statusVariant(status) {
    if (status === 'sent') return 'success'
    if (status === 'failed') return 'danger'
    return 'neutral'
  }

  onMount(load)
</script>

<div class="notif-page">
  <PageHeader title="Notifications" subtitle="Manage push notification subscribers and delivery">
    <Button variant="secondary" icon="refresh" on:click={load}>Refresh</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="200px" />
    <Skeleton height="300px" />
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load" message={error} />
  {:else}
    <!-- Add Subscriber -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="plus" size={16} />
        <span>Add Subscriber</span>
      </div>
      <form on:submit|preventDefault={handleAdd} class="add-form">
        <div class="form-field">
          <label class="field-label" for="sub-channel">Channel</label>
          <select id="sub-channel" bind:value={newChannel} class="input">
            <option value="telegram">Telegram</option>
            <option value="fcm">FCM</option>
          </select>
        </div>
        <div class="form-field flex-grow">
          <label class="field-label" for="sub-address">Address</label>
          <input
            id="sub-address"
            type="text"
            bind:value={newAddress}
            placeholder={newChannel === 'telegram' ? 'Chat ID' : 'FCM Token'}
            class="input"
          />
        </div>
        <div class="form-field">
          <label class="field-label" for="sub-label">Label</label>
          <input id="sub-label" type="text" bind:value={newLabel} placeholder="Optional" class="input" />
        </div>
        <div class="form-field form-action">
          <Button variant="primary" type="submit" loading={adding} icon="plus">Add</Button>
        </div>
      </form>
    </section>

    <!-- Subscribers -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="bell" size={16} />
        <span>Subscribers</span>
        <Badge variant="neutral" size="sm">{subscribers.length}</Badge>
      </div>

      {#if subscribers.length === 0}
        <EmptyState
          icon="bell"
          title="No subscribers"
          message="Add a subscriber above or use /start in the Telegram bot"
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
                >Test</Button>
                <Button variant="danger" size="sm" on:click={() => handleDelete(sub)} aria-label="Remove {sub.label || sub.address}">
                  <Icon name="trash" size={13} />
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Delivery Log -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="activity" size={16} />
        <span>Delivery Log</span>
      </div>

      {#if log.length === 0}
        <EmptyState icon="clock" title="No notifications sent" message="Delivery history will appear here" />
      {:else}
        <div class="log-table">
          <div class="log-header">
            <span class="th">Time</span>
            <span class="th">Channel</span>
            <span class="th">Device</span>
            <span class="th">Alarm</span>
            <span class="th">Status</span>
            <span class="th">Subscriber</span>
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
</div>

<style>
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
