<script>
  /**
   * One PDF for every active device of a site — HACCP log or service report,
   * over a chosen period. Shared by the sites table and the site page, so the
   * dialog cannot drift between the two entry points.
   *
   * The PDF is registered and kept in the report archive by the backend; the
   * dialog only downloads it and reports the verification code.
   */
  import { createEventDispatcher } from 'svelte'
  import { exportSitePdf, exportSiteServicePdf } from '../lib/api.js'
  import { t, locale } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import Icon from './ui/Icon.svelte'

  /** The site row: { id, name, device_count }. */
  export let site

  const dispatch = createEventDispatcher()

  let reportType = 'haccp'   // haccp | service
  let busy = false

  function isoDay(d) { return d.toISOString().slice(0, 10) }
  let reportTo = isoDay(new Date())
  let reportFrom = isoDay(new Date(Date.now() - 30 * 86400 * 1000))

  function close() {
    if (!busy) dispatch('close')
  }

  async function run() {
    if (!site || !reportFrom || !reportTo) return
    busy = true
    try {
      const from = new Date(reportFrom + 'T00:00:00').toISOString()
      const to = new Date(reportTo + 'T23:59:59').toISOString()
      const meta = reportType === 'service'
        ? await exportSiteServicePdf(site.id, from, to, '1h', $locale)
        : await exportSitePdf(site.id, from, to, '1h', $locale)
      if (meta && meta.code) toast.success($t('export.report_code', meta.code), 8000)
      else toast.success($t('export.export_success'))
      if (meta && meta.source === 'hourly') toast.info($t('export.hourly_source'), 8000)
      dispatch('done', meta)
      dispatch('close')
    } catch (e) {
      if (e.status === 404) toast.warning($t('export.no_data'))
      else if (e.status !== 402) toast.error(e.message || $t('export.export_error'))
    } finally {
      busy = false
    }
  }
</script>

<div class="modal-backdrop" role="presentation"
  on:click={(e) => { if (e.target === e.currentTarget) close() }}
  on:keydown={(e) => { if (e.key === 'Escape') close() }}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={$t('export.haccp_report')}>
    <div class="modal-header">
      <h2>{$t('export.haccp_report')} — {site.name}</h2>
      <button class="modal-close" on:click={close} aria-label={$t('common.close')} disabled={busy}>
        <Icon name="x" size={18} />
      </button>
    </div>
    <div class="modal-body">
      <p class="hint">{$t('export.site_report_hint', site.device_count)}</p>
      <div class="form-group">
        <label for="site-report-type">{$t('export.report_type')}</label>
        <select id="site-report-type" bind:value={reportType} disabled={busy}>
          <option value="haccp">{$t('export.type_haccp')}</option>
          <option value="service">{$t('export.type_service')}</option>
        </select>
        <p class="hint">{reportType === 'service' ? $t('export.service_hint') : $t('export.verify_hint')}</p>
      </div>
      <div class="form-row">
        <div class="form-group grow">
          <label for="site-report-from">{$t('export.period_from')}</label>
          <input id="site-report-from" type="date" bind:value={reportFrom} max={reportTo} disabled={busy} />
        </div>
        <div class="form-group grow">
          <label for="site-report-to">{$t('export.period_to')}</label>
          <input id="site-report-to" type="date" bind:value={reportTo} min={reportFrom} disabled={busy} />
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" on:click={close} disabled={busy}>{$t('common.cancel')}</button>
      <button class="btn btn-primary" on:click={run} disabled={busy || !reportFrom || !reportTo}>
        {busy ? $t('export.exporting') : (reportType === 'service' ? $t('export.service_pdf') : $t('export.export_pdf'))}
      </button>
    </div>
  </div>
</div>

<style>
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
    max-width: 460px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
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
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-row {
    display: flex;
    gap: var(--space-3);
  }

  .form-group.grow {
    flex: 1;
  }

  .form-group label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .form-group input,
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

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
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

  @media (max-width: 480px) {
    .form-row {
      flex-direction: column;
    }
  }
</style>
