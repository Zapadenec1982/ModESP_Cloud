<script>
  import { onMount } from 'svelte'
  import { getTenants, createTenant, updateTenant, deleteTenant } from '../lib/api.js'
  import { isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'

  let tenants = []
  let loading = true
  let error = null

  // Create modal
  let showCreate = false
  let newName = ''
  let newSlug = ''
  let newPlan = 'free'
  let creating = false

  // Edit modal
  let showEdit = false
  let editTenant = null
  let editName = ''
  let editPlan = ''
  let editActive = true
  let saving = false

  // Auto-generate slug from name
  $: if (showCreate && newName) {
    newSlug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 64)
  }

  async function loadTenants() {
    loading = true
    error = null
    try {
      tenants = await getTenants()
    } catch (err) {
      error = err.message
    } finally {
      loading = false
    }
  }

  onMount(loadTenants)

  // ── Create ──

  function openCreate() {
    if (!$isSuperAdmin) {
      toast.error($t('tenants.superadmin_only'))
      return
    }
    newName = ''
    newSlug = ''
    newPlan = 'free'
    showCreate = true
  }

  function closeCreate() {
    showCreate = false
  }

  async function handleCreate() {
    if (!newName.trim()) {
      toast.error($t('tenants.name_required'))
      return
    }
    if (!newSlug.trim()) {
      toast.error($t('tenants.slug_required'))
      return
    }
    creating = true
    try {
      await createTenant({ name: newName.trim(), slug: newSlug.trim(), plan: newPlan })
      toast.success($t('tenants.tenant_created'))
      closeCreate()
      await loadTenants()
    } catch (err) {
      toast.error(err.message)
    } finally {
      creating = false
    }
  }

  // ── Edit ──

  function openEdit(tenant) {
    if (!$isSuperAdmin) {
      toast.error($t('tenants.superadmin_only'))
      return
    }
    if (tenant.id === SYSTEM_TENANT_ID) {
      toast.error($t('tenants.cannot_edit_system'))
      return
    }
    editTenant = tenant
    editName = tenant.name
    editPlan = tenant.plan
    editActive = tenant.active
    showEdit = true
  }

  function closeEdit() {
    showEdit = false
    editTenant = null
  }

  async function handleEdit() {
    if (!editName.trim()) {
      toast.error($t('tenants.name_required'))
      return
    }
    saving = true
    try {
      const data = {}
      if (editName.trim() !== editTenant.name) data.name = editName.trim()
      if (editPlan !== editTenant.plan) data.plan = editPlan
      if (editActive !== editTenant.active) data.active = editActive

      if (Object.keys(data).length === 0) {
        closeEdit()
        return
      }

      await updateTenant(editTenant.id, data)
      toast.success($t('tenants.tenant_updated'))
      closeEdit()
      await loadTenants()
    } catch (err) {
      toast.error(err.message)
    } finally {
      saving = false
    }
  }

  // ── Delete (soft) ──

  async function handleDelete(tenant) {
    if (!$isSuperAdmin) return
    if (tenant.id === SYSTEM_TENANT_ID) {
      toast.error($t('tenants.cannot_edit_system'))
      return
    }
    const msg = $t('tenants.delete_confirm').replace('{0}', tenant.name)
    if (!confirm(msg)) return

    try {
      await deleteTenant(tenant.id)
      toast.success($t('tenants.tenant_deactivated').replace('{0}', tenant.name))
      await loadTenants()
    } catch (err) {
      toast.error(err.message)
    }
  }

  // ── Toggle active ──

  async function handleToggleActive(tenant) {
    if (!$isSuperAdmin) return
    if (tenant.id === SYSTEM_TENANT_ID) {
      toast.error($t('tenants.cannot_edit_system'))
      return
    }
    try {
      await updateTenant(tenant.id, { active: !tenant.active })
      const key = tenant.active ? 'tenants.tenant_deactivated' : 'tenants.tenant_reactivated'
      toast.success($t(key).replace('{0}', tenant.name))
      await loadTenants()
    } catch (err) {
      toast.error(err.message)
    }
  }

  function planColor(plan) {
    switch (plan) {
      case 'enterprise': return 'danger'
      case 'pro': return 'info'
      case 'basic': return 'success'
      default: return 'neutral'
    }
  }

  function formatDate(d) {
    if (!d) return '—'
    return new Date(d).toLocaleDateString()
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      showCreate = false
      showEdit = false
    }
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') {
      showCreate = false
      showEdit = false
    }
  }
</script>

<div class="tenants-page">
  <PageHeader title={$t('pages.tenants')} subtitle={$t('pages.tenants_sub')}>
    <Button variant="secondary" icon="refresh" on:click={loadTenants}>{$t('common.refresh')}</Button>
    {#if $isSuperAdmin}
      <Button variant="primary" icon="plus" on:click={openCreate}>{$t('tenants.new_tenant')}</Button>
    {/if}
  </PageHeader>

  {#if loading}
    <Skeleton height="400px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else if tenants.length === 0}
    <EmptyState icon="layers" title={$t('tenants.no_tenants')} message={$t('tenants.no_tenants_hint')} />
  {:else}
    <section class="section-card">
      <div class="section-header">
        <h2><Icon name="layers" size={18} /> {$t('tenants.organizations')}</h2>
        <span class="count-badge">{tenants.length}</span>
      </div>

      <!-- Table header -->
      <div class="table-header">
        <span class="th-name">{$t('tenants.col_name')}</span>
        <span class="th-slug">{$t('tenants.col_slug')}</span>
        <span class="th-plan">{$t('tenants.col_plan')}</span>
        <span class="th-devices">{$t('tenants.col_devices')}</span>
        <span class="th-users">{$t('tenants.col_users')}</span>
        <span class="th-status">{$t('tenants.col_status')}</span>
        <span class="th-created">{$t('tenants.col_created')}</span>
        <span class="th-actions">{$t('common.actions')}</span>
      </div>

      <!-- Rows -->
      <div class="tenant-list">
        {#each tenants as tenant (tenant.id)}
          <div class="tenant-row" class:inactive={!tenant.active} class:system={tenant.id === SYSTEM_TENANT_ID}>
            <span class="cell cell-name">
              <strong>{tenant.name}</strong>
              {#if tenant.id === SYSTEM_TENANT_ID}
                <Badge variant="neutral" size="sm">system</Badge>
              {/if}
            </span>
            <span class="cell cell-slug">
              <code>{tenant.slug}</code>
            </span>
            <span class="cell cell-plan">
              <Badge variant={planColor(tenant.plan)} size="sm">{$t('tenants.plan_' + tenant.plan)}</Badge>
            </span>
            <span class="cell cell-devices">{tenant.device_count ?? 0}</span>
            <span class="cell cell-users">{tenant.user_count ?? 0}</span>
            <span class="cell cell-status">
              {#if tenant.active}
                <Badge variant="success" size="sm">{$t('common.active')}</Badge>
              {:else}
                <Badge variant="neutral" size="sm">{$t('common.inactive')}</Badge>
              {/if}
            </span>
            <span class="cell cell-created">{formatDate(tenant.created_at)}</span>
            <span class="cell cell-actions">
              {#if $isSuperAdmin && tenant.id !== SYSTEM_TENANT_ID}
                <button class="icon-btn" title={$t('common.edit')} on:click={() => openEdit(tenant)}>
                  <Icon name="edit" size={15} />
                </button>
                {#if tenant.active}
                  <button class="icon-btn danger" title={$t('common.delete')} on:click={() => handleDelete(tenant)}>
                    <Icon name="x-circle" size={15} />
                  </button>
                {:else}
                  <button class="icon-btn success" title={$t('common.active')} on:click={() => handleToggleActive(tenant)}>
                    <Icon name="check-circle" size={15} />
                  </button>
                {/if}
              {/if}
            </span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<!-- Create Modal -->
{#if showCreate}
  <div class="modal-backdrop" role="presentation" on:click={handleBackdropClick} on:keydown={handleBackdropKey}>
    <div class="modal">
      <div class="modal-header">
        <h3>{$t('tenants.create_tenant')}</h3>
        <button class="modal-close" on:click={closeCreate}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <form class="modal-body" on:submit|preventDefault={handleCreate}>
        <label class="field">
          <span class="field-label">{$t('tenants.name_label')}</span>
          <input type="text" bind:value={newName} placeholder={$t('tenants.name_placeholder')} />
        </label>
        <label class="field">
          <span class="field-label">{$t('tenants.slug_label')}</span>
          <input type="text" bind:value={newSlug} placeholder={$t('tenants.slug_placeholder')} pattern="[a-z0-9][a-z0-9_-]*" />
          <span class="field-hint">{$t('tenants.slug_hint')}</span>
        </label>
        <label class="field">
          <span class="field-label">{$t('tenants.plan_label')}</span>
          <select bind:value={newPlan}>
            <option value="free">{$t('tenants.plan_free')}</option>
            <option value="basic">{$t('tenants.plan_basic')}</option>
            <option value="pro">{$t('tenants.plan_pro')}</option>
            <option value="enterprise">{$t('tenants.plan_enterprise')}</option>
          </select>
        </label>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeCreate}>{$t('common.cancel')}</Button>
          <Button variant="primary" type="submit" loading={creating}>{$t('tenants.create_tenant')}</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Edit Modal -->
{#if showEdit && editTenant}
  <div class="modal-backdrop" role="presentation" on:click={handleBackdropClick} on:keydown={handleBackdropKey}>
    <div class="modal">
      <div class="modal-header">
        <h3>{$t('tenants.edit_tenant')}</h3>
        <button class="modal-close" on:click={closeEdit}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <form class="modal-body" on:submit|preventDefault={handleEdit}>
        <label class="field">
          <span class="field-label">{$t('tenants.name_label')}</span>
          <input type="text" bind:value={editName} placeholder={$t('tenants.name_placeholder')} />
        </label>
        <label class="field">
          <span class="field-label">{$t('tenants.slug_label')}</span>
          <input type="text" value={editTenant.slug} disabled />
          <span class="field-hint">{$t('tenants.slug_hint')}</span>
        </label>
        <label class="field">
          <span class="field-label">{$t('tenants.plan_label')}</span>
          <select bind:value={editPlan}>
            <option value="free">{$t('tenants.plan_free')}</option>
            <option value="basic">{$t('tenants.plan_basic')}</option>
            <option value="pro">{$t('tenants.plan_pro')}</option>
            <option value="enterprise">{$t('tenants.plan_enterprise')}</option>
          </select>
        </label>
        <label class="field checkbox-field">
          <input type="checkbox" bind:checked={editActive} />
          <span>{$t('common.active')}</span>
        </label>
        <div class="modal-actions">
          <Button variant="secondary" on:click={closeEdit}>{$t('common.cancel')}</Button>
          <Button variant="primary" type="submit" loading={saving}>{$t('common.save')}</Button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .tenants-page {
    max-width: 1200px;
    margin: 0 auto;
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
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .section-header h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    flex: 1;
  }

  .count-badge {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }

  .table-header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    background: var(--bg-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .th-name     { flex: 2; min-width: 140px; }
  .th-slug     { flex: 1.5; min-width: 100px; }
  .th-plan     { flex: 1; min-width: 80px; }
  .th-devices  { flex: 0.7; min-width: 60px; text-align: center; }
  .th-users    { flex: 0.7; min-width: 60px; text-align: center; }
  .th-status   { flex: 0.8; min-width: 70px; }
  .th-created  { flex: 1; min-width: 80px; }
  .th-actions  { flex: 0.8; min-width: 60px; text-align: right; }

  .tenant-list {
    max-height: 600px;
    overflow-y: auto;
  }

  .tenant-row {
    display: flex;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    transition: background var(--transition-fast);
  }

  .tenant-row:last-child { border-bottom: none; }
  .tenant-row:hover { background: var(--bg-hover); }
  .tenant-row.inactive { opacity: 0.5; }
  .tenant-row.system { background: var(--bg-secondary); }

  .cell { font-size: var(--text-sm); color: var(--text-secondary); }
  .cell-name    { flex: 2; min-width: 140px; display: flex; align-items: center; gap: var(--space-2); }
  .cell-name strong { color: var(--text-primary); font-weight: 500; }
  .cell-slug    { flex: 1.5; min-width: 100px; }
  .cell-slug code {
    font-size: var(--text-xs);
    background: var(--bg-tertiary);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
  }
  .cell-plan    { flex: 1; min-width: 80px; }
  .cell-devices { flex: 0.7; min-width: 60px; text-align: center; }
  .cell-users   { flex: 0.7; min-width: 60px; text-align: center; }
  .cell-status  { flex: 0.8; min-width: 70px; }
  .cell-created { flex: 1; min-width: 80px; }
  .cell-actions { flex: 0.8; min-width: 60px; display: flex; gap: var(--space-1); justify-content: flex-end; }

  .icon-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
    transition: all var(--transition-fast);
  }
  .icon-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .icon-btn.danger:hover { color: var(--accent-red); }
  .icon-btn.success:hover { color: var(--accent-green); }

  /* ── Modal ── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: var(--space-4);
  }

  .modal {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 480px;
    max-height: 90vh;
    overflow-y: auto;
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
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
  }
  .modal-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field-label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .field input[type="text"],
  .field select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
  }

  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.15);
  }

  .field input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-field {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  .checkbox-field input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-blue);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-top: var(--space-2);
  }

  /* ── Responsive ── */

  @media (max-width: 768px) {
    .table-header { display: none; }
    .tenant-row { flex-wrap: wrap; gap: var(--space-2); }
    .cell-slug, .cell-created { display: none; }
    .cell-name { flex: 1; min-width: 100%; }
    .cell-plan { flex: 1; }
    .cell-devices, .cell-users { flex: 0; min-width: auto; }
    .cell-status { flex: 1; }
    .cell-actions { flex: 1; justify-content: flex-start; }
  }
</style>
