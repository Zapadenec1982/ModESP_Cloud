<script>
  import { onMount } from 'svelte'
  import { getUsers, createUser, updateUser, deleteUser } from '../lib/api.js'
  import { timeAgo } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'

  let users = []
  let loading = true
  let error = null

  // Create modal
  let showCreate = false
  let newEmail = ''
  let newPassword = ''
  let newRole = 'viewer'
  let creating = false

  // Edit state
  let editId = null
  let editRole = ''
  let saving = false

  function roleVariant(role) {
    if (role === 'admin') return 'warning'
    if (role === 'technician') return 'info'
    return 'success'
  }

  async function loadUsers() {
    try {
      users = await getUsers()
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleCreate() {
    if (!newEmail.trim() || !newPassword) {
      toast.warning('Email and password are required')
      return
    }
    creating = true
    try {
      await createUser({ email: newEmail.trim(), password: newPassword, role: newRole })
      toast.success('User created')
      showCreate = false
      newEmail = ''
      newPassword = ''
      newRole = 'viewer'
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      creating = false
    }
  }

  function startEdit(user) {
    editId = user.id
    editRole = user.role
  }

  function cancelEdit() {
    editId = null
  }

  async function saveEdit(userId) {
    saving = true
    try {
      await updateUser(userId, { role: editRole })
      toast.success('Role updated')
      editId = null
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }

  async function handleDeactivate(user) {
    try {
      await deleteUser(user.id)
      toast.success(`${user.email} deactivated`)
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function handleReactivate(user) {
    try {
      await updateUser(user.id, { active: true })
      toast.success(`${user.email} reactivated`)
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    }
  }

  function closeModal() {
    showCreate = false
    newEmail = ''
    newPassword = ''
    newRole = 'viewer'
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) closeModal()
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') closeModal()
  }

  onMount(loadUsers)
</script>

<div class="users-page">
  <PageHeader title="Users" subtitle="Manage platform accounts and roles">
    <Button variant="secondary" icon="refresh" on:click={loadUsers}>Refresh</Button>
    <Button variant="primary" icon="plus" on:click={() => showCreate = true}>New User</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="400px" />
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load" message={error} />
  {:else if users.length === 0}
    <EmptyState icon="users" title="No users" message="Create the first user account to get started" />
  {:else}
    <section class="section-card">
      <div class="section-header">
        <Icon name="users" size={16} />
        <span>Accounts</span>
        <Badge variant="neutral" size="sm">{users.length}</Badge>
      </div>

      <!-- Desktop table header -->
      <div class="user-table-header">
        <span class="th th-email">User</span>
        <span class="th th-role">Role</span>
        <span class="th th-status">Status</span>
        <span class="th th-created">Created</span>
        <span class="th th-login">Last Login</span>
        <span class="th th-actions">Actions</span>
      </div>

      <div class="user-list">
        {#each users as user (user.id)}
          <div class="user-row" class:inactive={!user.active}>
            <!-- Email -->
            <div class="cell cell-email">
              <Icon name="user" size={14} />
              <span class="user-email">{user.email}</span>
            </div>

            <!-- Role -->
            <div class="cell cell-role">
              {#if editId === user.id}
                <select bind:value={editRole} class="input input-sm">
                  <option value="viewer">Viewer</option>
                  <option value="technician">Technician</option>
                  <option value="admin">Admin</option>
                </select>
              {:else}
                <Badge variant={roleVariant(user.role)} size="sm">{user.role}</Badge>
              {/if}
            </div>

            <!-- Status -->
            <div class="cell cell-status">
              {#if user.active}
                <StatusDot status="online" size="sm" />
                <span class="status-text active">Active</span>
              {:else}
                <StatusDot status="offline" size="sm" />
                <span class="status-text">Inactive</span>
              {/if}
            </div>

            <!-- Created -->
            <div class="cell cell-created">
              <span class="text-muted">{timeAgo(user.created_at)}</span>
            </div>

            <!-- Last Login -->
            <div class="cell cell-login">
              <span class="text-muted">{user.last_login ? timeAgo(user.last_login) : '—'}</span>
            </div>

            <!-- Actions -->
            <div class="cell cell-actions">
              {#if editId === user.id}
                <Button variant="primary" size="sm" loading={saving} on:click={() => saveEdit(user.id)}>Save</Button>
                <Button variant="secondary" size="sm" on:click={cancelEdit}>Cancel</Button>
              {:else}
                <Button variant="secondary" size="sm" on:click={() => startEdit(user)} aria-label="Edit {user.email}">
                  <Icon name="edit" size={13} />
                </Button>
                {#if user.active}
                  <Button variant="danger" size="sm" on:click={() => handleDeactivate(user)} aria-label="Deactivate {user.email}">
                    <Icon name="x-circle" size={13} />
                  </Button>
                {:else}
                  <Button variant="secondary" size="sm" on:click={() => handleReactivate(user)} aria-label="Reactivate {user.email}">
                    <Icon name="check" size={13} />
                  </Button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<!-- Create User Modal -->
{#if showCreate}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleBackdropClick} on:keydown={handleBackdropKey} role="dialog" aria-modal="true" aria-labelledby="create-user-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <h3 id="create-user-title">Create User</h3>
        <button class="modal-close" on:click={closeModal} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>
      <form on:submit|preventDefault={handleCreate} class="modal-body">
        <div class="form-field">
          <label class="field-label" for="user-email">Email</label>
          <input
            id="user-email"
            type="email"
            bind:value={newEmail}
            placeholder="user@example.com"
            class="input"
            required
          />
        </div>
        <div class="form-field">
          <label class="field-label" for="user-password">Password</label>
          <input
            id="user-password"
            type="password"
            bind:value={newPassword}
            placeholder="Minimum 6 characters"
            class="input"
            required
            minlength="6"
          />
        </div>
        <div class="form-field">
          <label class="field-label" for="user-role">Role</label>
          <select id="user-role" bind:value={newRole} class="input">
            <option value="viewer">Viewer</option>
            <option value="technician">Technician</option>
            <option value="admin">Admin</option>
          </select>
          <span class="field-hint">
            {#if newRole === 'admin'}
              Full access — manage users, devices, firmware
            {:else if newRole === 'technician'}
              Can view and control devices, manage alarms
            {:else}
              Read-only access to dashboards and reports
            {/if}
          </span>
        </div>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeModal}>Cancel</Button>
          <Button variant="primary" type="submit" loading={creating} icon="plus">Create User</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .users-page {
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

  /* Table header */
  .user-table-header {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-default);
  }

  .th {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .th-email   { flex: 2; min-width: 0; }
  .th-role    { width: 100px; }
  .th-status  { width: 90px; }
  .th-created { width: 100px; }
  .th-login   { width: 100px; }
  .th-actions { width: 110px; text-align: right; }

  /* User rows */
  .user-list {
    display: flex;
    flex-direction: column;
  }

  .user-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    transition: background var(--transition-fast);
  }

  .user-row:last-child {
    border-bottom: none;
  }

  .user-row:hover {
    background: var(--bg-tertiary);
  }

  .user-row.inactive {
    opacity: 0.45;
  }

  .user-row.inactive:hover {
    opacity: 0.7;
  }

  .cell {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
    min-width: 0;
  }

  .cell-email   { flex: 2; min-width: 0; }
  .cell-role    { width: 100px; }
  .cell-status  { width: 90px; }
  .cell-created { width: 100px; }
  .cell-login   { width: 100px; }
  .cell-actions { width: 110px; justify-content: flex-end; gap: var(--space-1); }

  .user-email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .status-text {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .status-text.active {
    color: var(--accent-green);
  }

  .text-muted {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  /* Input styles */
  .input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
    width: 100%;
  }

  .input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .input::placeholder {
    color: var(--text-muted);
  }

  .input-sm {
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    width: auto;
  }

  select.input {
    cursor: pointer;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fade-in 0.2s ease-out;
  }

  .modal {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 440px;
    margin: var(--space-4);
    animation: slide-in-up 0.25s ease-out;
    box-shadow: var(--shadow-lg);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h3 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    display: flex;
    transition: all var(--transition-fast);
  }

  .modal-close:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: 2px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-muted);
  }

  /* Mobile */
  @media (max-width: 768px) {
    .user-table-header {
      display: none;
    }

    .user-row {
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .cell-email { flex: 1 1 100%; }
    .cell-role { width: auto; }
    .cell-status { width: auto; }
    .cell-created { display: none; }
    .cell-login { display: none; }
    .cell-actions { width: auto; margin-left: auto; }
  }
</style>
