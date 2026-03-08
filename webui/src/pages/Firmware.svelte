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
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 var(--space-5);
  }

  .card {
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    border: 1px solid var(--border-default);
    margin-bottom: var(--space-4);
  }

  h3 {
    font-size: var(--text-lg);
    color: var(--text-primary);
    margin: 0 0 var(--space-3);
  }

  .error-banner {
    background: rgba(248, 81, 73, 0.1);
    color: var(--accent-red);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);
    font-size: var(--text-sm);
    border: 1px solid rgba(248, 81, 73, 0.2);
  }

  .muted { color: var(--text-muted); font-size: var(--text-sm); }

  /* ── Upload form ──────────────────────────── */

  .upload-form {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .upload-form label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .upload-form span {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
  }

  .upload-form input[type="text"],
  .upload-form input[type="file"] {
    padding: var(--space-2) var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-family: inherit;
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .upload-form input[type="text"]::placeholder {
    color: var(--text-muted);
  }

  .upload-form input[type="text"]:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .notes-label { flex: 1; min-width: 150px; }

  .msg { font-size: var(--text-sm); margin: var(--space-2) 0 0; }
  .msg.error { color: var(--accent-red); }
  .msg.success { color: var(--accent-green); }

  /* ── Tables ───────────────────────────────── */

  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 2px solid var(--border-default);
    color: var(--text-muted);
    font-weight: 600;
    font-size: var(--text-xs);
    text-transform: uppercase;
    white-space: nowrap;
  }

  td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-primary);
    vertical-align: middle;
  }

  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .fw-version { font-weight: 600; color: var(--text-primary); }
  .notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
  .error-cell { color: var(--accent-red); font-size: var(--text-xs); max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .count-ok { color: var(--accent-green); font-weight: 600; }
  .count-fail { color: var(--accent-red); font-weight: 600; }

  .actions { display: flex; gap: 0.3rem; }

  /* ── Buttons ──────────────────────────────── */

  .btn-primary {
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: var(--accent-blue);
    color: var(--text-inverse);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .btn-primary:hover { background: #4a9aef; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .btn-secondary:hover { background: var(--border-default); }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    color: var(--text-secondary);
    white-space: nowrap;
    transition: all var(--transition-fast);
  }
  .btn-sm:hover { background: var(--border-default); }

  .btn-deploy { border-color: var(--accent-blue); color: var(--accent-blue); background: rgba(88, 166, 255, 0.06); }
  .btn-deploy:hover { background: var(--accent-blue); color: var(--text-inverse); }

  .btn-danger { border-color: rgba(248, 81, 73, 0.3); color: var(--accent-red); background: rgba(248, 81, 73, 0.06); }
  .btn-danger:hover { background: rgba(248, 81, 73, 0.15); }

  /* ── Badges ───────────────────────────────── */

  .badge {
    display: inline-block;
    padding: 0.15rem 0.45rem;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge.queued     { background: var(--bg-tertiary); color: var(--text-secondary); }
  .badge.sent       { background: rgba(88, 166, 255, 0.1); color: var(--accent-blue); }
  .badge.succeeded  { background: rgba(63, 185, 80, 0.1); color: var(--accent-green); }
  .badge.failed     { background: rgba(248, 81, 73, 0.1); color: var(--accent-red); }
  .badge.cancelled  { background: var(--bg-tertiary); color: var(--text-muted); }
  .badge.running    { background: rgba(88, 166, 255, 0.1); color: var(--accent-blue); }
  .badge.paused     { background: rgba(210, 153, 34, 0.15); color: var(--accent-yellow); }
  .badge.completed  { background: rgba(63, 185, 80, 0.1); color: var(--accent-green); }

  /* ── Tabs ──────────────────────────────────── */

  .tab-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .tab-header h3 { margin: 0; }

  .tabs { display: flex; gap: var(--space-1); }

  .tabs button {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    color: var(--text-secondary);
    transition: all var(--transition-fast);
  }
  .tabs button:hover { background: var(--border-default); }
  .tabs button.active { background: var(--accent-blue); color: var(--text-inverse); border-color: var(--accent-blue); }

  /* ── Modal ─────────────────────────────────── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    width: 90%;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .modal h3 { margin: 0 0 var(--space-4); color: var(--text-primary); }

  .deploy-mode {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .deploy-mode label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text-primary);
  }

  .deploy-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: var(--space-4);
  }

  .deploy-field span {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
  }

  .deploy-field select {
    padding: var(--space-2) var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-family: inherit;
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .device-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    margin-bottom: var(--space-3);
    background: var(--bg-tertiary);
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text-primary);
  }

  .fw-badge {
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-surface);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    margin-left: auto;
  }

  .rollout-opts {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .rollout-opts label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .rollout-opts span {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
  }

  .rollout-opts input {
    padding: var(--space-2) var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    width: 100px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .rollout-opts input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
</style>
