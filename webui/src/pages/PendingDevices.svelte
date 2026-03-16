<script>
  import { onMount, onDestroy } from 'svelte'
  import { getPendingDevices, assignDevice, deletePendingDevice, batchRegisterDevices, getTenants } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { isSuperAdmin, navigate } from '../lib/stores.js'
  import { timeAgo } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'

  let devices = []
  let loading = true
  let error = null

  // Assign modal state
  let assigningDevice = null
  let assignName = ''
  let assignLocation = ''
  let assignModel = ''
  let assignSerial = ''
  let assignTenantId = ''
  let assigning = false

  // Tenants list for superadmin
  let tenantsList = []
  let tenantsLoaded = false

  // Delete confirmation state
  let deletingDevice = null
  let deleting = false

  // Credentials result after assign
  let credsResult = null

  // Batch registration state
  let batchModalOpen = false
  let batchFile = null
  let batchFileName = ''
  let batchUploading = false
  let batchResults = null
  let batchTenantId = ''
  let fileInput

  function closeCredsModal() {
    credsResult = null
  }

  function handleCredsKey(e) {
    if (e.key === 'Escape') closeCredsModal()
  }

  async function copyPassword() {
    if (credsResult?.mqtt_credentials?.password) {
      await navigator.clipboard.writeText(credsResult.mqtt_credentials.password)
      toast.success($t('pending.creds_copied'))
    }
  }

  async function load() {
    try {
      devices = await getPendingDevices()
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function openAssign(dev) {
    assigningDevice = dev
    assignName = ''
    assignLocation = ''
    assignModel = ''
    assignSerial = ''
    assignTenantId = ''

    // Load tenants for superadmin dropdown
    if ($isSuperAdmin && !tenantsLoaded) {
      try {
        const all = await getTenants()
        tenantsList = all.filter(t =>
          t.id !== '00000000-0000-0000-0000-000000000000' && t.active
        )
        tenantsLoaded = true
        if (tenantsList.length > 0) assignTenantId = tenantsList[0].id
      } catch (e) {
        toast.error(e.message)
      }
    } else if ($isSuperAdmin && tenantsList.length > 0) {
      assignTenantId = tenantsList[0].id
    }
  }

  function closeAssign() {
    assigningDevice = null
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') closeAssign()
  }

  async function confirmAssign() {
    if (!assigningDevice) return
    if (!assignName.trim()) {
      toast.error($t('pending.name_required'))
      return
    }
    assigning = true
    try {
      const opts = {
        name: assignName.trim(),
        location: assignLocation || undefined,
        model: assignModel || undefined,
        serial_number: assignSerial || undefined,
      }
      // Superadmin can assign to a specific tenant
      if ($isSuperAdmin && assignTenantId) {
        opts.tenant_id = assignTenantId
      }
      const result = await assignDevice(assigningDevice.mqtt_device_id, opts)
      toast.success($t('pending.device_assigned', assigningDevice.mqtt_device_id))
      assigningDevice = null
      // Show credentials result if present
      if (result.mqtt_credentials) {
        credsResult = result
      }
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      assigning = false
    }
  }

  function openDelete(dev) {
    deletingDevice = dev
  }

  function closeDelete() {
    deletingDevice = null
  }

  function handleDeleteKey(e) {
    if (e.key === 'Escape') closeDelete()
  }

  async function confirmDelete() {
    if (!deletingDevice) return
    deleting = true
    try {
      await deletePendingDevice(deletingDevice.mqtt_device_id)
      toast.success($t('pending.device_deleted', deletingDevice.mqtt_device_id))
      deletingDevice = null
      await load()
      // Navigate to dashboard if no pending devices left
      if (devices.length === 0) {
        navigate('/')
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      deleting = false
    }
  }

  // ── Batch registration functions ──
  function openBatchModal() {
    batchModalOpen = true
    batchFile = null
    batchFileName = ''
    batchResults = null
    if ($isSuperAdmin && !tenantsLoaded) {
      getTenants().then(all => {
        tenantsList = all.filter(t =>
          t.id !== '00000000-0000-0000-0000-000000000000' && t.active
        )
        tenantsLoaded = true
        if (tenantsList.length > 0) batchTenantId = tenantsList[0].id
      }).catch(() => {})
    } else if ($isSuperAdmin && tenantsList.length > 0 && !batchTenantId) {
      batchTenantId = tenantsList[0].id
    }
  }

  function closeBatchModal() {
    batchModalOpen = false
    batchFile = null
    batchFileName = ''
    if (batchResults) {
      load()  // Refresh list after batch
    }
    batchResults = null
  }

  function handleBatchKey(e) {
    if (e.key === 'Escape') closeBatchModal()
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (file) {
      batchFile = file
      batchFileName = file.name
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file && file.name.toLowerCase().endsWith('.csv')) {
      batchFile = file
      batchFileName = file.name
    }
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  async function submitBatch() {
    if (!batchFile) {
      toast.warning($t('pending.batch_no_file'))
      return
    }
    batchUploading = true
    try {
      const tenantId = ($isSuperAdmin && batchTenantId) ? batchTenantId : undefined
      batchResults = await batchRegisterDevices(batchFile, tenantId)
      toast.success($t('pending.batch_success'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      batchUploading = false
    }
  }

  function downloadTemplate() {
    const template = 'mqtt_device_id,name,serial_number,location,model,comment\n'
    const blob = new Blob([template], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'batch_register_template.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function downloadCredentialsCsv() {
    if (!batchResults?.results) return
    const assigned = batchResults.results.filter(r => r.status === 'assigned' && r.credentials)
    if (!assigned.length) return
    const BOM = '\uFEFF'
    let csv = BOM + 'mqtt_device_id,name,username,password\n'
    for (const r of assigned) {
      const name = r.name?.includes(',') ? `"${r.name}"` : (r.name || '')
      csv += `${r.mqtt_device_id},${name},${r.credentials.username},${r.credentials.password}\n`
    }
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `credentials_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  let wsUnsub
  let pollInterval

  onMount(() => {
    load()
    wsUnsub = on('pending_device', () => load())
    // Poll every 15s as fallback — pending devices are rare, WS may miss restarts
    pollInterval = setInterval(load, 15000)
  })

  onDestroy(() => {
    wsUnsub?.()
    clearInterval(pollInterval)
  })
</script>

<div class="pending-page">
  <PageHeader title={$t('pages.pending')} subtitle={$t('pages.pending_sub')}>
    <Button variant="secondary" icon="upload" on:click={openBatchModal}>{$t('pending.batch_register')}</Button>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <div class="skeleton-list">
      {#each Array(3) as _}
        <Skeleton height="80px" />
      {/each}
    </div>
  {:else if error}
    <EmptyState icon="x-circle" title="Failed to load" message={error} />
  {:else if devices.length === 0}
    <EmptyState
      icon="wifi"
      title={$t('pending.no_pending')}
      message={$t('pending.no_pending_hint')}
    />
  {:else}
    <div class="device-list">
      {#each devices as dev (dev.id)}
        <div class="device-row">
          <div class="device-info">
            <StatusDot status={dev.online ? 'online' : 'offline'} />
            <span class="device-id">{dev.mqtt_device_id}</span>
            {#if dev.name}
              <span class="device-name-hint">{dev.name}</span>
            {/if}
            {#if dev.firmware_version}
              <Badge variant="neutral" size="sm">FW: {dev.firmware_version}</Badge>
            {/if}
            <Badge variant={dev.online ? 'success' : 'neutral'} size="sm">
              {dev.online ? 'Online' : 'Offline'}
            </Badge>
          </div>
          <div class="device-meta">
            {#if dev.location}
              <span class="meta-item">
                <Icon name="map-pin" size={12} />
                {dev.location}
              </span>
            {/if}
            <span class="meta-item">
              <Icon name="clock" size={12} />
              {timeAgo(dev.last_seen)}
            </span>
          </div>
          <div class="device-actions">
            <Button variant="primary" size="sm" on:click={() => openAssign(dev)}>
              {$t('pending.assign_to_tenant')}
            </Button>
            <Button variant="danger" size="sm" icon="trash-2" on:click={() => openDelete(dev)}>
              {$t('pending.delete_device')}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Assign Modal -->
{#if assigningDevice}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={closeAssign} on:keydown={handleBackdropKey} role="dialog" aria-modal="true" aria-labelledby="assign-modal-title" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3 id="assign-modal-title">{$t('pending.assign_device')}</h3>
        <button class="close-btn" on:click={closeAssign} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <div class="assign-device-info">
          <StatusDot status={assigningDevice.online ? 'online' : 'offline'} />
          <span class="device-id">{assigningDevice.mqtt_device_id}</span>
          {#if assigningDevice.firmware_version}
            <Badge variant="neutral" size="sm">v{assigningDevice.firmware_version}</Badge>
          {/if}
        </div>

        {#if $isSuperAdmin && tenantsList.length > 0}
          <label class="field">
            <span>{$t('pending.target_tenant')}</span>
            <select bind:value={assignTenantId} class="tenant-select">
              {#each tenantsList as tenant}
                <option value={tenant.id}>{tenant.name} ({tenant.slug})</option>
              {/each}
            </select>
          </label>
        {/if}

        <label class="field">
          <span>{$t('pending.device_name')} <span class="required">*</span></span>
          <input type="text" bind:value={assignName} placeholder={$t('pending.device_name_placeholder')} required />
        </label>

        <label class="field">
          <span>{$t('device.location')}</span>
          <input type="text" bind:value={assignLocation} placeholder={$t('pending.location_placeholder')} />
        </label>

        <label class="field">
          <span>{$t('device.model')}</span>
          <input type="text" bind:value={assignModel} placeholder={$t('pending.model_placeholder')} />
        </label>

        <label class="field">
          <span>{$t('device.serial_number')}</span>
          <input type="text" bind:value={assignSerial} placeholder={$t('pending.serial_placeholder')} />
        </label>
      </div>

      <div class="modal-actions">
        <Button variant="secondary" on:click={closeAssign} disabled={assigning}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={confirmAssign} loading={assigning}>{$t('common.assign')}</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Credentials Result Modal -->
{#if credsResult}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={closeCredsModal} on:keydown={handleCredsKey} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3>{$t('pending.device_assigned', credsResult.mqtt_device_id)}</h3>
        <button class="close-btn" on:click={closeCredsModal} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        {#if credsResult.mqtt_credentials.sent_via_mqtt}
          <div class="creds-success">
            <Icon name="refresh-cw" size={16} />
            <div>
              <strong>{$t('pending.creds_sent_mqtt')}</strong>
              <p>{$t('pending.creds_sent_mqtt_hint')}</p>
            </div>
          </div>
        {:else}
          <div class="creds-warning">
            <Icon name="alert-triangle" size={16} />
            <strong>{$t('pending.creds_manual')}</strong>
          </div>
          <div class="creds-details">
            <div class="creds-row">
              <span class="creds-label">Username:</span>
              <code>{credsResult.mqtt_credentials.username}</code>
            </div>
            <div class="creds-row">
              <span class="creds-label">Password:</span>
              <code>{credsResult.mqtt_credentials.password}</code>
            </div>
            <div class="creds-row">
              <span class="creds-label">Host:</span>
              <code>{credsResult.mqtt_credentials.mqtt_host}:{credsResult.mqtt_credentials.mqtt_port}</code>
            </div>
          </div>
          <Button variant="secondary" size="sm" icon="copy" on:click={copyPassword}>
            {$t('pending.creds_copy')}
          </Button>
        {/if}
      </div>
      <div class="modal-actions">
        <Button variant="primary" on:click={closeCredsModal}>{$t('common.close')}</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete Confirmation Modal -->
{#if deletingDevice}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={closeDelete} on:keydown={handleDeleteKey} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3>{$t('pending.delete_device')}</h3>
        <button class="close-btn" on:click={closeDelete} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="delete-warning">
          <Icon name="alert-triangle" size={16} />
          <span>{$t('pending.delete_confirm', deletingDevice.mqtt_device_id)}</span>
        </div>
        <div class="assign-device-info">
          <StatusDot status={deletingDevice.online ? 'online' : 'offline'} />
          <span class="device-id">{deletingDevice.mqtt_device_id}</span>
        </div>
      </div>
      <div class="modal-actions">
        <Button variant="secondary" on:click={closeDelete} disabled={deleting}>{$t('common.cancel')}</Button>
        <Button variant="danger" on:click={confirmDelete} loading={deleting}>{$t('pending.delete_device')}</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Batch Registration Modal -->
{#if batchModalOpen}
  <input type="file" accept=".csv" class="hidden-file" bind:this={fileInput} on:change={handleFileSelect} />
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={closeBatchModal} on:keydown={handleBatchKey} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal batch-modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3>{batchResults ? $t('pending.batch_results_title') : $t('pending.batch_upload_title')}</h3>
        <button class="close-btn" on:click={closeBatchModal} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
      </div>

      {#if batchResults}
        <!-- Results view -->
        <div class="modal-body">
          <div class="batch-summary">
            {#if batchResults.summary.assigned > 0}
              <Badge variant="success" size="sm">{batchResults.summary.assigned} {$t('pending.batch_assigned')}</Badge>
            {/if}
            {#if batchResults.summary.pre_registered > 0}
              <Badge variant="info" size="sm">{batchResults.summary.pre_registered} {$t('pending.batch_pre_registered')}</Badge>
            {/if}
            {#if batchResults.summary.skipped > 0}
              <Badge variant="neutral" size="sm">{batchResults.summary.skipped} {$t('pending.batch_skipped')}</Badge>
            {/if}
          </div>

          <div class="batch-results-table">
            {#each batchResults.results as r (r.row)}
              <div class="batch-result-row" class:result-assigned={r.status === 'assigned'} class:result-pre={r.status === 'pre_registered'} class:result-skip={r.status === 'skipped'}>
                <span class="result-id font-mono">{r.mqtt_device_id}</span>
                <span class="result-name">{r.name || ''}</span>
                <Badge variant={r.status === 'assigned' ? 'success' : r.status === 'pre_registered' ? 'info' : 'neutral'} size="sm">
                  {$t(`pending.batch_${r.status === 'pre_registered' ? 'pre_registered' : r.status}`)}
                </Badge>
                {#if r.error}
                  <span class="result-error">{r.error}</span>
                {/if}
              </div>
            {/each}
          </div>

          {#if batchResults.summary.assigned > 0}
            <div class="creds-warning">
              <Icon name="alert-triangle" size={16} />
              <span>{$t('pending.batch_download_creds_hint')}</span>
            </div>
          {/if}
        </div>

        <div class="modal-actions">
          {#if batchResults.summary.assigned > 0}
            <Button variant="secondary" icon="download" on:click={downloadCredentialsCsv}>
              {$t('pending.batch_download_creds')}
            </Button>
          {/if}
          <Button variant="primary" on:click={closeBatchModal}>{$t('common.close')}</Button>
        </div>
      {:else}
        <!-- Upload view -->
        <div class="modal-body">
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <div class="drop-zone" on:drop={handleDrop} on:dragover={handleDragOver} on:click={() => fileInput?.click()}>
            {#if batchFile}
              <Icon name="check-circle" size={24} />
              <span class="drop-filename">{batchFileName}</span>
            {:else}
              <Icon name="upload" size={24} />
              <span>{$t('pending.batch_select_file')}</span>
            {/if}
          </div>

          <div class="batch-format-hint">
            <span class="format-label">{$t('pending.batch_csv_format')}</span>
            <button class="template-link" on:click|stopPropagation={downloadTemplate}>
              <Icon name="download" size={12} />
              {$t('pending.batch_template')}
            </button>
          </div>

          {#if $isSuperAdmin && tenantsList.length > 0}
            <label class="field">
              <span>{$t('pending.batch_target_tenant')}</span>
              <select bind:value={batchTenantId} class="tenant-select">
                {#each tenantsList as tenant}
                  <option value={tenant.id}>{tenant.name} ({tenant.slug})</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>

        <div class="modal-actions">
          <Button variant="secondary" on:click={closeBatchModal} disabled={batchUploading}>{$t('common.cancel')}</Button>
          <Button variant="primary" on:click={submitBatch} loading={batchUploading} disabled={!batchFile}>
            {batchUploading ? $t('pending.batch_uploading') : $t('common.upload')}
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .pending-page {
    display: flex;
    flex-direction: column;
    animation: fade-in 0.3s ease-out;
  }

  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .device-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .device-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    transition: border-color var(--transition-fast);
  }

  .device-row:hover {
    border-color: var(--text-muted);
  }

  .device-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .device-id {
    font-weight: 700;
    font-family: var(--font-mono);
    font-size: var(--text-base);
    color: var(--text-primary);
  }

  .device-meta {
    display: flex;
    gap: var(--space-3);
    flex-shrink: 0;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .device-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .delete-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-md);
    color: var(--accent-red, #ef4444);
    font-size: var(--text-sm);
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fade-in 0.15s ease-out;
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 90%;
    max-width: 440px;
    box-shadow: var(--shadow-lg);
    animation: slide-in-up 0.2s ease-out;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h3 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: flex;
  }

  .close-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
  }

  .modal-body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .assign-device-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-md);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field span {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .field input {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    transition: border-color var(--transition-fast);
  }

  .field input::placeholder {
    color: var(--text-muted);
  }

  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: var(--accent-blue);
    box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.1);
  }

  .required {
    color: var(--accent-red, #ef4444);
    margin-left: 2px;
  }

  .tenant-select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    transition: border-color var(--transition-fast);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-muted);
  }

  /* Credentials modal */
  .creds-success {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.3);
    border-radius: var(--radius-md);
    color: var(--accent-green, #4ade80);
  }

  .creds-success p {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .creds-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: var(--radius-md);
    color: var(--accent-amber, #fbbf24);
    font-size: var(--text-sm);
  }

  .creds-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .creds-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .creds-label {
    color: var(--text-muted);
    min-width: 80px;
  }

  .creds-details code {
    color: var(--text-primary);
    word-break: break-all;
  }

  .device-name-hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-weight: 400;
  }

  /* Batch modal */
  .batch-modal {
    max-width: 560px;
  }

  .hidden-file {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }

  .drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-6);
    border: 2px dashed var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: pointer;
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }

  .drop-zone:hover {
    border-color: var(--accent-blue);
    background: rgba(74, 158, 255, 0.05);
  }

  .drop-filename {
    font-weight: 600;
    color: var(--text-primary);
  }

  .batch-format-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .format-label {
    font-family: var(--font-mono);
  }

  .template-link {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    color: var(--accent-blue);
    cursor: pointer;
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
  }

  .template-link:hover {
    background: rgba(74, 158, 255, 0.1);
  }

  .batch-summary {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .batch-results-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
    max-height: 300px;
    overflow-y: auto;
  }

  .batch-result-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    font-size: var(--text-sm);
  }

  .batch-result-row:last-child {
    border-bottom: none;
  }

  .result-assigned {
    background: rgba(74, 222, 128, 0.05);
  }

  .result-pre {
    background: rgba(74, 158, 255, 0.05);
  }

  .result-id {
    font-weight: 600;
    color: var(--text-primary);
    min-width: 80px;
  }

  .result-name {
    flex: 1;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .result-error {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .font-mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  @media (max-width: 640px) {
    .device-row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .device-actions {
      align-self: flex-end;
    }

    .batch-modal {
      max-width: 95%;
    }
  }
</style>
