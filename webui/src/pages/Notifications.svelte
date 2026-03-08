<script>
  import { onMount } from 'svelte';
  import {
    getSubscribers,
    createSubscriber,
    deleteSubscriber,
    testNotification,
    getNotificationLog,
  } from '../lib/api.js';

  let subscribers = [];
  let log = [];
  let loading = true;
  let error = null;

  // Add form
  let newChannel = 'telegram';
  let newAddress = '';
  let newLabel = '';
  let addStatus = '';

  // Test status per subscriber
  let testStatuses = {};

  async function load() {
    try {
      const [subs, entries] = await Promise.all([
        getSubscribers(),
        getNotificationLog({ limit: 50 }),
      ]);
      subscribers = subs;
      log = entries;
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function handleAdd() {
    if (!newAddress.trim()) {
      addStatus = 'Address is required';
      return;
    }
    addStatus = 'Adding...';
    try {
      await createSubscriber({
        channel: newChannel,
        address: newAddress.trim(),
        label: newLabel.trim() || undefined,
      });
      newAddress = '';
      newLabel = '';
      addStatus = '';
      await load();
    } catch (e) {
      addStatus = `Error: ${e.message}`;
    }
  }

  async function handleDelete(id) {
    try {
      await deleteSubscriber(id);
      await load();
    } catch (e) {
      error = e.message;
    }
  }

  async function handleTest(id) {
    testStatuses[id] = 'Sending...';
    testStatuses = testStatuses;
    try {
      const result = await testNotification(id);
      testStatuses[id] = result.status === 'sent' ? 'Sent!' : `Failed: ${result.error}`;
    } catch (e) {
      testStatuses[id] = `Error: ${e.message}`;
    }
    testStatuses = testStatuses;
    setTimeout(() => {
      delete testStatuses[id];
      testStatuses = testStatuses;
    }, 3000);
  }

  function channelIcon(ch) {
    return ch === 'telegram' ? '\u{1F4AC}' : '\u{1F514}';
  }

  function statusBadgeClass(status) {
    if (status === 'sent') return 'badge-sent';
    if (status === 'failed') return 'badge-failed';
    return 'badge-skipped';
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  onMount(load);
</script>

<div class="notifications">
  <div class="header">
    <h1>Notifications</h1>
    <button class="btn-refresh" on:click={load}>Refresh</button>
  </div>

  {#if loading}
    <p class="status-msg">Loading...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else}
    <!-- Add subscriber form -->
    <div class="card">
      <h3>Add Subscriber</h3>
      <form on:submit|preventDefault={handleAdd} class="add-form">
        <select bind:value={newChannel} class="input">
          <option value="telegram">Telegram</option>
          <option value="fcm">FCM</option>
        </select>
        <input
          type="text"
          bind:value={newAddress}
          placeholder={newChannel === 'telegram' ? 'Chat ID' : 'FCM Token'}
          class="input input-addr"
        />
        <input
          type="text"
          bind:value={newLabel}
          placeholder="Label (optional)"
          class="input"
        />
        <button type="submit" class="btn btn-primary">Add</button>
        {#if addStatus}
          <span class="form-status">{addStatus}</span>
        {/if}
      </form>
    </div>

    <!-- Subscribers table -->
    <div class="card">
      <h3>Subscribers ({subscribers.length})</h3>
      {#if subscribers.length === 0}
        <p class="status-msg">No subscribers yet. Add one above or use /start in Telegram bot.</p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Address</th>
                <th>Label</th>
                <th>Since</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each subscribers as sub (sub.id)}
                <tr>
                  <td>
                    <span class="channel-badge" class:telegram={sub.channel === 'telegram'} class:fcm={sub.channel === 'fcm'}>
                      {channelIcon(sub.channel)} {sub.channel}
                    </span>
                  </td>
                  <td class="mono">{sub.address}</td>
                  <td>{sub.label || '—'}</td>
                  <td>{timeAgo(sub.created_at)}</td>
                  <td class="actions">
                    <button class="btn btn-sm" on:click={() => handleTest(sub.id)}>Test</button>
                    <button class="btn btn-sm btn-danger" on:click={() => handleDelete(sub.id)}>Delete</button>
                    {#if testStatuses[sub.id]}
                      <span class="test-status">{testStatuses[sub.id]}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- Delivery log -->
    <div class="card">
      <h3>Delivery Log</h3>
      {#if log.length === 0}
        <p class="status-msg">No notifications sent yet.</p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Device</th>
                <th>Alarm</th>
                <th>Status</th>
                <th>Subscriber</th>
              </tr>
            </thead>
            <tbody>
              {#each log as entry (entry.id)}
                <tr>
                  <td>{timeAgo(entry.created_at)}</td>
                  <td>{channelIcon(entry.channel)} {entry.channel}</td>
                  <td class="mono">{entry.device_id || '—'}</td>
                  <td>{entry.alarm_code || '—'}</td>
                  <td>
                    <span class="status-badge {statusBadgeClass(entry.status)}">{entry.status}</span>
                    {#if entry.error_message}
                      <span class="error-hint" title={entry.error_message}>!</span>
                    {/if}
                  </td>
                  <td>{entry.subscriber_label || entry.subscriber_address || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .notifications {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
  }

  .btn-refresh {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .btn-refresh:hover {
    background: var(--border-default);
  }

  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
  }

  .card h3 {
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .add-form {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input::placeholder {
    color: var(--text-muted);
  }

  .input-addr {
    min-width: 160px;
  }

  select.input {
    cursor: pointer;
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 600;
    transition: background var(--transition-fast);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: var(--text-inverse);
  }

  .btn-primary:hover {
    background: #4a9aef;
  }

  .btn-sm {
    padding: 0.25rem 0.6rem;
    font-size: var(--text-xs);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
  }

  .btn-sm:hover {
    background: var(--border-default);
  }

  .btn-danger {
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
    border: 1px solid rgba(248, 81, 73, 0.3);
  }

  .btn-danger:hover {
    background: rgba(248, 81, 73, 0.2);
  }

  .form-status {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 2px solid var(--border-default);
    color: var(--text-muted);
    font-weight: 600;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-primary);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .channel-badge {
    padding: 0.15rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .channel-badge.telegram {
    background: rgba(88, 166, 255, 0.1);
    color: var(--accent-blue);
  }

  .channel-badge.fcm {
    background: rgba(219, 109, 40, 0.1);
    color: var(--accent-orange);
  }

  .status-badge {
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-sent {
    background: rgba(63, 185, 80, 0.1);
    color: var(--accent-green);
  }

  .badge-failed {
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
  }

  .badge-skipped {
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }

  .error-hint {
    display: inline-block;
    width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    background: rgba(248, 81, 73, 0.15);
    color: var(--accent-red);
    border-radius: 50%;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: help;
    margin-left: 0.25rem;
  }

  .actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .test-status {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .status-msg {
    text-align: center;
    color: var(--text-secondary);
    padding: var(--space-5);
    font-size: var(--text-base);
  }

  .status-msg.error {
    color: var(--accent-red);
  }
</style>
