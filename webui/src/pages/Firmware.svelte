<script>
  import { onMount, onDestroy } from 'svelte'
  import {
    getFirmwares, uploadFirmware, deleteFirmware, updateFirmware,
    getDevices, deployOta, createRollout,
    getOtaJobs, getRollouts,
    pauseRollout, resumeRollout, cancelRollout,
    getRollbackTarget, rollbackOta, getTenants, getFirmware,
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
  import { isAdmin, isSuperAdmin } from '../lib/stores.js'

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
  // Platform firmware (plan epic 2.8): superadmin only
  let uploadGlobal = false
  let uploadVisibility = 'all'
  let uploadTenantIds = new Set()
  let tenants = []

  // Publication of a platform firmware (superadmin)
  let visFw = null
  let visMode = 'all'
  let visTenantIds = new Set()
  let visSaving = false

  // Rollback (plan epic 2.8)
  let rbDeviceId = ''
  let rbTarget = null
  let rbLoading = false
  let rbBusy = false

  // Deploy modal
  let showDeploy = false
  let deployFirmware = null
  let deployMode = 'single'
  let deployDeviceId = ''
  let selectedDevices = new Set()
  let deployBatchSize = 5
  let deployIntervalS = 300
  let deployFailThreshold = 50
  let deploying = false
  let deployError = null
  // Pre-OTA checks (plan epic 2.8): what stopped the deploy, and whether an admin may override it
  let precheckReasons = []
  let precheckForceable = false
  let deployForce = false

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
      const [fw, dev, j, r, tn] = await Promise.all([
        getFirmwares().catch(() => []),
        getDevices().catch(() => []),
        getOtaJobs().catch(() => []),
        getRollouts().catch(() => []),
        $isSuperAdmin ? getTenants().catch(() => []) : Promise.resolve([]),
      ])
      firmwares = fw || []
      tenants = tn || []
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
      const opts = $isSuperAdmin && uploadGlobal
        ? { global: true, visibility: uploadVisibility, tenantIds: [...uploadTenantIds] }
        : {}
      await uploadFirmware(uploadFile, uploadVersion.trim(), uploadNotes.trim(), uploadBoardType || null, opts)
      toast.success($t('firmware.firmware_uploaded', uploadVersion.trim()))
      uploadFile = null
      uploadVersion = ''
      uploadNotes = ''
      uploadBoardType = ''
      uploadGlobal = false
      uploadVisibility = 'all'
      uploadTenantIds = new Set()
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
    deployFailThreshold = 50
    deploying = false
    deployError = null
    precheckReasons = []
    precheckForceable = false
    deployForce = false
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
        await deployOta(deployFirmware.id, deployDeviceId, $isAdmin && deployForce)
        toast.success($t('firmware.ota_deployed', deployDeviceId))
      } else {
        const ids = [...selectedDevices]
        if (ids.length === 0) { deployError = $t('firmware.select_devices_error'); deploying = false; return }
        await createRollout({
          firmwareId: deployFirmware.id,
          deviceIds: ids,
          batchSize: deployBatchSize,
          batchIntervalS: deployIntervalS,
          failThresholdPct: deployFailThreshold,
        })
        toast.success($t('firmware.rollout_started', ids.length))
      }
      closeDeploy()
      await refreshActivity()
      startAutoRefresh()
    } catch (e) {
      if (e.body && e.body.error === 'precheck_failed') {
        // The device is not ready: name the reasons; an admin may force the soft ones
        precheckReasons = e.body.reasons || []
        precheckForceable = !!e.body.forceable && $isAdmin
        deployError = null
      } else {
        deployError = e.message
      }
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

  const reasonText = (r) => $t('firmware.precheck_' + r)
  const canDelete = (fw) => (fw.global ? $isSuperAdmin : $isAdmin)
  const sourceText = (fw) => (fw.global ? $t('firmware.source_platform') : $t('firmware.source_own'))

  function toggleSet(set, id) {
    const next = new Set(set)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }

  // ── Rollback ───────────────────────────────────────────

  $: if (rbDeviceId) loadRollback(rbDeviceId)
  async function loadRollback(id) {
    rbLoading = true
    rbTarget = null
    try { rbTarget = await getRollbackTarget(id) }
    catch (e) { toast.error(e.message) }
    finally { rbLoading = false }
  }

  async function handleRollback() {
    if (!rbTarget || !rbTarget.available) return
    if (!confirm($t('firmware.rollback_confirm', rbDeviceId, rbTarget.previous_version))) return
    rbBusy = true
    try {
      const res = await rollbackOta(rbDeviceId, false)
      toast.success($t('firmware.rollback_started', rbDeviceId, res.firmware_version))
      await refreshActivity()
      startAutoRefresh()
      await loadRollback(rbDeviceId)
    } catch (e) {
      if (e.body && e.body.error === 'precheck_failed' && e.body.forceable && $isAdmin) {
        const reasons = (e.body.reasons || []).map(reasonText).join(', ')
        if (confirm(`${$t('firmware.precheck_title')}: ${reasons}. ${$t('firmware.force_label')}?`)) {
          try {
            const res = await rollbackOta(rbDeviceId, true)
            toast.success($t('firmware.rollback_started', rbDeviceId, res.firmware_version))
            await refreshActivity()
            startAutoRefresh()
          } catch (e2) { toast.error(e2.message) }
        }
      } else {
        toast.error(e.body && e.body.reasons ? `${$t('firmware.precheck_title')}: ${e.body.reasons.map(reasonText).join(', ')}` : e.message)
      }
    } finally {
      rbBusy = false
    }
  }

  // ── Publication of a platform firmware (superadmin) ─────

  function openVisibility(fw) {
    visFw = fw
    visMode = fw.visibility || 'all'
    visTenantIds = new Set((fw.visible_to || []).map(v => v.tenant_id))
    // the list carries only the count; the detail names the organisations
    if (!fw.visible_to) {
      getFirmware(fw.id).then(full => {
        if (visFw && visFw.id === fw.id && full && full.visible_to) visTenantIds = new Set(full.visible_to.map(v => v.tenant_id))
      }).catch(() => {})
    }
  }

  async function saveVisibility() {
    if (!visFw) return
    visSaving = true
    try {
      await updateFirmware(visFw.id, { visibility: visMode, tenant_ids: visMode === 'selected' ? [...visTenantIds] : [] })
      toast.success($t('firmware.visibility_saved'))
      visFw = null
      await loadAll()
    } catch (e) {
      toast.error(e.message)
    } finally {
      visSaving = false
    }
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
    <!-- ── Upload Section (admin only) ──────────────── -->
    {#if $isAdmin}
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
      {#if $isSuperAdmin}
        <div class="platform-opts">
          <label class="check"><input type="checkbox" bind:checked={uploadGlobal} disabled={uploading} /> {$t('firmware.global_upload')}</label>
          {#if uploadGlobal}
            <label class="check">
              <span>{$t('firmware.visibility')}</span>
              <select class="input" bind:value={uploadVisibility} disabled={uploading}>
                <option value="all">{$t('firmware.visibility_all')}</option>
                <option value="selected">{$t('firmware.visibility_selected')}</option>
              </select>
            </label>
            {#if uploadVisibility === 'selected'}
              <div class="tenant-picker">
                <span class="field-label">{$t('firmware.visibility_pick')}</span>
                <div class="checklist-inner">
                  {#each tenants as tn (tn.id)}
                    <label class="device-check"><input type="checkbox" checked={uploadTenantIds.has(tn.id)} on:change={() => (uploadTenantIds = toggleSet(uploadTenantIds, tn.id))} /> <span>{tn.name}</span> <span class="font-mono text-muted">({tn.slug})</span></label>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </section>
    {/if}

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
                <th>{$t('firmware.source')}</th>
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
                  <td class="fw-version">{fw.version}{#if fw.active_job_count > 0} <Badge variant="info" size="sm">{$t('firmware.in_use')}</Badge>{/if}</td>
                  <td>
                    <Badge variant={fw.global ? 'info' : 'neutral'} size="sm">{sourceText(fw)}</Badge>
                    {#if fw.global && $isSuperAdmin}
                      <small class="text-muted">{fw.visibility === 'selected' ? $t('firmware.visible_to_count', fw.visible_to_count) : $t('firmware.visibility_all').toLowerCase()}</small>
                    {/if}
                  </td>
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
                    {#if fw.global && $isSuperAdmin}
                      <Button variant="secondary" size="sm" on:click={() => openVisibility(fw)}>{$t('firmware.manage_visibility')}</Button>
                    {/if}
                    {#if canDelete(fw)}
                      <Button variant="danger" size="sm" on:click={() => handleDelete(fw)} aria-label="Delete firmware {fw.version}">
                        <Icon name="trash" size={13} />
                      </Button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- ── Rollback (plan epic 2.8) ───────────────────── -->
    <section class="section-card">
      <div class="section-header">
        <Icon name="clock" size={16} />
        <span>{$t('firmware.rollback_title')}</span>
      </div>
      <div class="rollback-form">
        <p class="hint">{$t('firmware.rollback_intro')}</p>
        <div class="rollback-row">
          <div class="form-field">
            <label class="field-label" for="rb-device">{$t('firmware.rollback_device')}</label>
            <select id="rb-device" class="input" bind:value={rbDeviceId}>
              <option value="">—</option>
              {#each devices as d (d.mqtt_device_id)}
                <option value={d.mqtt_device_id}>{d.name || d.mqtt_device_id} ({d.mqtt_device_id}){d.firmware_version ? ` · v${d.firmware_version}` : ''}</option>
              {/each}
            </select>
          </div>
          {#if rbDeviceId}
            <div class="rollback-info">
              {#if rbLoading}
                <span class="text-muted">…</span>
              {:else if rbTarget}
                <span>{$t('firmware.rollback_current')}: <strong>{rbTarget.current_version || '—'}</strong></span>
                <span>{$t('firmware.rollback_previous')}: <strong>{rbTarget.previous_version || '—'}</strong></span>
                {#if !rbTarget.previous_version}
                  <span class="text-muted">{$t('firmware.rollback_none')}</span>
                {:else if rbTarget.previous_version === rbTarget.current_version}
                  <span class="text-muted">{$t('firmware.rollback_same')}</span>
                {:else if !rbTarget.firmware}
                  <span class="warn">{$t('firmware.rollback_missing', rbTarget.previous_version)}</span>
                {:else}
                  <Button variant="secondary" size="sm" on:click={handleRollback} loading={rbBusy}>{$t('firmware.rollback_button', rbTarget.previous_version)}</Button>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      </div>
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
                  <th>{$t('firmware.col_actor')}</th>
                  <th>{$t('firmware.col_queued')}</th>
                  <th>{$t('firmware.col_completed')}</th>
                  <th>{$t('common.error')}</th>
                </tr>
              </thead>
              <tbody>
                {#each jobs as job}
                  <tr>
                    <td class="font-mono">{job.device_id}</td>
                    <td>
                      {job.firmware_version}
                      {#if job.kind === 'rollback'}<Badge variant="warning" size="sm">{$t('firmware.kind_rollback')}</Badge>{/if}
                      {#if job.forced}<Badge variant="neutral" size="sm">{$t('firmware.forced')}</Badge>{/if}
                      {#if job.firmware_deleted}<small class="text-muted">{$t('firmware.firmware_deleted')}</small>{/if}
                    </td>
                    <td>
                      <Badge variant={jobStatusVariant(job.status)} size="sm">{job.status}</Badge>
                      {#if job.status === 'queued' && job.deferrals > 0}
                        <small class="text-muted" title={job.defer_reason}>{$t('firmware.deferred', job.deferrals)}{job.defer_reason ? ': ' + job.defer_reason.split(',').map(reasonText).join(', ') : ''}</small>
                      {/if}
                    </td>
                    <td class="text-muted small-cell">{job.actor || '—'}</td>
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
                    <td>
                      <Badge variant={jobStatusVariant(r.status)} size="sm">{r.status}</Badge>
                      {#if r.status === 'paused' && r.paused_reason}<small class="text-muted">{$t('firmware.paused_' + r.paused_reason)}</small>{/if}
                      {#if r.deferred > 0}<small class="text-muted">{$t('firmware.deferred', r.deferred)}</small>{/if}
                    </td>
                    <td class="text-muted" title={r.created_by_email || ''}>{formatDate(r.created_at)}</td>
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
          {#if $isAdmin}
            <label class="mode-option">
              <input type="radio" bind:group={deployMode} value="group" />
              <span>{$t('firmware.group_rollout')}</span>
            </label>
          {/if}
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
            <div class="field">
              <label class="field-label" for="fail-threshold">{$t('firmware.fail_threshold')}</label>
              <input id="fail-threshold" type="number" bind:value={deployFailThreshold} min="1" max="100" class="input input-sm" />
            </div>
          </div>
        {/if}

        {#if precheckReasons.length > 0}
          <div class="precheck" role="alert">
            <div class="precheck-title"><Icon name="alert-triangle" size={14} /> {$t('firmware.precheck_title')}</div>
            <ul>{#each precheckReasons as r}<li>{reasonText(r)}</li>{/each}</ul>
            {#if precheckForceable}
              <label class="check"><input type="checkbox" bind:checked={deployForce} /> {$t('firmware.force_label')}</label>
            {/if}
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
        <Button variant="secondary" on:click={closeDeploy} disabled={deploying}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={handleDeploy} loading={deploying}>{$t('common.deploy')}</Button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Visibility modal (superadmin, platform firmware) ── -->
{#if visFw}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" on:click={() => (visFw = null)} on:keydown={(e) => e.key === 'Escape' && (visFw = null)} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="document" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-header">
        <h3>{$t('firmware.visibility')}: {visFw.version}</h3>
        <button class="close-btn" on:click={() => (visFw = null)} aria-label="Close dialog"><Icon name="x" size={18} /></button>
      </div>
      <div class="modal-body">
        <div class="deploy-mode">
          <label class="mode-option"><input type="radio" bind:group={visMode} value="all" /><span>{$t('firmware.visibility_all')}</span></label>
          <label class="mode-option"><input type="radio" bind:group={visMode} value="selected" /><span>{$t('firmware.visibility_selected')}</span></label>
        </div>
        {#if visMode === 'selected'}
          <div class="device-checklist">
            <span class="field-label">{$t('firmware.visibility_pick')}</span>
            <div class="checklist-inner">
              {#each tenants as tn (tn.id)}
                <label class="device-check"><input type="checkbox" checked={visTenantIds.has(tn.id)} on:change={() => (visTenantIds = toggleSet(visTenantIds, tn.id))} /> <span>{tn.name}</span> <span class="font-mono text-muted">({tn.slug})</span></label>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <div class="modal-actions">
        <Button variant="secondary" on:click={() => (visFw = null)} disabled={visSaving}>{$t('common.cancel')}</Button>
        <Button variant="primary" on:click={saveVisibility} loading={visSaving}>{$t('common.save')}</Button>
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

  .platform-opts {
    display: flex; flex-direction: column; gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }
  .check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--text-primary); cursor: pointer; }
  .tenant-picker { display: flex; flex-direction: column; gap: var(--space-1); max-width: 480px; }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--text-muted); line-height: 1.5; }
  .rollback-form { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
  .rollback-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-4); }
  .rollback-info { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); padding-bottom: 4px; }
  .rollback-info strong { color: var(--text-primary); }
  .warn { color: var(--accent-yellow, #f59e0b); }
  .small-cell { font-size: var(--text-xs); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td small { display: block; font-size: var(--text-xs); }
  .precheck {
    display: flex; flex-direction: column; gap: var(--space-2);
    color: var(--text-primary); font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--accent-yellow, #f59e0b) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-yellow, #f59e0b) 35%, transparent);
    border-radius: var(--radius-sm);
  }
  .precheck-title { display: flex; align-items: center; gap: var(--space-2); font-weight: 600; }
  .precheck ul { margin: 0; padding-left: var(--space-5); color: var(--text-secondary); }

  @media (max-width: 640px) {
    .upload-form {
      flex-direction: column;
    }
  }
</style>
