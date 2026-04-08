<script>
  import { onMount, onDestroy } from 'svelte'
  import { getDevice, updateDevice, deleteDevice, resetDeviceToPending, getServiceRecords, createServiceRecord, deleteServiceRecord, generateMqttCredentials, revokeMqttCredentials, getTenants, reassignDevice } from '../lib/api.js'
  import { subscribe, unsubscribe, on } from '../lib/ws.js'
  import { navigate, liveState, canWrite, isAdmin, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import StatusDot from '../components/ui/StatusDot.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Tabs from '../components/ui/Tabs.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'
  import DeviceVitals from '../components/device/DeviceVitals.svelte'
  import ParameterEditor from '../components/device/ParameterEditor.svelte'
  import TelemetryChart from '../components/TelemetryChart.svelte'
  import AlarmHistory from '../components/AlarmHistory.svelte'

  import EnergyTab from '../components/device/EnergyTab.svelte'

  // svelte-spa-router passes route params via `params` prop
  export let params = {}
  export let deviceId = undefined
  $: resolvedId = deviceId || params.id

  let device = null
  let loading = true
  let error = null
  let unsubs = []

  let activeTab = 'chart'
  $: tabs = [
    { id: 'chart',   label: $t('device.tab_chart') },
    { id: 'energy',  label: $t('device.tab_energy') },
    { id: 'params',  label: $t('device.tab_params') },
    { id: 'alarms',  label: $t('device.tab_alarms') },
    { id: 'service', label: $t('device.tab_service') },
  ]

  // ── Edit modal state ──
  let showEdit = false
  let editForm = { name: '', location: '', serial_number: '', model: '', comment: '', manufactured_at: '',
    model_id: null, compressor_kw: '', evap_fan_kw: '', cond_fan_kw: '', defrost_heater_kw: '', standby_kw: '' }
  let saving = false
  let deviceModels = []

  let showNewModel = false
  let newModel = { name: '', compressor_kw: '', defrost_heater_kw: '', evap_fan_w: '', cond_fan_w: '', standby_w: '' }
  let creatingModel = false

  async function loadDeviceModels() {
    try {
      const { getDeviceModels } = await import('../lib/api.js')
      deviceModels = await getDeviceModels() || []
    } catch { deviceModels = [] }
  }

  function openNewModel() {
    newModel = { name: '', compressor_kw: '', defrost_heater_kw: '', evap_fan_w: '', cond_fan_w: '', standby_w: '' }
    showNewModel = true
  }

  async function createModel() {
    if (!newModel.name.trim()) return
    creatingModel = true
    try {
      const { createDeviceModel } = await import('../lib/api.js')
      const created = await createDeviceModel({
        name: newModel.name.trim(),
        compressor_kw: newModel.compressor_kw ? Number(newModel.compressor_kw) : null,
        defrost_heater_kw: newModel.defrost_heater_kw ? Number(newModel.defrost_heater_kw) : null,
        evap_fan_kw: newModel.evap_fan_w ? Number(newModel.evap_fan_w) / 1000 : null,
        cond_fan_kw: newModel.cond_fan_w ? Number(newModel.cond_fan_w) / 1000 : null,
        standby_kw: newModel.standby_w ? Number(newModel.standby_w) / 1000 : null,
      })
      await loadDeviceModels()
      editForm.model_id = created.id
      showNewModel = false
      toast.success($t('energy.model_created'))
    } catch (e) {
      toast.error(e.message)
    }
    creatingModel = false
  }

  function openEdit() {
    editForm = {
      name: device.name || '',
      location: device.location || '',
      serial_number: device.serial_number || '',
      model: device.model || '',
      comment: device.comment || '',
      manufactured_at: device.manufactured_at ? device.manufactured_at.slice(0, 10) : '',
      model_id: device.model_id || '',
      compressor_kw: device.compressor_kw ?? '',
      defrost_heater_kw: device.defrost_heater_kw ?? '',
      evap_fan_w: device.evap_fan_kw != null ? Math.round(device.evap_fan_kw * 1000) : '',
      cond_fan_w: device.cond_fan_kw != null ? Math.round(device.cond_fan_kw * 1000) : '',
      standby_w: device.standby_kw != null ? Math.round(device.standby_kw * 1000) : '',
    }
    loadDeviceModels()
    showEdit = true
  }

  function closeEdit() { showEdit = false }

  function handleEditKeydown(e) {
    if (e.key === 'Escape') closeEdit()
  }

  async function saveEdit() {
    saving = true
    try {
      const changes = {}
      if (editForm.name !== (device.name || '')) changes.name = editForm.name
      if (editForm.location !== (device.location || '')) changes.location = editForm.location
      if (editForm.serial_number !== (device.serial_number || '')) changes.serial_number = editForm.serial_number
      if (editForm.model !== (device.model || '')) changes.model = editForm.model
      if (editForm.comment !== (device.comment || '')) changes.comment = editForm.comment
      const currentMfg = device.manufactured_at ? device.manufactured_at.slice(0, 10) : ''
      if (editForm.manufactured_at !== currentMfg) changes.manufactured_at = editForm.manufactured_at || null

      // Power profile fields
      const modelId = editForm.model_id || null
      if (modelId !== (device.model_id || null)) changes.model_id = modelId
      // kW fields (compressor, defrost — already in kW)
      for (const f of ['compressor_kw', 'defrost_heater_kw']) {
        const val = editForm[f] === '' ? null : Number(editForm[f])
        const cur = device[f] ?? null
        if (val !== cur) changes[f] = val
      }
      // W→kW fields (fans, standby — UI shows W, DB stores kW)
      for (const [uiField, dbField] of [['evap_fan_w', 'evap_fan_kw'], ['cond_fan_w', 'cond_fan_kw'], ['standby_w', 'standby_kw']]) {
        const val = editForm[uiField] === '' ? null : Number(editForm[uiField]) / 1000
        const cur = device[dbField] ?? null
        if (val !== cur) changes[dbField] = val
      }

      if (Object.keys(changes).length === 0) {
        closeEdit()
        return
      }

      const updated = await updateDevice(resolvedId, changes)
      device = { ...device, ...updated }
      toast.success($t('device.edit_saved'))
      closeEdit()
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }

  // ── Service records state ──
  let serviceRecords = []
  let serviceLoading = false
  let serviceLoaded = false
  let showAddService = false
  let serviceForm = { service_date: '', technician: '', reason: '', work_done: '' }
  let serviceSaving = false

  async function loadServiceRecords() {
    serviceLoading = true
    try {
      serviceRecords = await getServiceRecords(resolvedId)
    } catch (e) {
      serviceRecords = []
    } finally {
      serviceLoading = false
      serviceLoaded = true
    }
  }

  function openAddService() {
    const today = new Date().toISOString().slice(0, 10)
    serviceForm = { service_date: today, technician: '', reason: '', work_done: '' }
    showAddService = true
  }

  function closeAddService() { showAddService = false }

  function handleServiceKeydown(e) {
    if (e.key === 'Escape') closeAddService()
  }

  async function saveServiceRecord() {
    serviceSaving = true
    try {
      const record = await createServiceRecord(resolvedId, serviceForm)
      serviceRecords = [record, ...serviceRecords]
      toast.success($t('device.service_added'))
      closeAddService()
    } catch (e) {
      toast.error(e.message)
    } finally {
      serviceSaving = false
    }
  }

  async function removeServiceRecord(recordId) {
    if (!confirm($t('device.delete_service_confirm'))) return
    try {
      await deleteServiceRecord(resolvedId, recordId)
      serviceRecords = serviceRecords.filter(r => r.id !== recordId)
      toast.success($t('device.service_deleted'))
    } catch (e) {
      toast.error(e.message)
    }
  }

  // Load service records when switching to service tab
  $: if (activeTab === 'service' && device && !serviceLoaded && !serviceLoading) {
    loadServiceRecords()
  }

  // ── MQTT Credentials ──
  let mqttCredsResult = null
  let mqttCredsBusy = false

  function closeMqttCreds() { mqttCredsResult = null }

  async function handleMqttGenerate() {
    if (!confirm($t(device.has_mqtt_credentials ? 'device.mqtt_rotate_confirm' : 'device.mqtt_rotate_confirm'))) return
    mqttCredsBusy = true
    try {
      const creds = await generateMqttCredentials(resolvedId)
      mqttCredsResult = creds
      device = { ...device, has_mqtt_credentials: true }
      toast.success($t(creds.rotated ? 'device.mqtt_rotated' : 'device.mqtt_generated'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      mqttCredsBusy = false
    }
  }

  async function handleMqttRevoke() {
    if (!confirm($t('device.mqtt_revoke_confirm'))) return
    mqttCredsBusy = true
    try {
      await revokeMqttCredentials(resolvedId)
      device = { ...device, has_mqtt_credentials: false }
      toast.success($t('device.mqtt_revoked'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      mqttCredsBusy = false
    }
  }

  async function copyMqttPassword() {
    if (mqttCredsResult?.password) {
      await navigator.clipboard.writeText(mqttCredsResult.password)
      toast.success('Copied')
    }
  }

  // ── Tenant reassignment (superadmin only) ──
  let showReassign = false
  let reassignTenants = []
  let selectedTenantId = ''
  let reassigning = false

  async function openReassign() {
    try {
      reassignTenants = await getTenants()
      // Filter out current tenant and system tenant
      reassignTenants = reassignTenants.filter(t =>
        t.id !== device.tenant_id &&
        t.id !== '00000000-0000-0000-0000-000000000000' &&
        t.active
      )
      selectedTenantId = reassignTenants.length > 0 ? reassignTenants[0].id : ''
      showReassign = true
    } catch (e) {
      toast.error(e.message)
    }
  }

  function closeReassign() {
    showReassign = false
    selectedTenantId = ''
  }

  async function handleReassign() {
    if (!selectedTenantId) return
    const tenant = reassignTenants.find(t => t.id === selectedTenantId)
    if (!confirm($t('device.reassign_confirm').replace('{0}', tenant?.name || selectedTenantId))) return

    reassigning = true
    try {
      const result = await reassignDevice(resolvedId, selectedTenantId)
      toast.success($t('device.reassigned').replace('{0}', result.new_tenant))
      closeReassign()
      // Reload device to reflect new tenant
      await loadDevice()
    } catch (e) {
      toast.error(e.message)
    } finally {
      reassigning = false
    }
  }

  // ── Delete device ──
  let showDeleteConfirm = false
  let deleting = false

  function openDeleteConfirm() { showDeleteConfirm = true }
  function closeDeleteConfirm() { showDeleteConfirm = false }

  async function confirmDeleteDevice() {
    deleting = true
    try {
      await deleteDevice(resolvedId)
      toast.success($t('device.device_deleted').replace('{0}', device.mqtt_device_id))
      navigate('/')
    } catch (e) {
      toast.error(e.message)
    } finally {
      deleting = false
      showDeleteConfirm = false
    }
  }

  // ── Reset to pending ──
  let resettingToPending = false
  let showMoreMenu = false

  async function handleResetToPending() {
    if (!confirm($t('device.reset_pending_confirm').replace('{0}', device.mqtt_device_id))) return
    resettingToPending = true
    try {
      await resetDeviceToPending(resolvedId)
      toast.success($t('device.reset_pending_done').replace('{0}', device.mqtt_device_id))
      navigate('/pending')
    } catch (e) {
      toast.error(e.message)
    } finally {
      resettingToPending = false
    }
  }

  // ── Data loading ──
  async function loadDevice() {
    try {
      device = await getDevice(resolvedId)
      liveState.set(device.last_state || {})
      error = null
      const name = device.name || device.mqtt_device_id
      document.title = `${name} — ModESP Cloud`
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function setupWs() {
    subscribe(resolvedId)
    unsubs.push(on('state_full', (msg) => {
      if (msg.device_id === resolvedId) liveState.update(s => ({ ...s, ...(msg.state || {}) }))
    }))
    unsubs.push(on('state_update', (msg) => {
      if (msg.device_id === resolvedId) liveState.update(s => ({ ...s, ...msg.changes }))
    }))
    unsubs.push(on('device_online', (msg) => {
      if (msg.device_id === resolvedId && device) device = { ...device, online: true }
    }))
    unsubs.push(on('device_offline', (msg) => {
      if (msg.device_id === resolvedId && device) device = { ...device, online: false }
    }))
  }

  onMount(() => { loadDevice(); setupWs() })
  onDestroy(() => { unsubscribe(resolvedId); for (const fn of unsubs) fn() })

  $: hasAlarm = !!$liveState['protection.alarm_active']

  function roleVariant(role) {
    if (role === 'admin') return 'danger'
    if (role === 'technician') return 'warning'
    return 'neutral'
  }
</script>

<div class="detail">
  <!-- Breadcrumb -->
  <div class="breadcrumb">
    <a href="#/" class="back-link">
      <Icon name="arrow-left" size={16} />
      {$t('device.back_dashboard')}
    </a>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current">{resolvedId}</span>
  </div>

  {#if loading}
    <Skeleton height="120px" />
    <Skeleton height="80px" />
    <Skeleton height="300px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('device.load_error')} message={error} />
  {:else if device}
    <!-- Device header -->
    <div class="device-header">
      <div class="header-top">
        <StatusDot status={hasAlarm ? 'alarm' : (device.online ? 'online' : 'offline')} />
        <h1 class="device-title">{device.name || device.mqtt_device_id}</h1>
        <Badge variant={device.online ? 'success' : 'neutral'}>
          {device.online ? $t('common.online') : $t('common.offline')}
        </Badge>
        {#if hasAlarm}
          <Badge variant="danger" pulse>{$t('device.alarm_badge')}</Badge>
        {/if}
        <div class="header-spacer"></div>
        {#if $canWrite}
          <div class="more-menu-wrap">
            <button class="settings-btn" on:click={() => showMoreMenu = !showMoreMenu} title={$t('device.settings')}>
              <Icon name="settings" size={18} />
            </button>
            {#if showMoreMenu}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <div class="more-menu-backdrop" on:click={() => showMoreMenu = false}></div>
              <div class="more-menu">
                <button class="more-menu-item" on:click={() => { showMoreMenu = false; openEdit(); }}>
                  <Icon name="edit" size={14} />
                  {$t('device.edit_device')}
                </button>
                {#if $isAdmin}
                  <button class="more-menu-item" on:click={() => { showMoreMenu = false; handleMqttGenerate(); }} disabled={mqttCredsBusy}>
                    <Icon name={device.has_mqtt_credentials ? 'refresh-cw' : 'key'} size={14} />
                    {device.has_mqtt_credentials ? $t('device.mqtt_rotate') : $t('device.mqtt_generate')}
                  </button>
                {/if}
                {#if $isSuperAdmin}
                  <button class="more-menu-item" on:click={() => { showMoreMenu = false; openReassign(); }}>
                    <Icon name="repeat" size={14} />
                    {$t('device.change_tenant')}
                  </button>
                {/if}
                <button class="more-menu-item" on:click={() => { showMoreMenu = false; handleResetToPending(); }}
                  disabled={resettingToPending || device.status === 'pending'}>
                  <Icon name="rotate-ccw" size={14} />
                  {$t('device.reset_pending')}
                </button>
                <div class="more-menu-divider"></div>
                <button class="more-menu-item more-menu-danger" on:click={() => { showMoreMenu = false; openDeleteConfirm(); }}>
                  <Icon name="trash-2" size={14} />
                  {$t('device.delete_device')}
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="header-meta">
        <span class="meta-item font-mono">
          <Icon name="hash" size={12} />
          {device.mqtt_device_id}
        </span>
        {#if device.model}
          <span class="meta-item">
            <Icon name="cpu" size={12} />
            {device.model}
          </span>
        {/if}
        {#if device.serial_number}
          <span class="meta-item font-mono">
            SN: {device.serial_number}
          </span>
        {/if}
        {#if device.firmware_version}
          <span class="meta-item font-mono">FW: {device.firmware_version}</span>
        {/if}
        {#if device.manufactured_at}
          <span class="meta-item">
            <Icon name="clock" size={12} />
            {device.manufactured_at.slice(0, 10)}
          </span>
        {/if}
        {#if device.location}
          <span class="meta-item">
            <Icon name="map-pin" size={12} />
            {device.location}
          </span>
        {/if}
      </div>

      {#if device.comment}
        <div class="header-comment">{device.comment}</div>
      {/if}
    </div>

    <!-- Vitals -->
    <DeviceVitals state={$liveState} />

    <!-- Tabs -->
    <Tabs {tabs} bind:active={activeTab} />

    <!-- Tab content -->
    <div class="tab-content">
      {#if activeTab === 'chart'}
        <TelemetryChart deviceId={resolvedId} />
      {:else if activeTab === 'params'}
        <ParameterEditor deviceId={resolvedId} state={$liveState} readonly={!$canWrite} />
      {:else if activeTab === 'alarms'}
        <AlarmHistory deviceId={resolvedId} />
      {:else if activeTab === 'service'}
        <div class="service-section">
          <div class="service-header">
            <h3>{$t('device.service_records')}</h3>
            {#if $canWrite}
              <button class="btn btn-sm btn-primary" on:click={openAddService}>
                <Icon name="plus" size={14} />
                {$t('device.add_service_record')}
              </button>
            {/if}
          </div>

          {#if serviceLoading}
            <Skeleton height="100px" />
          {:else if serviceRecords.length === 0}
            <EmptyState icon="clock" title={$t('device.no_service_records')} message={$t('device.no_service_records_hint')} />
          {:else}
            <div class="service-list">
              {#each serviceRecords as record (record.id)}
                <div class="service-card">
                  <div class="service-card-header">
                    <span class="service-date">
                      <Icon name="clock" size={14} />
                      {record.service_date}
                    </span>
                    <span class="service-technician">
                      <Icon name="user" size={14} />
                      {record.technician}
                    </span>
                    {#if $canWrite}
                      <button class="service-delete" on:click={() => removeServiceRecord(record.id)}
                        title={$t('common.delete')}>
                        <Icon name="trash" size={14} />
                      </button>
                    {/if}
                  </div>
                  <div class="service-card-body">
                    <div class="service-field">
                      <span class="service-label">{$t('device.reason')}:</span>
                      <span>{record.reason}</span>
                    </div>
                    <div class="service-field">
                      <span class="service-label">{$t('device.work_done')}:</span>
                      <span>{record.work_done}</span>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === 'energy'}
        <EnergyTab deviceId={device.mqtt_device_id} {device} />
      {/if}
    </div>
  {/if}
</div>

<!-- MQTT Credentials Result Modal -->
{#if mqttCredsResult}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeMqttCreds}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">
        <h2>{$t('device.mqtt_auth')}</h2>
        <button class="modal-close" on:click={closeMqttCreds}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        {#if mqttCredsResult.sent_via_mqtt}
          <div class="creds-box creds-success">
            <Icon name="check-circle" size={16} />
            <span>Credentials sent via MQTT — device will reconnect automatically.</span>
          </div>
        {:else}
          <div class="creds-box creds-warning">
            <Icon name="alert-triangle" size={16} />
            <span>MQTT unavailable. Enter credentials manually on the device.</span>
          </div>
        {/if}
        <div class="creds-details">
          <div class="creds-row"><span class="creds-label">Username:</span> <code>{mqttCredsResult.username}</code></div>
          <div class="creds-row"><span class="creds-label">Password:</span> <code>{mqttCredsResult.password}</code></div>
          <div class="creds-row"><span class="creds-label">Host:</span> <code>{mqttCredsResult.mqtt_host}:{mqttCredsResult.mqtt_port}</code></div>
        </div>
        <button class="btn btn-sm btn-ghost" on:click={copyMqttPassword}>
          <Icon name="copy" size={14} />
          Copy password
        </button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" on:click={closeMqttCreds}>{$t('common.close')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Modal -->
{#if showEdit}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeEdit}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation on:keydown={handleEditKeydown}>
      <div class="modal-header">
        <h2>{$t('device.edit_device')}</h2>
        <button class="modal-close" on:click={closeEdit}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="edit-name">{$t('device.name')}</label>
          <input id="edit-name" type="text" bind:value={editForm.name}
            placeholder={$t('device.name_placeholder')} />
        </div>
        <div class="form-group">
          <label for="edit-location">{$t('device.location')}</label>
          <input id="edit-location" type="text" bind:value={editForm.location}
            placeholder={$t('device.location_placeholder')} />
        </div>
        <div class="form-group">
          <label for="edit-model">{$t('device.model')}</label>
          <input id="edit-model" type="text" bind:value={editForm.model}
            placeholder={$t('device.model_placeholder')} />
        </div>
        <div class="form-group">
          <label for="edit-serial">{$t('device.serial_number')}</label>
          <input id="edit-serial" type="text" bind:value={editForm.serial_number}
            placeholder={$t('device.serial_placeholder')} />
        </div>
        <div class="form-group">
          <label for="edit-comment">{$t('device.comment')}</label>
          <textarea id="edit-comment" rows="3" bind:value={editForm.comment}
            placeholder={$t('device.comment_placeholder')}></textarea>
        </div>
        <div class="form-group">
          <label for="edit-manufactured">{$t('device.manufactured_at')}</label>
          <input id="edit-manufactured" type="date" bind:value={editForm.manufactured_at} />
        </div>

        <!-- Power Profile -->
        <div class="form-section-title">{$t('energy.power_profile')}</div>
        <div class="form-group">
          <label for="edit-model-id">{$t('energy.equipment_model')}</label>
          <div class="model-select-row">
            <select id="edit-model-id" bind:value={editForm.model_id}>
              <option value="">— {$t('common.no')} —</option>
              {#each deviceModels as m}
                <option value={m.id}>{m.name} ({m.compressor_kw || 0} kW)</option>
              {/each}
            </select>
            <button type="button" class="btn btn-icon-sm" on:click={openNewModel} title={$t('energy.new_model')}>+</button>
          </div>
        </div>

        {#if showNewModel}
          <div class="new-model-form">
            <div class="form-group">
              <label>{$t('common.name')}</label>
              <input type="text" bind:value={newModel.name} placeholder="ModESP-4R" />
            </div>
            <div class="form-row-power">
              <div class="form-group">
                <label>{$t('energy.compressor')} (kW)</label>
                <input type="number" step="0.001" min="0" bind:value={newModel.compressor_kw} placeholder="0.450" />
              </div>
              <div class="form-group">
                <label>{$t('energy.defrost')} (kW)</label>
                <input type="number" step="0.001" min="0" bind:value={newModel.defrost_heater_kw} placeholder="0.800" />
              </div>
            </div>
            <div class="form-row-power">
              <div class="form-group">
                <label>{$t('energy.evap_fan')} ({$t('energy.unit_w')})</label>
                <input type="number" step="1" min="0" bind:value={newModel.evap_fan_w} placeholder="50" />
              </div>
              <div class="form-group">
                <label>{$t('energy.cond_fan')} ({$t('energy.unit_w')})</label>
                <input type="number" step="1" min="0" bind:value={newModel.cond_fan_w} placeholder="80" />
              </div>
            </div>
            <div class="form-group">
              <label>{$t('energy.standby')} ({$t('energy.unit_w')})</label>
              <input type="number" step="1" min="0" bind:value={newModel.standby_w} placeholder="20" style="max-width: 200px" />
            </div>
            <div class="new-model-actions">
              <button type="button" class="btn btn-ghost btn-sm" on:click={() => showNewModel = false}>{$t('common.cancel')}</button>
              <button type="button" class="btn btn-primary btn-sm" on:click={createModel} disabled={creatingModel || !newModel.name.trim()}>
                {creatingModel ? $t('common.loading') : $t('common.save')}
              </button>
            </div>
          </div>
        {/if}
        <div class="form-row-power">
          <div class="form-group">
            <label>{$t('energy.compressor')} (kW)</label>
            <input type="number" step="0.001" min="0" placeholder={device?.model_compressor_kw || ''}
              bind:value={editForm.compressor_kw} />
          </div>
          <div class="form-group">
            <label>{$t('energy.defrost')} (kW)</label>
            <input type="number" step="0.001" min="0" placeholder={device?.model_defrost_heater_kw || ''}
              bind:value={editForm.defrost_heater_kw} />
          </div>
        </div>
        <div class="form-row-power">
          <div class="form-group">
            <label>{$t('energy.evap_fan')} ({$t('energy.unit_w')})</label>
            <input type="number" step="1" min="0" placeholder={device?.model_evap_fan_kw ? Math.round(device.model_evap_fan_kw * 1000) : ''}
              bind:value={editForm.evap_fan_w} />
          </div>
          <div class="form-group">
            <label>{$t('energy.cond_fan')} ({$t('energy.unit_w')})</label>
            <input type="number" step="1" min="0" placeholder={device?.model_cond_fan_kw ? Math.round(device.model_cond_fan_kw * 1000) : ''}
              bind:value={editForm.cond_fan_w} />
          </div>
        </div>
        <div class="form-group">
          <label>{$t('energy.standby')} ({$t('energy.unit_w')})</label>
          <input type="number" step="1" min="0" placeholder={device?.model_standby_kw ? Math.round(device.model_standby_kw * 1000) : ''}
            bind:value={editForm.standby_w} style="max-width: 200px" />
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeEdit} disabled={saving}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-primary" on:click={saveEdit} disabled={saving}>
          {saving ? $t('common.loading') : $t('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Add Service Record Modal -->
{#if showAddService}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeAddService}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation on:keydown={handleServiceKeydown}>
      <div class="modal-header">
        <h2>{$t('device.add_service_record')}</h2>
        <button class="modal-close" on:click={closeAddService}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="svc-date">{$t('device.service_date')}</label>
          <input id="svc-date" type="date" bind:value={serviceForm.service_date} />
        </div>
        <div class="form-group">
          <label for="svc-tech">{$t('device.technician')}</label>
          <input id="svc-tech" type="text" bind:value={serviceForm.technician}
            placeholder={$t('device.technician_placeholder')} />
        </div>
        <div class="form-group">
          <label for="svc-reason">{$t('device.reason')}</label>
          <textarea id="svc-reason" rows="2" bind:value={serviceForm.reason}
            placeholder={$t('device.reason_placeholder')}></textarea>
        </div>
        <div class="form-group">
          <label for="svc-work">{$t('device.work_done')}</label>
          <textarea id="svc-work" rows="3" bind:value={serviceForm.work_done}
            placeholder={$t('device.work_done_placeholder')}></textarea>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeAddService} disabled={serviceSaving}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-primary" on:click={saveServiceRecord}
          disabled={serviceSaving || !serviceForm.technician || !serviceForm.reason || !serviceForm.work_done}>
          {serviceSaving ? $t('common.loading') : $t('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete Device Confirmation Modal -->
{#if showDeleteConfirm}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeDeleteConfirm}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">
        <h2>{$t('device.delete_device')}</h2>
        <button class="modal-close" on:click={closeDeleteConfirm}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        <div class="delete-warning">
          <Icon name="alert-triangle" size={16} />
          <span>{$t('device.delete_confirm').replace('{0}', device.mqtt_device_id)}</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeDeleteConfirm} disabled={deleting}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-danger" on:click={confirmDeleteDevice} disabled={deleting}>
          {deleting ? $t('common.loading') : $t('common.delete')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Tenant Reassign Modal -->
{#if showReassign}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeReassign}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">
        <h2>{$t('device.change_tenant')}</h2>
        <button class="modal-close" on:click={closeReassign}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="modal-body">
        {#if reassignTenants.length === 0}
          <p class="reassign-empty">{$t('device.no_other_tenants')}</p>
        {:else}
          <div class="form-group">
            <label for="reassign-tenant">{$t('device.select_tenant')}</label>
            <select id="reassign-tenant" bind:value={selectedTenantId}>
              {#each reassignTenants as tenant}
                <option value={tenant.id}>{tenant.name} ({tenant.slug})</option>
              {/each}
            </select>
          </div>
          <div class="reassign-warning">
            <Icon name="alert-triangle" size={14} />
            <span>{$t('device.reassign_warning')}</span>
          </div>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" on:click={closeReassign}>{$t('common.cancel')}</button>
        {#if reassignTenants.length > 0}
          <button class="btn btn-primary" on:click={handleReassign} disabled={reassigning || !selectedTenantId}>
            {reassigning ? $t('common.loading') : $t('device.change_tenant')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .back-link {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--accent-blue);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .back-link:hover {
    color: var(--text-primary);
  }

  .breadcrumb-sep { color: var(--text-muted); }
  .breadcrumb-current { color: var(--text-secondary); }

  .device-header {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .device-title {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
  }

  .header-spacer {
    flex: 1;
  }

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .settings-btn:hover {
    color: var(--accent-blue);
    border-color: var(--accent-blue);
    background: var(--bg-tertiary);
  }

  /* ── More menu (⋮) ─────────────────────────── */
  .more-menu-wrap {
    position: relative;
  }

  .more-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9;
  }

  .more-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 10;
    min-width: 200px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    padding: var(--space-1) 0;
    margin-top: 4px;
  }

  .more-menu-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .more-menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .more-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .more-menu-danger {
    color: var(--accent-red);
  }

  .more-menu-danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
    color: var(--accent-red);
  }

  .more-menu-divider {
    height: 1px;
    background: var(--border-muted);
    margin: var(--space-1) 0;
  }

  .header-meta {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-top: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .header-comment {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .device-users {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-muted);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .users-label {
    color: var(--text-secondary);
  }

  .user-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    color: var(--text-primary);
  }

  .tab-content {
    min-height: 200px;
  }

  /* ── Modal ── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--bg-secondary);
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

  .modal-header h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-group label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-group input,
  .form-group textarea {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
    transition: border-color var(--transition-fast);
  }

  .form-group input:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .form-group textarea {
    resize: vertical;
    min-height: 60px;
  }

  .form-group select {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .form-section-title {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-default);
  }

  .form-row-power {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .model-select-row {
    display: flex;
    gap: var(--space-2);
  }
  .model-select-row select { flex: 1; }
  .btn-icon-sm {
    width: 36px;
    height: 36px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid var(--border-default);
    background: var(--bg-secondary);
    color: var(--accent-blue);
    font-size: 18px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-icon-sm:hover { background: var(--accent-blue); color: white; }

  .new-model-form {
    background: var(--bg-primary);
    border: 1px solid var(--accent-blue);
    border-radius: 8px;
    padding: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .new-model-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
  .btn-sm { padding: var(--space-1) var(--space-3); font-size: var(--text-xs); }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    border: 1px solid transparent;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-default);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  /* ── Service Records ── */
  .service-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .service-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .service-header h3 {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .btn-sm {
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .service-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .service-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .service-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .service-date,
  .service-technician {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .service-date {
    color: var(--text-primary);
  }

  .service-delete {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .service-delete:hover {
    color: var(--accent-red);
    background: var(--bg-secondary);
  }

  .service-card-body {
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .service-field {
    display: flex;
    gap: var(--space-2);
  }

  .service-label {
    font-weight: 500;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: fit-content;
  }

  /* Tenant reassignment */
  .reassign-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-top: var(--space-2);
  }

  .reassign-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--accent-amber, #fbbf24);
  }

  .reassign-empty {
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
    padding: var(--space-4);
  }

  .form-group select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
    transition: border-color var(--transition-fast);
  }

  .form-group select:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  /* MQTT Auth */
  .mqtt-auth-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .mqtt-label {
    font-weight: 500;
  }

  .mqtt-actions {
    display: flex;
    gap: var(--space-1);
    margin-left: auto;
  }

  .btn-danger-text {
    color: var(--accent-red, #ef4444) !important;
  }

  .btn-danger-text:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
  }

  .btn-warning-text {
    color: var(--accent-amber, #f59e0b) !important;
  }

  .btn-warning-text:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.1);
  }

  .btn-danger {
    background: var(--accent-red, #ef4444);
    color: #fff;
    border-color: var(--accent-red, #ef4444);
  }

  .btn-danger:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .device-danger-zone {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    margin-top: var(--space-2);
    justify-content: flex-end;
  }

  .delete-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--accent-red, #ef4444);
  }

  /* Credentials modal */
  .creds-box {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .creds-success {
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.3);
    color: var(--accent-green, #4ade80);
  }

  .creds-warning {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    color: var(--accent-amber, #fbbf24);
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

  @media (max-width: 640px) {
    .device-header {
      padding: var(--space-3);
    }

    .device-title {
      font-size: var(--text-lg);
      flex-basis: 100%;
    }

    .header-top {
      gap: var(--space-2);
    }

    .header-meta {
      gap: var(--space-2) var(--space-3);
    }

    .meta-item {
      font-size: var(--text-xs);
    }

    .breadcrumb {
      font-size: var(--text-xs);
    }

    .modal {
      max-width: 100%;
      margin: var(--space-2);
    }
  }
</style>
