<script>
  import { onMount, onDestroy } from 'svelte'
  import {
    getFirmwares, uploadFirmware, deleteFirmware,
    getDevices, deployOta, createRollout,
    getOtaJobs, getRollouts,
    pauseRollout, resumeRollout, cancelRollout,
  } from '../lib/api.js'
  import { formatBytes, formatDate } from '../lib/format.js'
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
  const activityTabs = [
    { id: 'jobs', label: 'Jobs' },
    { id: 'rollouts', label: 'Rollouts' },
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
      await uploadFirmware(uploadFile, uploadVersion.trim(), uploadNotes.trim())
      toast.success(`Firmware ${uploadVersion.trim()} uploaded`)
      uploadFile = null
      uploadVersion = ''
      uploadNotes = ''
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
    if (!confirm(`Delete firmware ${fw.version}?`)) return
    try {
      await deleteFirmware(fw.id)
      toast.success(`Firmware ${fw.version} deleted`)
      await loadAll()
    } catch (e) {
      toast.error(e.message)
    }
  }

  // ── Deploy ─────────────────────────────────────────────

  function openDeploy(fw) {
    deployFirmware = fw
    deployMode = 'single'
    deployDeviceId = devices.length > 0 ? devices[0].mqtt_device_id : ''
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
        if (!deployDeviceId) { deployError = 'Select a device'; deploying = false; return }
        await deployOta(deployFirmware.id, deployDeviceId)
        toast.success(`OTA deployed to ${deployDeviceId}`)
      } else {
        const ids = [...selectedDevices]
        if (ids.length === 0) { deployError = 'Select at least one device'; deploying = false; return }
        await createRollout({
          firmwareId: deployFirmware.id,
          deviceIds: ids,
          batchSize: deployBatchSize,
          batchIntervalS: deployIntervalS,
        })
        toast.success(`Rollout started for ${ids.length} devices`)
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
    try { await pauseRollout(id); toast.info('Rollout paused'); await refreshActivity() }
    catch (e) { toast.error(e.message) }
  }

  async function handleResume(id) {
    try { await resumeRollout(id); toast.success('Rollout resumed'); await refreshActivity(); startAutoRefresh() }
    catch (e) { toast.error(e.message) }
  }

  async function handleCancel(id) {
    if (!confirm('Cancel this rollout?')) return
    try { await cancelRollout(id); toast.info('Rollout cancelled'); await refreshActivity() }
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

  $: hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'sent')
  $: if (hasActiveJobs && !refreshTimer) startAutoRefresh()
  $: if (!hasActiveJobs && refreshTimer) stopAutoRefresh()

  // ── Lifecycle ──────────────────────────────────────────

  onMount(() => { loadAll() })
  onDestroy(() => { stopAutoRefresh() })
</script>

<div class="firmware-page">
  <PageHeader title="Firmware" subtitle="Upload, manage and deploy OTA firmware updates">
    <Button variant="secondary" icon="refresh" on:click={loadAll}>Refresh</Button>
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
        <span>Upload Firmware</span>
      </div>
      <div class="upload-form">
        <div class="form-field">
          <label class="field-label">File (.bin)</label>
          <input type="file" accept=".bin" on:change={handleFileSelect} disabled={uploading} class="file-input" />
        </div>
        <div class="form-field">
          <label class="field-label">Version</label>
          <input type="text" bind:value={uploadVersion} placeholder="e.g. 1.2.3" disabled={uploading} class="input" />
        </div>
        <div class="form-field flex-grow">
          <label class="field-label">Notes</label>
          <input type="text" bind:value={uploadNotes} placeholder="Release notes (optional)" disabled={uploading} class="input" />
        </div>
        <div class="form-field form-action">
          <Button variant="primary" icon="upload" on:click={handleUpload} loading={uploading}
            disabled={!uploadFile || !uploadVersion.trim()}>Upload</Button>
        </div>
      </div>
    </section>

    <!-- ── Firmware Library ──────────────────────────── -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="cpu" size={16} />
        <span>Firmware Library</span>
        <Badge variant="neutral" size="sm">{firmwares.length}</Badge>
      </div>

      {#if firmwares.length === 0}
        <EmptyState icon="upload" title="No firmware uploaded" message="Upload a .bin file to get started" />
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Size</th>
                <th>Checksum</th>
                <th>Notes</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each firmwares as fw}
                <tr>
                  <td class="fw-version">{fw.version}</td>
                  <td>{formatBytes(fw.size_bytes)}</td>
                  <td class="font-mono">{shortChecksum(fw.checksum)}</td>
                  <td class="notes-cell">{fw.notes || '—'}</td>
                  <td class="text-muted">{formatDate(fw.created_at)}</td>
                  <td class="actions">
                    <Button variant="primary" size="sm" on:click={() => openDeploy(fw)}>Deploy</Button>
                    <Button variant="danger" size="sm" on:click={() => handleDelete(fw)}>
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
        <span>OTA Activity</span>
        {#if hasActiveJobs}
          <Badge variant="info" size="sm" pulse>Live</Badge>
        {/if}
      </div>

      <div class="activity-tabs">
        <Tabs tabs={activityTabs} bind:active={activeTab} />
      </div>

      {#if activeTab === 'jobs'}
        {#if jobs.length === 0}
          <div class="empty-pad"><EmptyState icon="zap" title="No OTA jobs" message="Deploy firmware to a device to create a job" /></div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Queued</th>
                  <th>Completed</th>
                  <th>Error</th>
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
          <div class="empty-pad"><EmptyState icon="zap" title="No rollouts" message="Use group deploy to start a rollout" /></div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Devices</th>
                  <th>OK</th>
                  <th>Fail</th>
                  <th>Queue</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
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
                        <Button variant="secondary" size="sm" on:click={() => handlePause(r.id)}>Pause</Button>
                      {:else if r.status === 'paused'}
                        <Button variant="primary" size="sm" on:click={() => handleResume(r.id)}>Resume</Button>
                      {/if}
                      {#if r.status === 'running' || r.status === 'paused'}
                        <Button variant="danger" size="sm" on:click={() => handleCancel(r.id)}>Cancel</Button>
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
  <div class="modal-backdrop" role="presentation" on:click={closeDeploy} on:keydown={() => {}}>
    <div class="modal" role="dialog" on:click|stopPropagation on:keydown={() => {}}>
      <div class="modal-header">
        <h3>Deploy {deployFirmware?.version}</h3>
        <button class="close-btn" on:click={closeDeploy}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <div class="deploy-mode">
          <label class="mode-option">
            <input type="radio" bind:group={deployMode} value="single" />
            <span>Single Device</span>
          </label>
          <label class="mode-option">
            <input type="radio" bind:group={deployMode} value="group" />
            <span>Group Rollout</span>
          </label>
        </div>

        {#if deployMode === 'single'}
          <div class="field">
            <label class="field-label">Device</label>
            <select bind:value={deployDeviceId} class="input">
              {#each devices as d}
                <option value={d.mqtt_device_id}>{d.name || d.mqtt_device_id} ({d.mqtt_device_id})</option>
              {/each}
            </select>
          </div>
        {:else}
          <div class="device-checklist">
            <label class="field-label">Select devices</label>
            <div class="checklist-inner">
              {#each devices as d}
                <label class="device-check">
                  <input type="checkbox" checked={selectedDevices.has(d.mqtt_device_id)}
                    on:change={() => toggleDevice(d.mqtt_device_id)} />
                  <span>{d.name || d.mqtt_device_id}</span>
                  <span class="font-mono text-muted">({d.mqtt_device_id})</span>
                  {#if d.firmware_version}
                    <Badge variant="neutral" size="sm">v{d.firmware_version}</Badge>
                  {/if}
                </label>
              {/each}
            </div>
          </div>
          <div class="rollout-opts">
            <div class="field">
              <label class="field-label">Batch size</label>
              <input type="number" bind:value={deployBatchSize} min="1" max="50" class="input input-sm" />
            </div>
            <div class="field">
              <label class="field-label">Interval (sec)</label>
              <input type="number" bind:value={deployIntervalS} min="30" max="3600" class="input input-sm" />
            </div>
          </div>
        {/if}

        {#if deployError}
          <div class="deploy-error">
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

  .form-field.flex-grow {
    flex: 1;
    min-width: 150px;
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

    .form-field.flex-grow {
      min-width: auto;
    }
  }
</style>
