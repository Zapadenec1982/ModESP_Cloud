<script>
  import { onMount } from 'svelte'
  import { getUsers, inviteUser, getInvitations, revokeInvitation, updateUser, deleteUser, getDevices, getUserDevices, setUserDevices, getTenants, addUserTenant, removeUserTenant, generateTelegramLink, generatePasswordReset, getSites, getUserSites, grantUserSite, revokeUserSite } from '../lib/api.js'
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
  import { t, locale } from '../lib/i18n.js'

  let users = []
  let loading = true
  let error = null

  // Invite modal (plan epic 1.5: invitations replace admin-set initial passwords)
  let showCreate = false
  let newEmail = ''
  let newRole = 'viewer'
  let creating = false
  let invitations = []
  let showInviteResult = false
  let inviteResult = null
  let copied = false

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

  async function loadInvitations() {
    try {
      invitations = await getInvitations()
    } catch {
      invitations = []
    }
  }

  async function handleInvite() {
    if (!newEmail.trim()) return
    creating = true
    try {
      const payload = { email: newEmail.trim(), role: newRole, lang: $locale }
      if ($isSuperAdmin && newTenantId) payload.tenant_id = newTenantId
      inviteResult = await inviteUser(payload)
      toast.success($t('users.invite_created'))
      showCreate = false
      showInviteResult = true
      copied = false
      newEmail = ''
      newRole = 'viewer'
      newTenantId = ''
      await loadInvitations()
    } catch (e) {
      toast.error(e.message)
    } finally {
      creating = false
    }
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(inviteResult.invite_url)
      copied = true
      toast.success($t('users.invite_copied'))
    } catch {
      toast.warning(inviteResult.invite_url)
    }
  }

  function closeInviteResult() {
    showInviteResult = false
    inviteResult = null
  }

  async function revokeInvite(inv) {
    try {
      await revokeInvitation(inv.id)
      toast.success($t('users.invite_revoked'))
      await loadInvitations()
    } catch (e) {
      toast.error(e.message)
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
    newRole = 'viewer'
    newTenantId = ''
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) closeModal()
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') closeModal()
  }

  // ── Access modal: devices + site grants ──
  //
  // Two grant kinds live in one modal because a user's accessible device set is
  // `user_devices ∪ user_sites` — showing them apart would let an admin revoke a
  // device checkbox and believe access was gone while a site grant still carried
  // it. Both are STAGED: the modal mutates two Sets and applies everything in
  // saveDevices(), so Cancel discards both. Per-item POST/DELETE for the sites
  // would give one modal two Save semantics.
  let showDevices = false
  let deviceUser = null
  let allDevices = []
  let assignedIds = new Set()
  let devicesLoading = false
  let devicesSaving = false
  let deviceSearch = ''

  // Site grants (user_sites)
  let assignTab = 'devices'      // 'devices' | 'sites'
  let allSites = []
  let grantedSiteIds = new Set()
  let initialSiteIds = new Set() // the set loaded from the server — the diff base
  let siteSearch = ''
  /** True when /api/sites or the grant list could not be read. */
  let sitesUnavailable = false

  $: filteredDevices = deviceSearch
    ? allDevices.filter(d => {
        const q = deviceSearch.toLowerCase()
        return (d.name || '').toLowerCase().includes(q) ||
          (d.mqtt_device_id || '').toLowerCase().includes(q) ||
          (d.location || '').toLowerCase().includes(q) ||
          (d.site_name || '').toLowerCase().includes(q) ||
          (d.model || '').toLowerCase().includes(q)
      })
    : allDevices

  $: filteredSites = siteSearch
    ? allSites.filter(s => {
        const q = siteSearch.toLowerCase()
        return (s.name || '').toLowerCase().includes(q) ||
          (s.city || '').toLowerCase().includes(q) ||
          (s.region || '').toLowerCase().includes(q) ||
          (s.address_line || '').toLowerCase().includes(q)
      })
    : allSites

  async function openDevices(user) {
    deviceUser = user
    devicesLoading = true
    showDevices = true
    deviceSearch = ''
    siteSearch = ''
    assignTab = 'devices'
    allSites = []
    grantedSiteIds = new Set()
    initialSiteIds = new Set()
    sitesUnavailable = false
    try {
      // Superadmin: scope devices AND sites to the target user's tenant. A grant
      // is validated against that tenant server-side, so offering a site from
      // anywhere else could only produce a 400.
      const devParams = $isSuperAdmin && user.tenant_id ? { tenant_id: user.tenant_id } : {}
      const [devs, assigned, sites, granted] = await Promise.all([
        getDevices(devParams),
        getUserDevices(user.id),
        // The site half must never take the device half down with it — this modal
        // is the only way to assign devices at all.
        getSites(devParams).catch(() => null),
        getUserSites(user.id).catch(() => null),
      ])
      allDevices = (devs?.data || devs || []).filter(d => d.status === 'active')
      const ids = (assigned || []).map(d => d.id)
      assignedIds = new Set(ids)
      sitesUnavailable = sites === null || granted === null
      allSites = sites || []
      initialSiteIds = new Set((granted || []).map(s => s.id))
      grantedSiteIds = new Set(initialSiteIds)
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

  function toggleSite(siteId) {
    grantedSiteIds = new Set(grantedSiteIds)
    if (grantedSiteIds.has(siteId)) {
      grantedSiteIds.delete(siteId)
    } else {
      grantedSiteIds.add(siteId)
    }
    grantedSiteIds = grantedSiteIds  // trigger reactivity
  }

  function selectAll() {
    if (assignTab === 'sites') {
      grantedSiteIds = new Set(allSites.map(s => s.id))
    } else {
      assignedIds = new Set(allDevices.map(d => d.id))
    }
  }

  function selectNone() {
    if (assignTab === 'sites') {
      grantedSiteIds = new Set()
    } else {
      assignedIds = new Set()
    }
  }

  /** Re-read the grants so a partial apply cannot look like a clean save. */
  async function reloadSiteGrants() {
    if (!deviceUser) return
    try {
      const granted = await getUserSites(deviceUser.id)
      initialSiteIds = new Set((granted || []).map(s => s.id))
      grantedSiteIds = new Set(initialSiteIds)
    } catch { /* the caller already surfaced the failure */ }
  }

  async function saveDevices() {
    devicesSaving = true
    try {
      await setUserDevices(deviceUser.id, [...assignedIds])

      // Site grants are per-item on the wire; the diff is what makes them behave
      // like the device list next to them. With the grant list unread, the diff
      // base is unknown — applying it would revoke grants nobody touched.
      const toGrant  = sitesUnavailable ? [] : [...grantedSiteIds].filter(id => !initialSiteIds.has(id))
      const toRevoke = sitesUnavailable ? [] : [...initialSiteIds].filter(id => !grantedSiteIds.has(id))
      for (const siteId of toGrant)  await grantUserSite(deviceUser.id, siteId)
      for (const siteId of toRevoke) await revokeUserSite(deviceUser.id, siteId)

      toast.success(toGrant.length || toRevoke.length
        ? $t('users.access_updated')
        : $t('users.devices_updated'))
      showDevices = false
      // A site grant changes what the device checkboxes mean, so the row data
      // behind them is re-read rather than left stale.
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
      await reloadSiteGrants()
    } finally {
      devicesSaving = false
    }
  }

  function closeDevicesModal() {
    showDevices = false
    deviceUser = null
  }

  // ── Technician home base (Part 2 §7.4) ──
  //
  // `GET /api/sites/:id/nearest-technicians` ranks staff by the distance from
  // this point, so a half-set base would put the technician on the prime
  // meridian: latitude and longitude are always written — or cleared — together.
  let showBase = false
  let baseUser = null
  let basePoint = null      // { latitude, longitude, display_name } — AddressPicker mode="point"
  let baseSaving = false

  function openBase(user) {
    baseUser = user
    basePoint = {
      latitude:  user.base_latitude ?? null,
      longitude: user.base_longitude ?? null,
      display_name: user.base_address || '',
    }
    showBase = true
  }

  function closeBaseModal() {
    showBase = false
    baseUser = null
    basePoint = null
  }

  function handleBaseBackdropClick(e) {
    if (e.target === e.currentTarget) closeBaseModal()
  }

  function handleBaseKey(e) {
    if (e.key === 'Escape') closeBaseModal()
  }

  $: baseHasPoint = !!basePoint
    && basePoint.latitude !== null && basePoint.latitude !== undefined && basePoint.latitude !== ''
    && basePoint.longitude !== null && basePoint.longitude !== undefined && basePoint.longitude !== ''

  async function saveBase() {
    if (!baseHasPoint) {
      toast.warning($t('users.base_needs_point'))
      return
    }
    baseSaving = true
    try {
      const address = (basePoint.display_name || '').trim()
      await updateUser(baseUser.id, {
        base_latitude:  Number(basePoint.latitude),
        base_longitude: Number(basePoint.longitude),
        base_address:   address ? address.slice(0, 256) : null,
      })
      toast.success($t('users.base_saved'))
      closeBaseModal()
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      baseSaving = false
    }
  }

  async function clearBase() {
    baseSaving = true
    try {
      await updateUser(baseUser.id, {
        base_latitude: null,
        base_longitude: null,
        base_address: null,
      })
      toast.success($t('users.base_cleared'))
      closeBaseModal()
      await loadUsers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      baseSaving = false
    }
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

  // ── Password reset modal ──
  let showResetModal = false
  let resetCode = ''
  let resetExpires = ''
  let resetUser = null

  async function generateReset(user) {
    try {
      const result = await generatePasswordReset(user.id)
      resetCode = result.reset_code
      resetExpires = result.expires_at
      resetUser = user
      showResetModal = true
      toast.success($t('users.reset_password_generated'))
    } catch (e) {
      toast.error(e.message)
    }
  }

  function closeResetModal() {
    showResetModal = false
    resetCode = ''
    resetExpires = ''
    resetUser = null
  }

  function handleResetBackdropClick(e) {
    if (e.target === e.currentTarget) closeResetModal()
  }

  function handleResetKey(e) {
    if (e.key === 'Escape') closeResetModal()
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

  onMount(() => { loadUsers(); loadInvitations() })
</script>

<div class="users-page">
  <PageHeader title={$t('pages.users')} subtitle={$t('pages.users_sub')}>
    <Button variant="secondary" icon="refresh" on:click={loadUsers}>{$t('common.refresh')}</Button>
    <Button variant="primary" icon="send" on:click={() => showCreate = true}>{$t('users.invite_user')}</Button>
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
                <!-- Device + site access: only for technician/viewer (admin/superadmin see all) -->
                {#if user.role !== 'admin' && user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => openDevices(user)} aria-label="{$t('users.manage_access')} {user.email}" title={$t('users.manage_access')}>
                    <Icon name="cpu" size={13} />
                  </Button>
                {/if}
                <!-- Home base: nearest-technicians ranks exactly technician + admin -->
                {#if user.role === 'technician' || user.role === 'admin'}
                  <Button
                    variant="secondary"
                    size="sm"
                    on:click={() => openBase(user)}
                    aria-label="{$t('users.base_location')} {user.email}"
                    title={user.base_address || (user.base_latitude != null ? $t('users.base_location') : $t('users.base_not_set'))}
                  >
                    <Icon name="map-pin" size={13} />
                  </Button>
                {/if}
                <!-- Manage tenants (superadmin only, not for superadmin users) -->
                {#if $isSuperAdmin && user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => openTenantModal(user)} aria-label="{$t('users.manage_tenants')} {user.email}">
                    <Icon name="grid" size={13} />
                  </Button>
                {/if}
                <!-- Password reset (not for superadmin rows) -->
                {#if user.role !== 'superadmin'}
                  <Button variant="secondary" size="sm" on:click={() => generateReset(user)} aria-label="{$t('users.reset_password_title')} {user.email}">
                    <Icon name="key" size={13} />
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

  {#if invitations.length > 0}
    <section class="section-card">
      <div class="section-header">
        <Icon name="send" size={16} />
        <span>{$t('users.invitations_pending')}</span>
        <Badge variant="neutral" size="sm">{invitations.length}</Badge>
      </div>
      <div class="invite-list">
        {#each invitations as inv (inv.id)}
          <div class="invite-row">
            <div class="invite-main">
              <span class="invite-email">{inv.email}</span>
              <span class="invite-meta">
                <Badge variant={roleVariant(inv.role)} size="sm">{$t('users.role_' + inv.role)}</Badge>
                {#if $isSuperAdmin && inv.tenant_name}<span>· {inv.tenant_name}</span>{/if}
                {#if inv.invited_by_email}<span>· {$t('users.invited_by', inv.invited_by_email)}</span>{/if}
                <span>· {$t('users.invite_expires', new Date(inv.expires_at).toLocaleString())}</span>
              </span>
            </div>
            <Button variant="secondary" size="sm" icon="x" on:click={() => revokeInvite(inv)}>{$t('users.invite_revoke')}</Button>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<!-- Invitation result: the link is always shown — email delivery is optional -->
{#if showInviteResult && inviteResult}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click|self={closeInviteResult} on:keydown={(e) => e.key === 'Escape' && closeInviteResult()} role="dialog" aria-modal="true" aria-labelledby="invite-result-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="invite-result-title">{$t('users.invite_created')}</h3>
          <span class="modal-subtitle">{inviteResult.email}</span>
        </div>
        <button class="modal-close" on:click={closeInviteResult} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <p class="field-hint">
          {inviteResult.email_sent ? $t('users.invite_email_sent', inviteResult.email) : $t('users.invite_email_not_sent')}
        </p>
        {#if inviteResult.existing_user}
          <p class="field-hint">{$t('users.invite_existing_hint')}</p>
        {/if}
        <div class="form-field">
          <span class="field-label">{$t('users.invite_link')}</span>
          <div class="invite-link-box">{inviteResult.invite_url}</div>
        </div>
        <p class="field-hint">{$t('users.invite_link_hint')}</p>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeInviteResult}>{$t('common.close')}</Button>
          <Button variant="primary" icon={copied ? 'check' : 'link'} on:click={copyInviteLink}>{copied ? $t('users.invite_copied') : $t('users.invite_copy')}</Button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Create User Modal -->
{#if showCreate}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleBackdropClick} on:keydown={handleBackdropKey} role="dialog" aria-modal="true" aria-labelledby="create-user-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <h3 id="create-user-title">{$t('users.invite_user')}</h3>
        <button class="modal-close" on:click={closeModal} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <form on:submit|preventDefault={handleInvite} class="modal-body">
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
          <Button variant="primary" type="submit" loading={creating} icon="send">{$t('users.send_invite')}</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Access Modal: per-device assignment + site grants (staged, one Save) -->
{#if showDevices}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleDevicesBackdropClick} on:keydown={handleDevicesKey} role="dialog" aria-modal="true" aria-labelledby="devices-modal-title" tabindex="-1">
    <div class="modal modal-devices">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="devices-modal-title">{$t('users.manage_access')}</h3>
          <span class="modal-subtitle">{deviceUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeDevicesModal} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        {#if devicesLoading}
          <Skeleton height="200px" />
        {:else}
          <!-- Access kind -->
          <div class="access-tabs" role="tablist" aria-label={$t('users.manage_access')}>
            <button
              class="access-tab"
              class:active={assignTab === 'devices'}
              role="tab"
              aria-selected={assignTab === 'devices'}
              on:click={() => assignTab = 'devices'}
            >
              <Icon name="cpu" size={13} />
              <span>{$t('users.devices')}</span>
              <span class="access-tab-count">{assignedIds.size}</span>
            </button>
            <button
              class="access-tab"
              class:active={assignTab === 'sites'}
              role="tab"
              aria-selected={assignTab === 'sites'}
              on:click={() => assignTab = 'sites'}
            >
              <Icon name="map-pin" size={13} />
              <span>{$t('users.sites')}</span>
              <span class="access-tab-count">{grantedSiteIds.size}</span>
            </button>
          </div>

          <p class="field-hint">
            {assignTab === 'sites' ? $t('users.site_grants_hint') : $t('users.device_grants_hint')}
          </p>

          {#if assignTab === 'devices'}
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
                      <!-- `location` is the spot inside the site ("Зал, ряд 3"); after the
                           backfill it can equal the site name, so it is shown only when it
                           actually adds something. -->
                      {#if device.location && device.location !== device.site_name}
                        <span class="device-check-location">{device.location}</span>
                      {/if}
                      {#if device.site_name}
                        <span class="device-check-site">
                          <Icon name="map-pin" size={11} />
                          {device.site_name}
                        </span>
                      {/if}
                      {#if device.model}
                        <span class="device-check-model">{device.model}</span>
                      {/if}
                    </div>
                  </label>
                {/each}
              {/if}
            </div>
          {:else if sitesUnavailable}
            <div class="device-empty">{$t('site.load_error')}</div>
          {:else}
            <!-- Search -->
            <div class="device-search">
              <Icon name="search" size={14} />
              <input
                type="text"
                bind:value={siteSearch}
                placeholder={$t('users.search_sites')}
                class="input device-search-input"
              />
            </div>

            <!-- Bulk actions -->
            <div class="device-bulk-actions">
              <button class="link-btn" on:click={selectAll}>{$t('users.select_all')}</button>
              <span class="sep">|</span>
              <button class="link-btn" on:click={selectNone}>{$t('users.select_none')}</button>
              <span class="device-count">{grantedSiteIds.size} / {allSites.length}</span>
            </div>

            <!-- Site list -->
            <div class="device-checklist">
              {#if filteredSites.length === 0}
                <div class="device-empty">{$t('users.no_sites_found')}</div>
              {:else}
                {#each filteredSites as site (site.id)}
                  <label class="device-check-item" class:checked={grantedSiteIds.has(site.id)}>
                    <input
                      type="checkbox"
                      checked={grantedSiteIds.has(site.id)}
                      on:change={() => toggleSite(site.id)}
                    />
                    <div class="device-check-info">
                      <span class="device-check-name">{site.name}</span>
                      {#if site.city}
                        <span class="device-check-location">{site.city}</span>
                      {/if}
                      {#if site.region}
                        <span class="device-check-id">{site.region}</span>
                      {/if}
                      <span class="device-check-model">
                        {$t('users.site_devices', site.device_count ?? 0)}
                      </span>
                    </div>
                  </label>
                {/each}
              {/if}
            </div>
          {/if}
        {/if}

        <div class="modal-actions">
          <Button variant="secondary" on:click={closeDevicesModal}>{$t('common.cancel')}</Button>
          <Button variant="primary" loading={devicesSaving} on:click={saveDevices} icon="check">{$t('common.save')}</Button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Home Base Modal (Part 2 §7.4) -->
{#if showBase}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleBaseBackdropClick} on:keydown={handleBaseKey} role="dialog" aria-modal="true" aria-labelledby="base-modal-title" tabindex="-1">
    <div class="modal modal-base">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="base-modal-title">{$t('users.base_location_title')}</h3>
          <span class="modal-subtitle">{baseUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeBaseModal} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <p class="field-hint">{$t('users.base_location_hint')}</p>

        <!--
          Lazily imported: AddressPicker pulls in MapCanvas and therefore Leaflet.
          A static import here would drag ~150 KB into the entry chunk that every
          user downloads on every page.
        -->
        {#await import('../components/map/AddressPicker.svelte')}
          <Skeleton height="300px" />
        {:then { default: AddressPicker }}
          <AddressPicker mode="point" bind:value={basePoint} disabled={baseSaving} height="240px" />
        {:catch}
          <div class="device-empty">{$t('users.base_picker_failed')}</div>
        {/await}

        <div class="modal-actions base-actions">
          <!-- Disabled, not hidden, when there is nothing to clear: the button
               stays in the same place whether or not a base is set. -->
          <Button
            variant="secondary"
            disabled={baseSaving || (baseUser?.base_latitude == null && baseUser?.base_longitude == null)}
            on:click={clearBase}
          >{$t('users.clear_base')}</Button>
          <span class="base-spacer" />
          <Button variant="secondary" on:click={closeBaseModal}>{$t('common.cancel')}</Button>
          <Button variant="primary" loading={baseSaving} disabled={!baseHasPoint} on:click={saveBase} icon="check">{$t('common.save')}</Button>
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
        <button class="modal-close" on:click={closeTenantModal} aria-label={$t('common.close')}>
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
        <button class="modal-close" on:click={closeTelegramModal} aria-label={$t('common.close')}>
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

<!-- Password Reset Modal -->
{#if showResetModal}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={handleResetBackdropClick} on:keydown={handleResetKey} role="dialog" aria-modal="true" aria-labelledby="reset-modal-title" tabindex="-1">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 id="reset-modal-title">{$t('users.reset_password_title')}</h3>
          <span class="modal-subtitle">{resetUser?.email}</span>
        </div>
        <button class="modal-close" on:click={closeResetModal} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <span class="field-label">{$t('users.reset_password_code')}</span>
          <div class="telegram-code">{resetCode}</div>
        </div>
        <p class="field-hint">{$t('users.reset_password_instructions')}</p>
        <p class="field-hint">{$t('users.reset_password_expires')}</p>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeResetModal}>{$t('common.close')}</Button>
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
  /* Wide enough for the home-base button added alongside the existing actions. */
  .th-actions { width: 172px; text-align: right; }

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
  .cell-actions { width: 172px; justify-content: flex-end; gap: var(--space-1); }

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

  .device-check-site {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-xs);
    color: var(--accent-blue);
    flex-shrink: 0;
  }

  /* Access modal: devices ↔ sites */
  .access-tabs {
    display: flex;
    gap: var(--space-1);
    padding: 3px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
  }

  .access-tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .access-tab:hover {
    color: var(--text-primary);
  }

  .access-tab.active {
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.15));
  }

  .access-tab-count {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
  }

  .access-tab.active .access-tab-count {
    color: var(--accent-blue);
  }

  /* Home base modal */
  .modal-base {
    max-width: 560px;
  }

  .base-actions {
    align-items: center;
  }

  .base-spacer {
    flex: 1;
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
  .invite-list {
    display: flex;
    flex-direction: column;
  }
  .invite-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }
  .invite-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .invite-email {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .invite-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .invite-link-box {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    word-break: break-all;
    user-select: all;
  }

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
