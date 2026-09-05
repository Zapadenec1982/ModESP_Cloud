<script>
  import { onMount } from 'svelte'
  import { getDeviceAlarms, getAlarms } from '../lib/api.js'
  import { alarmLabel, formatDate, formatDuration } from '../lib/format.js'
  import { navigate, canWrite } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import WorkOrderModal from './WorkOrderModal.svelte'

  export let deviceId = null
  export let limit = 20

  let alarms = []
  let loading = true
  let error = ''

  // Work order straight from the row (plan epic 2.3); the backend acknowledges the alarm
  let orderFor = null
  function orderSource(alarm) {
    return { kind: 'alarm', id: alarm.id, alarm_code: alarm.alarm_code, severity: alarm.severity,
             device_id: alarm.device_id || deviceId, device_name: alarm.device_name }
  }
  function onOrderCreated(e) {
    const o = e.detail
    alarms = alarms.map(a => a.id === orderFor.id
      ? { ...a, work_order_id: o.id, work_order_status: o.status, acknowledged_at: a.acknowledged_at || new Date().toISOString() }
      : a)
    orderFor = null
  }

  function duration(triggered, cleared) {
    if (!cleared) return null
    const ms = new Date(cleared) - new Date(triggered)
    const secs = Math.round(ms / 1000)
    return formatDuration(secs)
  }

  onMount(async () => {
    loading = true
    try {
      if (deviceId) {
        alarms = await getDeviceAlarms(deviceId, { limit })
      } else {
        alarms = await getAlarms({ limit })
      }
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  })
</script>

<div class="alarm-history">
  <h3>{$t('alarm.history')}</h3>

  {#if loading}
    <p class="muted">{$t('common.loading')}</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if alarms.length === 0}
    <p class="muted">{$t('alarm.no_recorded')}</p>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>{$t('alarm.col_time')}</th>
          {#if !deviceId}<th>{$t('alarm.col_device')}</th>{/if}
          <th>{$t('alarm.col_type')}</th>
          <th>{$t('alarm.col_severity')}</th>
          <th>{$t('alarm.col_duration')}</th>
          <th>{$t('alarm.col_status')}</th>
          <th>{$t('alarm.col_ack')}</th>
          <th>{$t('alarm.col_order')}</th>
        </tr>
      </thead>
      <tbody>
        {#each alarms as alarm}
          <tr>
            <td>{formatDate(alarm.triggered_at)}</td>
            {#if !deviceId}
              <td>{alarm.device_name || alarm.device_id}</td>
            {/if}
            <td>{alarmLabel(alarm.alarm_code)}</td>
            <td>
              <span class="badge badge-{alarm.severity}">{alarm.severity}</span>
            </td>
            <td>{duration(alarm.triggered_at, alarm.cleared_at) || '—'}</td>
            <td>
              {#if alarm.active}
                <span class="status-active">{$t('common.active')}</span>
              {:else}
                <span class="status-cleared">{$t('alarm.cleared')}</span>
              {/if}
            </td>
            <td class="muted">
              {#if alarm.acknowledged_at}
                ✓ {formatDate(alarm.acknowledged_at)}{alarm.acknowledged_by_email ? ' · ' + alarm.acknowledged_by_email : ''}
              {:else}
                —
              {/if}
            </td>
            <td>
              {#if alarm.work_order_id}
                <button class="order-btn linked" on:click={() => navigate(`/work-orders?id=${alarm.work_order_id}`)} title={$t('wo.status_' + alarm.work_order_status)}>
                  {$t('alarm.wo_exists').replace('{0}', alarm.work_order_id)}
                </button>
              {:else if $canWrite}
                <button class="order-btn" on:click={() => orderFor = orderSource(alarm)}>{$t('alarm.create_wo')}</button>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if orderFor}
  <WorkOrderModal source={orderFor} on:created={onOrderCreated} on:close={() => orderFor = null} />
{/if}

<style>
  .alarm-history {
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    border: 1px solid var(--border-default);
  }

  h3 {
    font-size: var(--text-base);
    color: var(--text-primary);
    margin: 0 0 var(--space-3);
    font-weight: 600;
  }

  .muted { color: var(--text-muted); font-size: var(--text-sm); }
  .error { color: var(--accent-red); font-size: var(--text-sm); }

  .table {
    width: 100%;
    border-collapse: collapse;
  }

  .table th {
    text-align: left;
    padding: var(--space-2) var(--space-2);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 2px solid var(--border-muted);
  }

  .table td {
    padding: var(--space-2) var(--space-2);
    font-size: var(--text-sm);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-secondary);
  }

  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-critical { background: rgba(239, 68, 68, 0.12); color: var(--accent-red); }
  .badge-warning  { background: rgba(251, 191, 36, 0.12); color: var(--accent-orange); }
  .badge-info     { background: rgba(74, 158, 255, 0.12); color: var(--accent-blue); }

  .status-active {
    color: var(--accent-red);
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .status-cleared {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .order-btn {
    padding: 2px 8px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: var(--text-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .order-btn:hover { border-color: var(--accent-blue); }
  .order-btn.linked { color: var(--accent-blue); border-color: rgba(74, 158, 255, 0.35); }
</style>
