<script>
  import { onMount, onDestroy } from 'svelte'
  import {
    getFirmwares, uploadFirmware, deleteFirmware,
    getDevices, deployOta, createRollout,
    getOtaJobs, getRollouts,
    pauseRollout, resumeRollout, cancelRollout,
  } from '../lib/api.js'
  import { formatBytes, formatDate } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Tabs from '../components/ui/Tabs.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import { toast } from '../lib/toast.js'

  // ── State ──────────────────────────────────────────────

  let firmwares = []
  let devices = []
  let jobs = []
  let rollouts = []

  let loading = true
  let error = null

  // Upload form
  let uploadFile = null
  let uploadVersion = ''
  let uploadNotes = ''
  let uploadBoardType = ''
  let uploading = false

  // Deploy modal
  let showDeploy = false
  let deployFirmware = null
  let deployMode = 'single'
  let deployDeviceId = ''
  let selectedDevices = new Set()
  let deployBatchSize = 5
  let deployIntervalS = 300
  let deploying = false
  let deployError = null

  // OTA activity tab
  let activeTab = 'jobs'
  $: activityTabs = [
    { id: 'jobs', label: $t('firmware.jobs') },
    { id: 'rollouts', label: $t('firmware.rollouts') },
  ]
  let refreshTimer = null

  // ── Load data ──────────────────────────────────────────

  async function loadAll() {
    loading = true
    error = null
    try {
      const [fw, dev, j, r] = await Promise.all([
        getFirmwares().catch(() => []),
        getDevices().catch(() => []),
        getOtaJobs().catch(() => []),
        getRollouts().catch(() => []),
      ])
      firmwares = fw || []
      devices = (dev || []).filter(d => d.status === 'active' || d.online)
      jobs = j || []
      rollouts = r || []
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function refreshActivity() {
    try {
      const [j, r] = await Promise.all([
        getOtaJobs().catch(() => []),
        getRollouts().catch(() => []),
      ])
      jobs = j || []
      rollouts = r || []
    } catch { /* silent */ }
  }

  function startAutoRefresh() {
    stopAutoRefresh()
    refreshTimer = setInterval(refreshActivity, 10000)
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  }

  // ── Upload ─────────────────────────────────────────────

  function handleFileSelect(e) {
    uploadFile = e.target.files[0] || null
  }

  async function handleUpload() {
    if (!uploadFile || !uploadVersion.trim()) return
    uploading = true
    try {
      await uploadFirmware(uploadFile, uploadVersion.trim(), uploadNotes.trim(), uploadBoardType || null)
      toast.success($t('firmware.firmware_uploaded', uploadVersion.trim()))
      uploadFile = null
      uploadVersion = ''
      uploadNotes = ''
      uploadBoardType = ''
      const fileInput = document.querySelector('.upload-section input[type="file"]')
      if (fileInput) fileInput.value = ''
      await loadAll()
    } catch (e) {
      toast.error(e.message)
    } finally {
      uploading = false
    }
  }

  // ── Delete ─────────────────────────────────────────────

  async function handleDelete(fw) {
    if (!confirm($t('firmware.delete_confirm', fw.version))) return
    try {
      await deleteFirmware(fw.id)
      toast.success($t('firmware.firmware_deleted', fw.version))
      await loadAll()
    } catch (e) {
      toast.error(e.message)
    }
  }

  // ── Deploy ─────────────────────────────────────────────

  function openDeploy(fw) {
    deployFirmware = fw
    deployMode = 'single'
    // Pre-select first compatible device
    const compat = devices.filter(d => isDeviceCompatible(d, fw))
    deployDeviceId = compat.length > 0 ? compat[0].mqtt_device_id : ''
    selectedDevices = new Set()
    deployBatchSize = 5
    deployIntervalS = 300
    deploying = false
    deployError = null
    showDeploy = true
  }

  function closeDeploy() {
    showDeploy = false
    deployFirmware = null
  }

  function handleBackdropKey(e) {
    if (e.key === 'Escape') closeDeploy()
  }

  function toggleDevice(devId) {
    if (selectedDevices.has(devId)) {
      selectedDevices.delete(devId)
    } else {
      selectedDevices.add(devId)
    }
    selectedDevices = selectedDevices
  }

  async function handleDeploy() {
    if (!deployFirmware) return
    deploying = true
    deployError = null
    try {
      if (deployMode === 'single') {
        if (!deployDeviceId) { deployError = $t('firmware.select_device_error'); deploying = false; return }
        await deployOta(deployFirmware.id, deployDeviceId)
        toast.success($t('firmware.ota_deployed', deployDeviceId))
      } else {
        const ids = [...selectedDevices]
        if (ids.length === 0) { deployError = $t('firmware.select_devices_error'); deploying = false; return }
        await createRollout({
          firmwareId: deployFirmware.id,
          deviceIds: ids,
          batchSize: deployBatchSize,
          batchIntervalS: deployIntervalS,
        })
        toast.success($t('firmware.rollout_started', ids.length))
      }
      closeDeploy()
      await refreshActivity()
      startAutoRefresh()
    } catch (e) {
      deployError = e.message
    } finally {
      deploying = false
    }
  }

  // ── Rollout actions ────────────────────────────────────

  async function handlePause(id) {
    try { await pauseRollout(id); toast.info($t('firmware.rollout_paused')); await refreshActivity() }
    catch (e) { toast.error(e.message) }
  }

  async function handleResume(id) {
    try { await resumeRollout(id); toast.success($t('firmware.rollout_resumed')); await refreshActivity(); startAutoRefresh() }
    catch (e) { toast.error(e.message) }
  }

  async function handleCancel(id) {
    if (!confirm($t('firmware.cancel_confirm'))) return
    try { await cancelRollout(id); toast.info($t('firmware.rollout_cancelled')); await refreshActivity() }
    catch (e) { toast.error(e.message) }
  }

  // ── Helpers ────────────────────────────────────────────

  function shortChecksum(cs) {
    if (!cs) return ''
    return cs.length > 16 ? cs.slice(0, 16) + '…' : cs
  }

  function jobStatusVariant(status) {
    if (status === 'succeeded' || status === 'completed') return 'success'
    if (status === 'failed') return 'danger'
    if (status === 'sent' || status === 'running') return 'info'
    if (status === 'paused') return 'warning'
    if (status === 'cancelled') return 'neutral'
    return 'neutral'
  }

  // Unique board types from devices (for upload form select)
  $: boardTypes = [...new Set(devices.map(d => d.model).filter(Boolean))].sort()

  // Board compatibility check for deploy modal
  function isDeviceCompatible(device, fw) {
    if (!fw?.board_type) return true  // universal firmware
    if (!device.model) return true     // device without model — allow with warning
    return device.model === fw.board_type
  }

  $: compatibleDevices = deployFirmware
    ? devices.filter(d => isDeviceCompatible(d, deployFirmware))
    : devices

  $: incompatibleCount = deployFirmware?.board_type
    ? devices.filter(d => d.model && d.model !== deployFirmware.board_type).length
    : 0

  $: hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'sent')
  $: if (hasActiveJobs && !refreshTimer) startAutoRefresh()
  $: if (!hasActiveJobs && refreshTimer) stopAutoRefresh()

  // ── Lifecycle ──────────────────────────────────────────

  onMount(() => { loadAll() })
  onDestroy(() => { stopAutoRefresh() })
</script>

<div class="firmware-page">
  <PageHeader title={$t('pages.firmware')} subtitle={$t('pages.firmware_sub')}>
    <Button variant="secondary" icon="refresh" on:click={loadAll}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="200px" />
    <Skeleton height="200px" />
  {:else}
    <!-- ── Upload Section ────────────────────────────── -->
    <section class="section-card upload-section">
      <div class="section-header">
        <Icon name="upload" size={16} />
        <span>{$t('firmware.upload_firmware')}</span>
      </div>
      <div class="upload-form">
        <div class="form-field">
          <label class="field-label" for="fw-file">{$t('firmware.file_bin')}</label>
          <input id="fw-file" type="file" accept=".bin" on:change={handleFileSelect} disabled={uploading} class="file-input" />
        </div>
        <div class="form-field">
          <label class="field-label" for="fw-version">{$t('common.version')}</label>
          <input id="fw-version" type="text" bind:value={uploadVersion} placeholder={$t('firmware.version_placeholder')} disabled={uploading} class="input" />
        </div>
        <div class="form-field">
          <label class="field-label" for="fw-notes">{$t('firmware.notes')}</label>
          <input id="fw-notes" type="text" bind:value={uploadNotes} placeholder={$t('firmware.notes_placeholder')} disabled={uploading} class="input" />
        </div>
        <div class="form-field">
          <label class="field-label" for="fw-board">{$t('firmware.board_type')}</label>
          <select id="fw-board" bind:value={uploadBoardType} disabled={uploading} class="input">
            <option value="">{$t('firmware.universal')}</option>
            {#each boardTypes as bt}
              <option value={bt}>{bt}</option>
            {/each}
          </select>
        </div>
        <div class="form-field form-action">
          <Button variant="primary" icon="upload" on:click={handleUpload} loading={uploading}
            disabled={!uploadFile || !uploadVersion.trim()}>{$t('common.upload')}</Button>
        </div>
      </div>
    </section>

    <!-- ── Firmware Library ──────────────────────────── -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="cpu" size={16} />
        <span>{$t('firmware.library')}</span>
        <Badge variant="neutral" size="sm">{firmwares.length}</Badge>
      </div>

      {#if firmwares.length === 0}
        <EmptyState icon="upload" title={$t('firmware.no_firmware')} message={$t('firmware.no_firmware_hint')} />
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{$t('firmware.col_version')}</th>
                <th>{$t('firmware.board_type')}</th>
                <th>{$t('firmware.col_size')}</th>
                <th>{$t('firmware.col_checksum')}</th>
                <th>{$t('firmware.col_notes')}</th>
                <th>{$t('firmware.col_uploaded')}</th>
                <th>{$t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {#each firmwares as fw}
                <tr>
                  <td class="fw-version">{fw.version}</td>
                  <td>
                    {#if fw.board_type}
                      <Badge variant="info" size="sm">{fw.board_type}</Badge>
                    {:else}
                      <span class="text-muted">{$t('firmware.universal')}</span>
                    {/if}
                  </td>
                  <td>{formatBytes(fw.size_bytes)}</td>
                  <td class="font-mono">{shortChecksum(fw.checksum)}</td>
                  <td class="notes-cell">{fw.notes || '—'}</td>
                  <td class="text-muted">{formatDate(fw.created_at)}</td>
                  <td class="actions">
                    <Button variant="primary" size="sm" on:click={() => openDeploy(fw)}>{$t('common.deploy')}</Button>
                    <Button variant="danger" size="sm" on:click={() => handleDelete(fw)} aria-label="Delete firmware {fw.version}">
                      <Icon name="trash" size={13} />
                    </Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- ── OTA Activity ──────────────────────────────── -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="activity" size={16} />
        <span>{$t('firmware.ota_activity')}</span>
        {#if hasActiveJobs}
          <Badge variant="info" size="sm" pulse>{$t('firmware.live')}</Badge>
        {/if}
      </div>

      <div class="activity-tabs">
        <Tabs tabs={activityTabs} bind:active={activeTab} />
      </div>

      {#if activeTab === 'jobs'}
        {#if jobs.length === 0}
          <div class="empty-pad"><EmptyState icon="zap" title={$t('firmware.no_jobs')} message={$t('firmware.no_jobs_hint')} /></div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{$t('common.device')}</th>
                  <th>{$t('common.version')}</th>
                  <th>{$t('common.status')}</th>
                  <th>{$t('firmware.col_queued')}</th>
                  <th>{$t('firmware.col_completed')}</th>
                  <th>{$t('common.error')}</th>
                </tr>
              </thead>
              <tbody>
                {#each jobs as job}
                  <tr>
                    <td class="font-mono">{job.device_id}</td>
                    <td>{job.firmware_version}</td>
                    <td><Badge variant={jobStatusVariant(job.status)} size="sm">{job.status}</Badge></td>
                    <td class="text-muted">{formatDate(job.queued_at)}</td>
                    <td class="text-muted">{formatDate(job.completed_at)}</td>
                    <td class="error-cell">{job.error || ''}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {:else}
        {#if rollouts.length === 0}
          <div class="empty-pad"><EmptyState icon="zap" title={$t('firmware.no_rollouts')} message={$t('firmware.no_rollouts_hint')} /></div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{$t('common.version')}</th>
                  <th>{$t('firmware.col_devices')}</th>
                  <th>{$t('firmware.col_ok')}</th>
                  <th>{$t('firmware.col_fail')}</th>
                  <th>{$t('firmware.col_queue')}</th>
                  <th>{$t('common.status')}</th>
                  <th>{$t('common.created')}</th>
                  <th>{$t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {#each rollouts as r}
                  <tr>
                    <td>{r.firmware_version}</td>
                    <td>{r.total_devices}</td>
                    <td class="count-ok">{r.succeeded || 0}</td>
                    <td class="count-fail">{r.failed || 0}</td>
                    <td>{r.queued || 0}</td>
                    <td><Badge variant={jobStatusVariant(r.status)} size="sm">{r.status}</Badge></td>
                    <td class="text-muted">{formatDate(r.created_at)}</td>
                    <td class="actions">
                      {#if r.status === 'running'}
                        <Button variant="secondary" size="sm" on:click={() => handlePause(r.id)}>{$t('common.pause')}</Button>
                      {:else if r.status === 'paused'}
                        <Button variant="primary" size="sm" on:click={() => handleResume(r.id)}>{$t('common.resume')}</Button>
                      {/if}
                      {#if r.status === 'running' || r.status === 'paused'}
                        <Button variant="danger" size="sm" on:click={() => handleCancel(r.id)}>{$t('common.cancel')}</Button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<!-- ── Deploy Modal ──────────────────────────────── -->
{#if showDeploy}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={closeDeploy} on:keydown={handleBackdropKey} role="dialog" aria-modal="true" aria-labelledby="deploy-modal-title" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3 id="deploy-modal-title">{$t('firmware.deploy_title', deployFirmware?.version)}</h3>
        <button class="close-btn" on:click={closeDeploy} aria-label="Close dialog">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <div class="deploy-mode">
          <label class="mode-option">
            <input type="radio" bind:group={deployMode} value="single" />
            <span>{$t('firmware.single_device')}</span>
          </label>
          <label class="mode-option">
            <input type="radio" bind:group={deployMode} value="group" />
            <span>{$t('firmware.group_rollout')}</span>
          </label>
        </div>

        {#if deployFirmware?.board_type}
          <div class="board-info">
            <Icon name="cpu" size={14} />
            <span>{$t('firmware.board_type')}: <strong>{deployFirmware.board_type}</strong></span>
            {#if incompatibleCount > 0}
              <Badge variant="warning" size="sm">{compatibleDevices.length} / {devices.length} {$t('firmware.compatible')}</Badge>
            {/if}
          </div>
        {:else}
          <div class="board-info board-universal">
            <Icon name="info" size={14} />
            <span>{$t('firmware.universal_hint')}</span>
          </div>
        {/if}

        {#if deployMode === 'single'}
          <div class="field">
            <label class="field-label" for="deploy-device">{$t('common.device')}</label>
            <select id="deploy-device" bind:value={deployDeviceId} class="input">
              {#each compatibleDevices as d}
                <option value={d.mqtt_device_id}>{d.name || d.mqtt_device_id} ({d.mqtt_device_id})</option>
              {/each}
            </select>
          </div>
        {:else}
          <div class="device-checklist">
            <span class="field-label" id="device-select-label">{$t('firmware.select_devices')}</span>
            <div class="checklist-inner" role="group" aria-labelledby="device-select-label">
              {#each devices as d}
                {@const compatible = isDeviceCompatible(d, deployFirmware)}
                <label class="device-check" class:incompatible={!compatible}>
                  <input type="checkbox" checked={selectedDevices.has(d.mqtt_device_id)}
                    on:change={() => toggleDevice(d.mqtt_device_id)}
                    disabled={!compatible} />
                  <span>{d.name || d.mqtt_device_id}</span>
                  <span class="font-mono text-muted">({d.mqtt_device_id})</span>
                  {#if d.firmware_version}
                    <Badge variant="neutral" size="sm">v{d.firmware_version}</Badge>
                  {/if}
                  {#if d.model && !compatible}
                    <Badge variant="danger" size="sm">{d.model}</Badge>
                  {/if}
                </label>
              {/each}
            </div>
          </div>
          <div class="rollout-opts">
            <div class="field">
              <label class="field-label" for="batch-size">{$t('firmware.batch_size')}</label>
              <input id="batch-size" type="number" bind:value={deployBatchSize} min="1" max="50" class="input input-sm" />
            </div>
            <div class="field">
              <label class="field-label" for="batch-interval">{$t('firmware.interval_sec')}</label>
              <input id="batch-interval" type="number" bind:value={deployIntervalS} min="30" max="3600" class="input input-sm" />
            </div>
          </div>
        {/if}

        {#if deployError}
          <div class="deploy-error" role="alert">
            <Icon name="alert-triangle" size={14} />
            {deployError}
          </div>
        {/if}
      </div>

      <div class="modal-actions">
        <Button variant="secondary" on:click={closeDeploy} disabled={deploying}>Cancel</Button>
        <Button variant="primary" on:click={handleDeploy} loading={deploying}>Deploy</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .firmware-page {
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

  .activity-tabs {
    padding: 0 var(--space-4);
  }

  .empty-pad {
    padding: var(--space-2);
  }

  /* Upload form */
  .upload-form {
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

  .input-sm {
    width: 100px;
  }

  .file-input {
    padding: var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  /* Tables */
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
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-default);
    color: var(--text-muted);
    font-weight: 600;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }

  td {
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-primary);
    vertical-align: middle;
  }

  .font-mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .text-muted { color: var(--text-muted); }
  .fw-version { font-weight: 600; }
  .notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
  .error-cell { color: var(--accent-red); font-size: var(--text-xs); max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .count-ok { color: var(--accent-green); font-weight: 600; }
  .count-fail { color: var(--accent-red); font-weight: 600; }
  .actions { display: flex; gap: var(--space-1); }

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
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
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

  .deploy-mode {
    display: flex;
    gap: var(--space-4);
  }

  .mode-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text-primary);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  select.input {
    cursor: pointer;
  }

  .device-checklist {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .checklist-inner {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    background: var(--bg-tertiary);
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    transition: background var(--transition-fast);
  }

  .device-check:hover {
    background: var(--bg-surface);
  }

  .rollout-opts {
    display: flex;
    gap: var(--space-3);
  }

  .board-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--accent-blue) 20%, transparent);
  }

  .board-info.board-universal {
    background: color-mix(in srgb, var(--accent-yellow) 8%, transparent);
    border-color: color-mix(in srgb, var(--accent-yellow) 20%, transparent);
    color: var(--text-muted);
  }

  .device-check.incompatible {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .deploy-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--accent-red);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    background: rgba(239, 68, 68, 0.08);
    border-radius: var(--radius-sm);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-muted);
  }

  @media (max-width: 640px) {
    .upload-form {
      flex-direction: column;
    }
  }
</style>
