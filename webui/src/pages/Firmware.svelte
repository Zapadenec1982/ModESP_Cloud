<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    getFirmwares, uploadFirmware, deleteFirmware,
    getDevices, deployOta, createRollout,
    getOtaJobs, getRollouts,
    pauseRollout, resumeRollout, cancelRollout,
  } from '../lib/api.js';

  // ── State ──────────────────────────────────────────────

  let firmwares = [];
  let devices = [];
  let jobs = [];
  let rollouts = [];

  let loading = true;
  let error = null;

  // Upload form
  let uploadFile = null;
  let uploadVersion = '';
  let uploadNotes = '';
  let uploading = false;
  let uploadError = null;
  let uploadSuccess = null;

  // Deploy modal
  let showDeploy = false;
  let deployFirmware = null;
  let deployMode = 'single';        // 'single' | 'group'
  let deployDeviceId = '';
  let selectedDevices = new Set();
  let deployBatchSize = 5;
  let deployIntervalS = 300;
  let deploying = false;
  let deployError = null;

  // OTA activity tab
  let activeTab = 'jobs';           // 'jobs' | 'rollouts'
  let refreshTimer = null;

  // ── Load data ──────────────────────────────────────────

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const [fw, dev, j, r] = await Promise.all([
        getFirmwares().catch(() => []),
        getDevices().catch(() => []),
        getOtaJobs().catch(() => []),
        getRollouts().catch(() => []),
      ]);
      firmwares = fw || [];
      devices = (dev || []).filter(d => d.status === 'active' || d.online);
      jobs = j || [];
      rollouts = r || [];
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function refreshActivity() {
    try {
      const [j, r] = await Promise.all([
        getOtaJobs().catch(() => []),
        getRollouts().catch(() => []),
      ]);
      jobs = j || [];
      rollouts = r || [];
    } catch { /* silent */ }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refreshActivity, 10000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  // ── Upload ─────────────────────────────────────────────

  function handleFileSelect(e) {
    uploadFile = e.target.files[0] || null;
  }

  async function handleUpload() {
    if (!uploadFile || !uploadVersion.trim()) return;
    uploading = true;
    uploadError = null;
    uploadSuccess = null;
    try {
      await uploadFirmware(uploadFile, uploadVersion.trim(), uploadNotes.trim());
      uploadSuccess = `Firmware ${uploadVersion.trim()} uploaded successfully`;
      uploadFile = null;
      uploadVersion = '';
      uploadNotes = '';
      // Reset file input
      const fileInput = document.querySelector('.upload-form input[type="file"]');
      if (fileInput) fileInput.value = '';
      await loadAll();
    } catch (e) {
      uploadError = e.message;
    } finally {
      uploading = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────

  async function handleDelete(fw) {
    if (!confirm(`Delete firmware ${fw.version}?`)) return;
    try {
      await deleteFirmware(fw.id);
      await loadAll();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── Deploy ─────────────────────────────────────────────

  function openDeploy(fw) {
    deployFirmware = fw;
    deployMode = 'single';
    deployDeviceId = devices.length > 0 ? devices[0].mqtt_device_id : '';
    selectedDevices = new Set();
    deployBatchSize = 5;
    deployIntervalS = 300;
    deploying = false;
    deployError = null;
    showDeploy = true;
  }

  function closeDeploy() {
    showDeploy = false;
    deployFirmware = null;
  }

  function toggleDevice(devId) {
    if (selectedDevices.has(devId)) {
      selectedDevices.delete(devId);
    } else {
      selectedDevices.add(devId);
    }
    selectedDevices = selectedDevices; // trigger reactivity
  }

  async function handleDeploy() {
    if (!deployFirmware) return;
    deploying = true;
    deployError = null;
    try {
      if (deployMode === 'single') {
        if (!deployDeviceId) { deployError = 'Select a device'; deploying = false; return; }
        await deployOta(deployFirmware.id, deployDeviceId);
      } else {
        const ids = [...selectedDevices];
        if (ids.length === 0) { deployError = 'Select at least one device'; deploying = false; return; }
        await createRollout({
          firmwareId: deployFirmware.id,
          deviceIds: ids,
          batchSize: deployBatchSize,
          batchIntervalS: deployIntervalS,
        });
      }
      closeDeploy();
      await refreshActivity();
      startAutoRefresh();
    } catch (e) {
      deployError = e.message;
    } finally {
      deploying = false;
    }
  }

  // ── Rollout actions ────────────────────────────────────

  async function handlePause(id) {
    try { await pauseRollout(id); await refreshActivity(); } catch (e) { alert(e.message); }
  }
  async function handleResume(id) {
    try { await resumeRollout(id); await refreshActivity(); startAutoRefresh(); } catch (e) { alert(e.message); }
  }
  async function handleCancel(id) {
    if (!confirm('Cancel this rollout?')) return;
    try { await cancelRollout(id); await refreshActivity(); } catch (e) { alert(e.message); }
  }

  // ── Helpers ────────────────────────────────────────────

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }

  function shortChecksum(cs) {
    if (!cs) return '';
    return cs.length > 20 ? cs.slice(0, 20) + '…' : cs;
  }

  $: hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'sent');
  $: if (hasActiveJobs && !refreshTimer) startAutoRefresh();
  $: if (!hasActiveJobs && refreshTimer) stopAutoRefresh();

  // ── Lifecycle ──────────────────────────────────────────

  onMount(() => { loadAll(); });
  onDestroy(() => { stopAutoRefresh(); });
</script>

<div class="firmware-page">
  <h2>Firmware Management</h2>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <!-- ── Upload Section ────────────────────────────── -->
  <section class="card upload-section">
    <h3>Upload Firmware</h3>
    <div class="upload-form">
      <label class="file-label">
        <span>File (.bin)</span>
        <input type="file" accept=".bin" on:change={handleFileSelect} disabled={uploading} />
      </label>
      <label>
        <span>Version</span>
        <input type="text" bind:value={uploadVersion} placeholder="e.g. 1.2.3" disabled={uploading} />
      </label>
      <label class="notes-label">
        <span>Notes</span>
        <input type="text" bind:value={uploadNotes} placeholder="Release notes (optional)" disabled={uploading} />
      </label>
      <button class="btn-primary" on:click={handleUpload} disabled={uploading || !uploadFile || !uploadVersion.trim()}>
        {uploading ? 'Uploading…' : 'Upload'}
      </button>
    </div>
    {#if uploadError}
      <p class="msg error">{uploadError}</p>
    {/if}
    {#if uploadSuccess}
      <p class="msg success">{uploadSuccess}</p>
    {/if}
  </section>

  <!-- ── Firmware Library ──────────────────────────── -->
  <section class="card">
    <h3>Firmware Library</h3>
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if firmwares.length === 0}
      <p class="muted">No firmware uploaded yet</p>
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
                <td>{fmtSize(fw.size_bytes)}</td>
                <td class="mono">{shortChecksum(fw.checksum)}</td>
                <td class="notes-cell">{fw.notes || '—'}</td>
                <td>{fmtDate(fw.created_at)}</td>
                <td class="actions">
                  <button class="btn-sm btn-deploy" on:click={() => openDeploy(fw)}>Deploy</button>
                  <button class="btn-sm btn-danger" on:click={() => handleDelete(fw)}>Delete</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- ── OTA Activity ──────────────────────────────── -->
  <section class="card">
    <div class="tab-header">
      <h3>OTA Activity</h3>
      <div class="tabs">
        <button class:active={activeTab === 'jobs'} on:click={() => activeTab = 'jobs'}>Jobs</button>
        <button class:active={activeTab === 'rollouts'} on:click={() => activeTab = 'rollouts'}>Rollouts</button>
      </div>
    </div>

    {#if activeTab === 'jobs'}
      {#if jobs.length === 0}
        <p class="muted">No OTA jobs yet</p>
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
                  <td class="mono">{job.device_id}</td>
                  <td>{job.firmware_version}</td>
                  <td><span class="badge {job.status}">{job.status}</span></td>
                  <td>{fmtDate(job.queued_at)}</td>
                  <td>{fmtDate(job.completed_at)}</td>
                  <td class="error-cell">{job.error || ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else}
      {#if rollouts.length === 0}
        <p class="muted">No rollouts yet</p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Devices</th>
                <th>Succeeded</th>
                <th>Failed</th>
                <th>Queued</th>
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
                  <td><span class="badge {r.status}">{r.status}</span></td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td class="actions">
                    {#if r.status === 'running'}
                      <button class="btn-sm" on:click={() => handlePause(r.id)}>Pause</button>
                    {:else if r.status === 'paused'}
                      <button class="btn-sm btn-deploy" on:click={() => handleResume(r.id)}>Resume</button>
                    {/if}
                    {#if r.status === 'running' || r.status === 'paused'}
                      <button class="btn-sm btn-danger" on:click={() => handleCancel(r.id)}>Cancel</button>
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
</div>

<!-- ── Deploy Modal ──────────────────────────────── -->
{#if showDeploy}
  <div class="modal-backdrop" on:click={closeDeploy} on:keydown={() => {}}>
    <div class="modal" on:click|stopPropagation on:keydown={() => {}}>
      <h3>Deploy {deployFirmware?.version}</h3>

      <div class="deploy-mode">
        <label>
          <input type="radio" bind:group={deployMode} value="single" /> Single Device
        </label>
        <label>
          <input type="radio" bind:group={deployMode} value="group" /> Group Rollout
        </label>
      </div>

      {#if deployMode === 'single'}
        <label class="deploy-field">
          <span>Device</span>
          <select bind:value={deployDeviceId}>
            {#each devices as d}
              <option value={d.mqtt_device_id}>{d.name || d.mqtt_device_id} ({d.mqtt_device_id})</option>
            {/each}
          </select>
        </label>
      {:else}
        <div class="device-list">
          <p class="muted">Select devices:</p>
          {#each devices as d}
            <label class="device-check">
              <input type="checkbox" checked={selectedDevices.has(d.mqtt_device_id)}
                     on:change={() => toggleDevice(d.mqtt_device_id)} />
              {d.name || d.mqtt_device_id}
              <span class="mono">({d.mqtt_device_id})</span>
              {#if d.firmware_version}
                <span class="fw-badge">v{d.firmware_version}</span>
              {/if}
            </label>
          {/each}
        </div>
        <div class="rollout-opts">
          <label>
            <span>Batch size</span>
            <input type="number" bind:value={deployBatchSize} min="1" max="50" />
          </label>
          <label>
            <span>Interval (sec)</span>
            <input type="number" bind:value={deployIntervalS} min="30" max="3600" />
          </label>
        </div>
      {/if}

      {#if deployError}
        <p class="msg error">{deployError}</p>
      {/if}

      <div class="modal-actions">
        <button class="btn-secondary" on:click={closeDeploy} disabled={deploying}>Cancel</button>
        <button class="btn-primary" on:click={handleDeploy} disabled={deploying}>
          {deploying ? 'Deploying…' : 'Deploy'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .firmware-page { max-width: 960px; margin: 0 auto; }

  h2 {
    font-size: 1.4rem;
    color: #2d3436;
    margin: 0 0 1.25rem;
  }

  .card {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 1rem;
    color: #2d3436;
    margin: 0 0 0.75rem;
  }

  .error-banner {
    background: #fff0f0;
    color: #d63031;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.85rem;
  }

  .muted { color: #b2bec3; font-size: 0.85rem; }

  /* ── Upload form ──────────────────────────── */

  .upload-form {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .upload-form label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .upload-form span {
    font-size: 0.7rem;
    color: #636e72;
    text-transform: uppercase;
    font-weight: 600;
  }

  .upload-form input[type="text"],
  .upload-form input[type="file"] {
    padding: 0.35rem 0.5rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    font-size: 0.8rem;
    font-family: inherit;
  }

  .notes-label { flex: 1; min-width: 150px; }

  .msg { font-size: 0.8rem; margin: 0.5rem 0 0; }
  .msg.error { color: #d63031; }
  .msg.success { color: #00b894; }

  /* ── Tables ───────────────────────────────── */

  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 2px solid #dfe6e9;
    color: #636e72;
    font-weight: 600;
    white-space: nowrap;
  }

  td {
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid #f1f2f6;
    color: #2d3436;
    vertical-align: middle;
  }

  .mono { font-family: 'Fira Code', monospace; font-size: 0.75rem; }
  .fw-version { font-weight: 600; }
  .notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error-cell { color: #d63031; font-size: 0.75rem; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .count-ok { color: #00b894; font-weight: 600; }
  .count-fail { color: #d63031; font-weight: 600; }

  .actions { display: flex; gap: 0.3rem; }

  /* ── Buttons ──────────────────────────────── */

  .btn-primary {
    padding: 0.4rem 0.8rem;
    border: none;
    border-radius: 4px;
    background: #0984e3;
    color: white;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-primary:hover { background: #0773c5; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    padding: 0.4rem 0.8rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    background: white;
    color: #636e72;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .btn-secondary:hover { background: #f8f9fa; }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    background: white;
    font-size: 0.72rem;
    cursor: pointer;
    color: #636e72;
    white-space: nowrap;
  }
  .btn-sm:hover { background: #f8f9fa; }

  .btn-deploy { border-color: #0984e3; color: #0984e3; }
  .btn-deploy:hover { background: #0984e3; color: white; }

  .btn-danger { border-color: #d63031; color: #d63031; }
  .btn-danger:hover { background: #d63031; color: white; }

  /* ── Badges ───────────────────────────────── */

  .badge {
    display: inline-block;
    padding: 0.15rem 0.45rem;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge.queued     { background: #f1f2f6; color: #636e72; }
  .badge.sent       { background: #dfe6fd; color: #0984e3; }
  .badge.succeeded  { background: #d4f5e9; color: #00b894; }
  .badge.failed     { background: #ffe0e0; color: #d63031; }
  .badge.cancelled  { background: #f1f2f6; color: #b2bec3; }
  .badge.running    { background: #dfe6fd; color: #0984e3; }
  .badge.paused     { background: #ffeaa7; color: #d68910; }
  .badge.completed  { background: #d4f5e9; color: #00b894; }

  /* ── Tabs ──────────────────────────────────── */

  .tab-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .tab-header h3 { margin: 0; }

  .tabs { display: flex; gap: 0.25rem; }

  .tabs button {
    padding: 0.3rem 0.6rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    background: white;
    font-size: 0.75rem;
    cursor: pointer;
    color: #636e72;
  }
  .tabs button:hover { background: #f8f9fa; }
  .tabs button.active { background: #0984e3; color: white; border-color: #0984e3; }

  /* ── Modal ─────────────────────────────────── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: white;
    border-radius: 12px;
    padding: 1.5rem;
    width: 90%;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
  }

  .modal h3 { margin: 0 0 1rem; }

  .deploy-mode {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .deploy-mode label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .deploy-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 1rem;
  }

  .deploy-field span {
    font-size: 0.7rem;
    color: #636e72;
    text-transform: uppercase;
    font-weight: 600;
  }

  .deploy-field select {
    padding: 0.35rem 0.5rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    font-size: 0.85rem;
    font-family: inherit;
  }

  .device-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid #f1f2f6;
    border-radius: 6px;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .fw-badge {
    font-size: 0.7rem;
    color: #636e72;
    background: #f1f2f6;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    margin-left: auto;
  }

  .rollout-opts {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .rollout-opts label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .rollout-opts span {
    font-size: 0.7rem;
    color: #636e72;
    text-transform: uppercase;
    font-weight: 600;
  }

  .rollout-opts input {
    padding: 0.35rem 0.5rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    font-size: 0.85rem;
    width: 100px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
