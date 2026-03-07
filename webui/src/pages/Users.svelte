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
    margin-bottom: 1rem;
  }

  h2 {
    font-size: 1.3rem;
    color: #2d3436;
  }

  .create-form {
    background: white;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }

  .form-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .form-row input, .form-row select {
    padding: 0.5rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .form-row input { flex: 1; min-width: 140px; }

  .error {
    background: #ffeaea;
    color: #d63031;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }

  .muted {
    color: #636e72;
  }

  .table {
    width: 100%;
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    border-collapse: collapse;
  }

  .table th {
    text-align: left;
    padding: 0.6rem 0.75rem;
    background: #f8f9fa;
    font-size: 0.8rem;
    font-weight: 600;
    color: #636e72;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .table td {
    padding: 0.6rem 0.75rem;
    border-top: 1px solid #f1f2f6;
    font-size: 0.85rem;
  }

  .inactive td {
    opacity: 0.5;
  }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-admin { background: #ffeaa7; color: #d68910; }
  .badge-technician { background: #dfe6fd; color: #4a69bd; }
  .badge-viewer { background: #e8f8f5; color: #00b894; }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
  }

  .dot-green { background: #00b894; }
  .dot-red { background: #e17055; }

  .actions {
    white-space: nowrap;
  }

  .btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    background: white;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn:hover { background: #f8f9fa; }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .btn-primary {
    background: #00b894;
    color: white;
    border-color: #00b894;
  }

  .btn-primary:hover { background: #00a884; }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-danger {
    color: #d63031;
    border-color: #d63031;
  }

  .btn-danger:hover { background: #ffeaea; }

  .btn-success {
    color: #00b894;
    border-color: #00b894;
  }

  .btn-success:hover { background: #e8f8f5; }
</style>
