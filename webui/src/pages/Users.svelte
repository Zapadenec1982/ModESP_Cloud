<script>
  import { onMount } from 'svelte';
  import { getUsers, createUser, updateUser, deleteUser } from '../lib/api.js';

  let users = [];
  let loading = true;
  let error = '';

  // Create form
  let showCreate = false;
  let newEmail = '';
  let newPassword = '';
  let newRole = 'viewer';
  let createError = '';
  let creating = false;

  // Edit state
  let editId = null;
  let editRole = '';
  let saving = false;

  onMount(loadUsers);

  async function loadUsers() {
    loading = true;
    error = '';
    try {
      users = await getUsers();
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    createError = '';
    creating = true;
    try {
      await createUser({ email: newEmail, password: newPassword, role: newRole });
      showCreate = false;
      newEmail = '';
      newPassword = '';
      newRole = 'viewer';
      await loadUsers();
    } catch (e) {
      createError = e.message;
    } finally {
      creating = false;
    }
  }

  function startEdit(user) {
    editId = user.id;
    editRole = user.role;
  }

  function cancelEdit() {
    editId = null;
  }

  async function saveEdit(userId) {
    saving = true;
    try {
      await updateUser(userId, { role: editRole });
      editId = null;
      await loadUsers();
    } catch (e) {
      alert(e.message);
    } finally {
      saving = false;
    }
  }

  async function handleDelete(user) {
    if (!confirm(`Deactivate ${user.email}?`)) return;
    try {
      await deleteUser(user.id);
      await loadUsers();
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleReactivate(user) {
    try {
      await updateUser(user.id, { active: true });
      await loadUsers();
    } catch (e) {
      alert(e.message);
    }
  }

  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString();
  }
</script>

<div class="users-page">
  <div class="header">
    <h2>Users</h2>
    <button class="btn btn-primary" on:click={() => showCreate = !showCreate}>
      {showCreate ? 'Cancel' : '+ New User'}
    </button>
  </div>

  {#if showCreate}
    <form class="create-form" on:submit|preventDefault={handleCreate}>
      {#if createError}
        <div class="error">{createError}</div>
      {/if}
      <div class="form-row">
        <input type="email" bind:value={newEmail} placeholder="Email" required />
        <input type="password" bind:value={newPassword} placeholder="Password (min 6)" required minlength="6" />
        <select bind:value={newRole}>
          <option value="viewer">Viewer</option>
          <option value="technician">Technician</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" class="btn btn-primary" disabled={creating}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  {/if}

  {#if loading}
    <p class="muted">Loading...</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if users.length === 0}
    <p class="muted">No users found.</p>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Role</th>
          <th>Active</th>
          <th>Created</th>
          <th>Last Login</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user}
          <tr class:inactive={!user.active}>
            <td>{user.email}</td>
            <td>
              {#if editId === user.id}
                <select bind:value={editRole}>
                  <option value="viewer">Viewer</option>
                  <option value="technician">Technician</option>
                  <option value="admin">Admin</option>
                </select>
              {:else}
                <span class="badge badge-{user.role}">{user.role}</span>
              {/if}
            </td>
            <td>
              {#if user.active}
                <span class="dot dot-green"></span> Yes
              {:else}
                <span class="dot dot-red"></span> No
              {/if}
            </td>
            <td>{formatDate(user.created_at)}</td>
            <td>{formatDate(user.last_login)}</td>
            <td class="actions">
              {#if editId === user.id}
                <button class="btn btn-sm btn-primary" on:click={() => saveEdit(user.id)} disabled={saving}>Save</button>
                <button class="btn btn-sm" on:click={cancelEdit}>Cancel</button>
              {:else}
                <button class="btn btn-sm" on:click={() => startEdit(user)}>Edit</button>
                {#if user.active}
                  <button class="btn btn-sm btn-danger" on:click={() => handleDelete(user)}>Deactivate</button>
                {:else}
                  <button class="btn btn-sm btn-success" on:click={() => handleReactivate(user)}>Reactivate</button>
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .users-page {
    max-width: 900px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-4);
  }

  h2 {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
  }

  .create-form {
    background: var(--bg-surface);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);
    border: 1px solid var(--border-default);
  }

  .form-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .form-row input, .form-row select {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .form-row input::placeholder {
    color: var(--text-muted);
  }

  .form-row input:focus, .form-row select:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .form-row input { flex: 1; min-width: 140px; }

  .error {
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }

  .muted {
    color: var(--text-secondary);
  }

  .table {
    width: 100%;
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--border-default);
    border-collapse: collapse;
  }

  .table th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .table td {
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border-muted);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .table td select {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .inactive td {
    opacity: 0.4;
  }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-admin { background: rgba(210, 153, 34, 0.15); color: var(--accent-yellow); }
  .badge-technician { background: rgba(88, 166, 255, 0.1); color: var(--accent-blue); }
  .badge-viewer { background: rgba(63, 185, 80, 0.1); color: var(--accent-green); }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
  }

  .dot-green { background: var(--accent-green); }
  .dot-red { background: var(--accent-red); }

  .actions {
    white-space: nowrap;
    display: flex;
    gap: var(--space-1);
  }

  .btn {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn:hover { background: var(--border-default); }

  .btn-sm {
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: var(--text-inverse);
    border-color: var(--accent-blue);
  }

  .btn-primary:hover { background: #4a9aef; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-danger {
    color: var(--accent-red);
    border-color: rgba(248, 81, 73, 0.3);
    background: rgba(248, 81, 73, 0.06);
  }

  .btn-danger:hover { background: rgba(248, 81, 73, 0.15); }

  .btn-success {
    color: var(--accent-green);
    border-color: rgba(63, 185, 80, 0.3);
    background: rgba(63, 185, 80, 0.06);
  }

  .btn-success:hover { background: rgba(63, 185, 80, 0.15); }
</style>
