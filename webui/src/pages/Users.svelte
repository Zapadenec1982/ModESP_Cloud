<script>
  import { onMount } from 'svelte'
  import { getUsers, createUser, updateUser, deleteUser, getDevices, getUserDevices, setUserDevices, getTenants, addUserTenant, removeUserTenant, generateTelegramLink } from '../lib/api.js'
  import { isSuperAdmin } from '../lib/stores.js'
  import { timeAgo } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'
  import { t } from '../lib/i18n.js'

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
    if (role === 'superadmin') return 'danger'
    if (role === 'admin') return 'warning'
    if (role === 'technician') return 'info'
    return 'success'
  }

  // ── Tenant state (superadmin features) ──
  let tenantsList = []
  let newTenantId = ''

  // Tenant reassign modal
  let showTenantModal = false
  let tenantUser = null
  let tenantTarget = ''
  let tenantSaving = false

  async function loadUsers() {
    try {
      const promises = [getUsers()]
      if ($isSuperAdmin) promises.push(getTenants())
      const results = await Promise.all(promises)
      users = results[0]
      if (results[1]) tenantsList = results[1]
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleCreate() {
    if (!newEmail.trim() || !newPassword) {
      toast.warning($t('users.email_password_required'))
      return
    }
    creating = true
    try {
      const payload = { email: newEmail.trim(), password: newPassword, role: newRole }
      if ($isSuperAdmin && newTenantId) payload.tenant_id = newTenantId
      await createUser(payload)
      toast.success($t('users.user_created'))
      showCreate = false
      newEmail = ''
      newPassword = ''
      newRole = 'viewer'
      newTenantId = ''
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
      toast.success($t('users.role_updated'))
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
      await updateUser(user.id, { active: false })
      toast.success($t('users.user_deactivated', user.email))
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function handleDelete(user) {
    if (!confirm($t('users.confirm_delete', user.email))) return
    try {
      await deleteUser(user.id)
      toast.success($t('users.user_deleted', user.email))
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function handleReactivate(user) {
    try {
      await updateUser(user.id, { active: true })
      toast.success($t('users.user_reactivated', user.email))
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
    newTenantId = ''
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) closeModal()
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') closeModal()
  }

  // ── Device assignment modal ──
  let showDevices = false
  let deviceUser = null
  let allDevices = []
  let assignedIds = new Set()
  let devicesLoading = false
  let devicesSaving = false
  let deviceSearch = ''

  $: filteredDevices = deviceSearch
    ? allDevices.filter(d => {
        const q = deviceSearch.toLowerCase()
        return (d.name || '').toLowerCase().includes(q) ||
          (d.mqtt_device_id || '').toLowerCase().includes(q) ||
          (d.location || '').toLowerCase().includes(q) ||
          (d.model || '').toLowerCase().includes(q)
      })
    : allDevices

  async function openDevices(user) {
    deviceUser = user
    devicesLoading = true
    showDevices = true
    deviceSearch = ''
    try {
      // Superadmin: scope devices to target user's tenant
      const devParams = $isSuperAdmin && user.tenant_id ? { tenant_id: user.tenant_id } : {}
      const [devs, assigned] = await Promise.all([
        getDevices(devParams),
        getUserDevices(user.id),
      ])
      allDevices = (devs?.data || devs || []).filter(d => d.status === 'active')
      const ids = (assigned || []).map(d => d.id)
      assignedIds = new Set(ids)
    } catch (e) {
      toast.error(e.message)
      showDevices = false
    } finally {
      devicesLoading = false
    }
  }

  function toggleDevice(deviceId) {
    assignedIds = new Set(assignedIds)
    if (assignedIds.has(deviceId)) {
      assignedIds.delete(deviceId)
    } else {
      assignedIds.add(deviceId)
    }
    assignedIds = assignedIds  // trigger reactivity
  }

  function selectAll() {
    assignedIds = new Set(allDevices.map(d => d.id))
  }

  function selectNone() {
    assignedIds = new Set()
  }

  async function saveDevices() {
    devicesSaving = true
    try {
      await setUserDevices(deviceUser.id, [...assignedIds])
      toast.success($t('users.devices_updated'))
      showDevices = false
    } catch (e) {
      toast.error(e.message)
    } finally {
      devicesSaving = false
    }
  }

  function closeDevicesModal() {
    showDevices = false
    deviceUser = null
  }

  function handleDevicesBackdropClick(e) {
    if (e.target === e.currentTarget) closeDevicesModal()
  }

  function handleDevicesKey(e) {
    if (e.key === 'Escape') closeDevicesModal()
  }

  // ── Telegram link modal ──
  let showTelegramLink = false
  let telegramLinkCode = ''
  let telegramLinkUser = null

  async function generateTgLink(user) {
    try {
      const result = await generateTelegramLink(user.id)
      telegramLinkCode = result.link_code
      telegramLinkUser = user
      showTelegramLink = true
    } catch (e) {
      toast.error(e.message)
    }
  }

  function closeTelegramModal() {
    showTelegramLink = false
    telegramLinkCode = ''
    telegramLinkUser = null
  }

  function handleTelegramBackdropClick(e) {
    if (e.target === e.currentTarget) closeTelegramModal()
  }

  function handleTelegramKey(e) {
    if (e.key === 'Escape') closeTelegramModal()
  }

  // ── Manage tenants modal (superadmin) ──
  let userTenants = []  // current memberships for modal user

  function openTenantModal(user) {
    tenantUser = user
    tenantTarget = ''
    // Copy user's current tenants (from GET /users response)
    userTenants = user.tenants ? [...user.tenants] : []
    showTenantModal = true
  }

  function closeTenantModal() {
    showTenantModal = false
    tenantUser = null
    tenantTarget = ''
    userTenants = []
  }

  function handleTenantBackdropClick(e) {
    if (e.target === e.currentTarget) closeTenantModal()
  }

  function handleTenantKey(e) {
    if (e.key === 'Escape') closeTenantModal()
  }

  // Available tenants to add (not yet a member)
  $: tenantsToAdd = tenantsList.filter(t => !userTenants.some(ut => ut.id === t.id))

  async function handleAddTenant() {
    if (!tenantTarget) return
    tenantSaving = true
    try {
      const result = await addUserTenant(tenantUser.id, tenantTarget)
      userTenants = result
      tenantTarget = ''
      toast.success($t('users.user_tenants_updated'))
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      tenantSaving = false
    }
  }

  async function handleRemoveTenant(tenantId) {
    if (userTenants.length <= 1) {
      toast.warning($t('users.last_tenant_warning'))
      return
    }
    tenantSaving = true
    try {
      const result = await removeUserTenant(tenantUser.id, tenantId)
      userTenants = result
      toast.success($t('users.user_tenants_updated'))
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      tenantSaving = false
    }
  }

  onMount(loadUsers)
</script>

<div class="users-page">
  <PageHeader title={$t('pages.users')} subtitle={$t('pages.users_sub')}>
    <Button variant="secondary" icon="refresh" on:click={loadUsers}>{$t('common.refresh')}</Button>
    <Button variant="primary" icon="plus" on:click={() => showCreate = true}>{$t('users.new_user')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="400px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else if users.length === 0}
    <EmptyState icon="users" title={$t('users.no_users')} message={$t('users.no_users_hint')} />
  {:else}
    <section class="section-card">
      <div class="section-header">
        <Icon name="users" size={16} />
        <span>{$t('users.accounts')}</span>
        <Badge variant="neutral" size="sm">{users.length}</Badge>
      </div>

      <!-- Desktop table header -->
      <div class="user-table-header">
        <span class="th th-email">{$t('users.col_user')}</span>
        {#if $isSuperAdmin}
          <span class="th th-tenant">{$t('users.col_tenant')}</span>
        {/if}
        <span class="th th-role">{$t('users.col_role')}</span>
        <span class="th th-status">{$t('users.col_status')}</span>
        <span class="th th-telegram">{$t('users.telegram')}</span>
        <span class="th th-created">{$t('users.col_created')}</span>
        <span class="th th-login">{$t('users.col_last_login')}</span>
        <span class="th th-actions">{$t('common.actions')}</span>
      </div>

      <div class="user-list">
        {#each users as user (user.id)}
          <div class="user-row" class:inactive={!user.active}>
            <!-- Email -->
            <div class="cell cell-email">
              <Icon name="user" size={14} />
              <span class="user-email">{user.email}</span>
            </div>

            <!-- Tenant (superadmin only) -->
            {#if $isSuperAdmin}
              <div class="cell cell-tenant">
                {#if user.tenants && user.tenants.length > 0}
                  <div class="tenant-badges">
                    {#each user.tenants as ut}
                      <Badge variant="neutral" size="sm">{ut.slug}</Badge>
                    {/each}
                  </div>
                {:else}
                  <span class="tenant-name">{user.tenant_name || '—'}</span>
                {/if}
              </div>
            {/if}

            <!-- Role -->
            <div class="cell cell-role">
              {#if editId === user.id}
                <select bind:value={editRole} class="input input-sm">
                  <option value="viewer">{$t('users.role_viewer')}</option>
                  <option value="technician">{$t('users.role_technician')}</option>
                  <option value="admin">{$t('users.role_admin')}</option>
                </select>
              {:else}
                <Badge variant={roleVariant(user.role)} size="sm">{user.role}</Badge>
              {/if}
            </div>

            <!-- Status -->
            <div class="cell cell-status">
              {#if user.active}
                <StatusDot status="online" size="sm" />
                <span class="status-text active">{$t('common.active')}</span>
              {:else}
                <StatusDot status="offline" size="sm" />
                <span class="status-text">{$t('common.inactive')}</span>
              {/if}
            </div>

            <!-- Telegram -->
            <div class="cell cell-telegram">
              {#if user.telegram_id}
                <button class="link-btn link-btn--relink" on:click={() => generateTgLink(user)}>
                  <Badge variant="success" size="sm">{$t('users.telegram_linked')}</Badge>
                </button>
              {:else}
                <button class="link-btn" on:click={() => generateTgLink(user)}>{$t('users.telegram_link')}</button>
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
              {#if user.role === 'superadmin' && !$isSuperAdmin}
                <!-- Admin cannot manage superadmin users -->
                <span class="text-muted" style="font-size: var(--text-xs)">—</span>
              {:else if editId === user.id}
                <Button variant="primary" size="sm" loading={saving} on:click={() => saveEdit(user.id)}>{$t('common.save')}</Button>
                <Button variant="secondary" size="sm" on:click={cancelEdit}>{$t('common.cancel')}</Button>
              {:else}
                <!-- Edit role (not for superadmin rows unless logged as superadmin) -->
                {#if user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => startEdit(user)} aria-label="Edit {user.email}">
                    <Icon name="edit" size={13} />
                  </Button>
                {/if}
                <!-- Device assignment: only for technician/viewer (admin/superadmin see all) -->
                {#if user.role !== 'admin' && user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => openDevices(user)} aria-label="{$t('users.devices')} {user.email}">
                    <Icon name="cpu" size={13} />
                  </Button>
                {/if}
                <!-- Manage tenants (superadmin only, not for superadmin users) -->
                {#if $isSuperAdmin && user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => openTenantModal(user)} aria-label="{$t('users.manage_tenants')} {user.email}">
                    <Icon name="grid" size={13} />
                  </Button>
                {/if}
                <!-- Deactivate/Reactivate (not for superadmin rows) -->
                {#if user.role !== 'superadmin'}
                  {#if user.active}
                    <Button variant="secondary" size="sm" on:click={() => handleDeactivate(user)} aria-label="Deactivate {user.email}" title={$t('users.deactivate')}>
                      <Icon name="x-circle" size={13} />
                    </Button>
                  {:else}
                    <Button variant="secondary" size="sm" on:click={() => handleReactivate(user)} aria-label="Reactivate {user.email}" title={$t('users.reactivate')}>
                      <Icon name="check" size={13} />
                    </Button>
                  {/if}
                  <Button variant="danger" size="sm" on:click={() => handleDelete(user)} aria-label="Delete {user.email}" title={$t('users.delete')}>
                    <Icon name="trash" size={13} />
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
        <h3 id="create-user-title">{$t('users.create_user')}</h3>
        <button class="modal-close" on:click={closeModal} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>
      <form on:submit|preventDefault={handleCreate} class="modal-body">
        <div class="form-field">
          <label class="field-label" for="user-email">{$t('login.email')}</label>
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
          <label class="field-label" for="user-password">{$t('login.password')}</label>
          <input
            id="user-password"
            type="password"
            bind:value={newPassword}
            placeholder={$t('users.min_password')}
            class="input"
            required
            minlength="6"
          />
        </div>
        {#if $isSuperAdmin}
          <div class="form-field">
            <label class="field-label" for="user-tenant">{$t('users.target_tenant')}</label>
            <select id="user-tenant" bind:value={newTenantId} class="input">
              <option value="">— {$t('users.select_tenant')} —</option>
              {#each tenantsList as tenant (tenant.id)}
                <option value={tenant.id}>{tenant.name} ({tenant.slug})</option>
              {/each}
            </select>
          </div>
        {/if}
        <div class="form-field">
          <label class="field-label" for="user-role">{$t('users.col_role')}</label>
          <select id="user-role" bind:value={newRole} class="input">
            <option value="viewer">{$t('users.role_viewer')}</option>
            <option value="technician">{$t('users.role_technician')}</option>
            <option value="admin">{$t('users.role_admin')}</option>
          </select>
          <span class="field-hint">
            {#if newRole === 'admin'}
              {$t('users.role_hint_admin')}
            {:else if newRole === 'technician'}
              {$t('users.role_hint_technician')}
            {:else}
              {$t('users.role_hint_viewer')}
            {/if}
          </span>
        </div>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeModal}>{$t('common.cancel')}</Button>
          <Button variant="primary" type="submit" loading={creating} icon="plus">{$t('users.create_user')}</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Device Assignment Modal -->
{#if showDevices}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleDevicesBackdropClick} on:keydown={handleDevicesKey} role="dialog" aria-modal="true" aria-labelledby="devices-modal-title" tabindex="-1">
    <div class="modal modal-devices">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="devices-modal-title">{$t('users.assign_devices')}</h3>
          <span class="modal-subtitle">{deviceUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeDevicesModal} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        {#if devicesLoading}
          <Skeleton height="200px" />
        {:else}
          <!-- Search -->
          <div class="device-search">
            <Icon name="search" size={14} />
            <input
              type="text"
              bind:value={deviceSearch}
              placeholder={$t('users.search_devices')}
              class="input device-search-input"
            />
          </div>

          <!-- Bulk actions -->
          <div class="device-bulk-actions">
            <button class="link-btn" on:click={selectAll}>{$t('users.select_all')}</button>
            <span class="sep">|</span>
            <button class="link-btn" on:click={selectNone}>{$t('users.select_none')}</button>
            <span class="device-count">{assignedIds.size} / {allDevices.length}</span>
          </div>

          <!-- Device list -->
          <div class="device-checklist">
            {#if filteredDevices.length === 0}
              <div class="device-empty">{$t('users.no_devices_found')}</div>
            {:else}
              {#each filteredDevices as device (device.id)}
                <label class="device-check-item" class:checked={assignedIds.has(device.id)}>
                  <input
                    type="checkbox"
                    checked={assignedIds.has(device.id)}
                    on:change={() => toggleDevice(device.id)}
                  />
                  <div class="device-check-info">
                    <span class="device-check-name">{device.name || device.mqtt_device_id}</span>
                    {#if device.name}
                      <span class="device-check-id">{device.mqtt_device_id}</span>
                    {/if}
                    {#if device.location}
                      <span class="device-check-location">{device.location}</span>
                    {/if}
                    {#if device.model}
                      <span class="device-check-model">{device.model}</span>
                    {/if}
                  </div>
                </label>
              {/each}
            {/if}
          </div>
        {/if}

        <div class="modal-actions">
          <Button variant="secondary" on:click={closeDevicesModal}>{$t('common.cancel')}</Button>
          <Button variant="primary" loading={devicesSaving} on:click={saveDevices} icon="check">{$t('common.save')}</Button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Manage Tenants Modal (superadmin only) -->
{#if showTenantModal}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleTenantBackdropClick} on:keydown={handleTenantKey} role="dialog" aria-modal="true" aria-labelledby="tenant-modal-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="tenant-modal-title">{$t('users.manage_tenants')}</h3>
          <span class="modal-subtitle">{tenantUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeTenantModal} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <!-- Current memberships -->
        <div class="form-field">
          <span class="field-label">{$t('users.current_tenants')}</span>
          <div class="tenant-chips">
            {#each userTenants as ut (ut.id)}
              <span class="tenant-chip">
                {ut.name}
                <button
                  class="chip-remove"
                  on:click={() => handleRemoveTenant(ut.id)}
                  disabled={userTenants.length <= 1 || tenantSaving}
                  title={userTenants.length <= 1 ? $t('users.last_tenant_warning') : $t('users.remove_from_tenant')}
                  aria-label="Remove {ut.name}"
                >×</button>
              </span>
            {/each}
            {#if userTenants.length === 0}
              <span class="text-muted">—</span>
            {/if}
          </div>
        </div>

        <!-- Add to tenant -->
        {#if tenantsToAdd.length > 0}
          <div class="form-field">
            <span class="field-label">{$t('users.add_to_tenant')}</span>
            <div class="add-tenant-row">
              <select bind:value={tenantTarget} class="input" style="flex:1">
                <option value="">— {$t('users.select_tenant')} —</option>
                {#each tenantsToAdd as tenant (tenant.id)}
                  <option value={tenant.id}>{tenant.name} ({tenant.slug})</option>
                {/each}
              </select>
              <Button variant="primary" size="sm" loading={tenantSaving} on:click={handleAddTenant} disabled={!tenantTarget} icon="plus">{$t('common.add')}</Button>
            </div>
          </div>
        {/if}

        <div class="modal-actions">
          <Button variant="secondary" on:click={closeTenantModal}>{$t('common.close')}</Button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Telegram Link Modal -->
{#if showTelegramLink}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleTelegramBackdropClick} on:keydown={handleTelegramKey} role="dialog" aria-modal="true" aria-labelledby="telegram-modal-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="telegram-modal-title">{$t('users.telegram_link_title')}</h3>
          <span class="modal-subtitle">{telegramLinkUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeTelegramModal} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <span class="field-label">{$t('users.telegram_link_code')}</span>
          <div class="telegram-code">{telegramLinkCode}</div>
        </div>
        <div class="telegram-instructions">
          {$t('users.telegram_link_instructions')}
          <code class="telegram-cmd">/start {telegramLinkCode}</code>
        </div>
        <p class="field-hint">{$t('users.telegram_link_expires')}</p>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeTelegramModal}>{$t('common.close')}</Button>
        </div>
      </div>
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
  .th-tenant  { width: 160px; }
  .th-role    { width: 100px; }
  .th-status  { width: 90px; }
  .th-telegram { width: 90px; }
  .th-created { width: 100px; }
  .th-login   { width: 100px; }
  .th-actions { width: 140px; text-align: right; }

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
  .cell-tenant  { width: 160px; }
  .cell-role    { width: 100px; }
  .cell-status  { width: 90px; }
  .cell-telegram { width: 90px; }
  .cell-created { width: 100px; }
  .cell-login   { width: 100px; }
  .cell-actions { width: 140px; justify-content: flex-end; gap: var(--space-1); }

  .tenant-name {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

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

  /* Device assignment modal */
  .modal-devices {
    max-width: 520px;
  }

  .modal-title-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .modal-subtitle {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 400;
  }

  .device-search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
  }

  .device-search-input {
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    font-size: var(--text-sm) !important;
  }

  .device-search-input:focus {
    outline: none !important;
  }

  .device-bulk-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--accent-blue);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: 0;
    font-family: var(--font-sans);
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .link-btn--relink {
    display: flex;
    align-items: center;
    opacity: 0.9;
  }

  .link-btn--relink:hover {
    opacity: 1;
    text-decoration: none;
  }

  .sep {
    color: var(--border-default);
  }

  .device-count {
    margin-left: auto;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .device-checklist {
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
  }

  .device-empty {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .device-check-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    border-bottom: 1px solid var(--border-muted);
    transition: background var(--transition-fast);
  }

  .device-check-item:last-child {
    border-bottom: none;
  }

  .device-check-item:hover {
    background: var(--bg-tertiary);
  }

  .device-check-item.checked {
    background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  }

  .device-check-item input[type="checkbox"] {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    accent-color: var(--accent-blue);
    cursor: pointer;
  }

  .device-check-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
  }

  .device-check-name {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .device-check-id {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }

  .device-check-location {
    font-size: var(--text-xs);
    color: var(--text-secondary, var(--text-muted));
  }

  .device-check-model {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Tenant badges */
  .tenant-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .tenant-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .tenant-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .chip-remove {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: var(--text-lg);
    line-height: 1;
    padding: 0 2px;
    border-radius: 2px;
  }

  .chip-remove:hover:not(:disabled) {
    color: var(--accent-red);
    background: rgba(248, 81, 73, 0.1);
  }

  .chip-remove:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .add-tenant-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  /* Telegram link modal */
  .telegram-code {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: 0.1em;
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    text-align: center;
    color: var(--accent-blue);
    user-select: all;
  }

  .telegram-instructions {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .telegram-cmd {
    display: block;
    margin-top: var(--space-2);
    font-family: var(--font-mono, monospace);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    user-select: all;
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
    .cell-tenant { width: auto; }
    .cell-role { width: auto; }
    .cell-status { width: auto; }
    .cell-telegram { width: auto; }
    .cell-created { display: none; }
    .cell-login { display: none; }
    .cell-actions { width: auto; margin-left: auto; }
  }
</style>
