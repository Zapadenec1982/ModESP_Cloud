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
    gap: 1rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .btn-refresh {
    padding: 0.4rem 1rem;
    background: #2d3436;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-refresh:hover {
    background: #636e72;
  }

  .card {
    background: white;
    border: 1px solid #dfe6e9;
    border-radius: 12px;
    padding: 1.25rem;
  }

  .card h3 {
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
    color: #636e72;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .add-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .input {
    padding: 0.4rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .input:focus {
    outline: none;
    border-color: #0984e3;
  }

  .input-addr {
    min-width: 160px;
  }

  select.input {
    cursor: pointer;
  }

  .btn {
    padding: 0.4rem 1rem;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .btn-primary {
    background: #0984e3;
    color: white;
  }

  .btn-primary:hover {
    background: #0873c4;
  }

  .btn-sm {
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    background: #dfe6e9;
    color: #2d3436;
  }

  .btn-sm:hover {
    background: #b2bec3;
  }

  .btn-danger {
    background: #ffe0db;
    color: #e17055;
  }

  .btn-danger:hover {
    background: #fab1a0;
    color: white;
  }

  .form-status {
    font-size: 0.8rem;
    color: #636e72;
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid #dfe6e9;
    color: #636e72;
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #f0f0f0;
  }

  .mono {
    font-family: 'SF Mono', 'Consolas', monospace;
    font-size: 0.82rem;
  }

  .channel-badge {
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.78rem;
    font-weight: 600;
  }

  .channel-badge.telegram {
    background: #e3f2fd;
    color: #0288d1;
  }

  .channel-badge.fcm {
    background: #fff3e0;
    color: #e65100;
  }

  .status-badge {
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-sent {
    background: #e8f5e9;
    color: #2e7d32;
  }

  .badge-failed {
    background: #ffebee;
    color: #c62828;
  }

  .badge-skipped {
    background: #f5f5f5;
    color: #757575;
  }

  .error-hint {
    display: inline-block;
    width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    background: #ffebee;
    color: #c62828;
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
    font-size: 0.75rem;
    color: #636e72;
  }

  .status-msg {
    text-align: center;
    color: #636e72;
    padding: 1.5rem;
    font-size: 0.9rem;
  }

  .status-msg.error {
    color: #e17055;
  }
</style>
