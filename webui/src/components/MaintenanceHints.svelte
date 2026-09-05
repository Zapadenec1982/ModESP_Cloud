<script>
  // Maintenance hints (plan epic 2.4): alarms the controller keeps raising on
  // the same cabinet. Per device (deviceId) or for the whole organisation.
  // Acknowledging needs technician rights on the device, dismissing is for
  // administrators; "assign order" opens the work-order dialog.
  import { onMount, onDestroy } from 'svelte'
  import { getDeviceHints, getHints, ackHint, dismissHint } from '../lib/api.js'
  import { on } from '../lib/ws.js'
  import { formatDate, timeAgo, alarmLabel } from '../lib/format.js'
  import { isAdmin, canWrite, navigate } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import Icon from './ui/Icon.svelte'
  import Button from './ui/Button.svelte'
  import WorkOrderModal from './WorkOrderModal.svelte'

  export let deviceId = null
  export let limit = 50

  let hints = []
  let featureEnabled = true
  let loading = true
  let error = ''
  let busy = null
  let unsub = null

  async function load() {
    loading = true
    error = ''
    try {
      if (deviceId) {
        const body = await getDeviceHints(deviceId, { limit })
        hints = body.data || []
        featureEnabled = body.feature_enabled !== false
      } else {
        hints = await getHints({ active: 'all', limit })
      }
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  function label(h) {
    const key = `hint.${h.rule_key}`
    const s = $t(key)
    const name = s === key ? h.rule_key : s
    return h.alarm_code ? `${name}: ${alarmLabel(h.alarm_code)}` : name
  }
  function days(h) { return h.window_hours ? Math.max(1, Math.round(h.window_hours / 24)) : '—' }
  function reading(h) {
    if (h.value == null) return '—'
    return $t('hint.repeat_reading').replace('{0}', h.value).replace('{1}', days(h)).replace('{2}', h.threshold ?? '—')
  }
  function status(h) {
    if (h.closed_at) return h.closed_reason === 'dismissed' ? 'dismissed' : 'resolved'
    return h.acknowledged_at ? 'acked' : 'open'
  }

  async function ack(h) {
    const note = window.prompt($t('hint.ack_note_prompt'), '')
    if (note === null) return
    busy = h.id
    try {
      const d = await ackHint(h.id, note)
      hints = hints.map(x => x.id === h.id ? { ...x, ...d } : x)
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }
  let orderFor = null
  function createOrder(h) {
    orderFor = { kind: 'hint', id: h.id, alarm_code: h.alarm_code, severity: h.severity,
                 device_id: h.device_uuid || h.device_id || deviceId, device_name: h.device_name,
                 title: label(h), description: $t(`hint.advice_${h.rule_key}`) }
  }
  function onOrderCreated(e) {
    const o = e.detail
    // The backend acknowledges the hint when an order is made from it
    hints = hints.map(x => x.id === orderFor.id
      ? { ...x, work_order_id: o.id, work_order_status: o.status, acknowledged_at: x.acknowledged_at || new Date().toISOString() }
      : x)
    orderFor = null
  }
  async function dismiss(h) {
    busy = h.id
    try {
      const d = await dismissHint(h.id)
      hints = hints.map(x => x.id === h.id ? { ...x, ...d } : x)
    } catch (e) { toast.error(e.message) } finally { busy = null }
  }

  onMount(() => {
    load()
    unsub = on('hint', (msg) => {
      if (!deviceId || msg.device_id === deviceId || hints.some(h => h.device_id === msg.device_id)) load()
    })
  })
  onDestroy(() => { if (unsub) unsub() })

  $: open = hints.filter(h => !h.closed_at)
  $: closed = hints.filter(h => h.closed_at)
</script>

<div class="hints">
  <div class="head">
    <h3><Icon name="wrench" size={16} /> {$t('hint.title')}</h3>
    <p class="muted small">{$t('hint.subtitle')}</p>
  </div>

  {#if loading}
    <p class="muted">{$t('common.loading')}</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if !featureEnabled}
    <p class="muted">{$t('hint.feature_off')}</p>
  {:else if hints.length === 0}
    <p class="muted">{$t('hint.empty')} — {$t('hint.empty_hint')}</p>
  {:else}
    {#if open.length > 0}
      <ul class="cards">
        {#each open as h (h.id)}
          <li class="card" class:warning={h.severity === 'warning'} class:acked={!!h.acknowledged_at}>
            <div class="card-main">
              <div class="rule">{label(h)}</div>
              {#if !deviceId}<div class="device">{h.device_name || h.device_id}</div>{/if}
              <div class="reading">{reading(h)}</div>
              <div class="advice">💡 {$t(`hint.advice_${h.rule_key}`)}</div>
              <div class="meta muted small">
                {$t('hint.col_since')} {timeAgo(h.opened_at)}
                {#if h.acknowledged_at} · {$t('hint.acked')}{#if h.acknowledged_by_email} — {h.acknowledged_by_email}{/if}{#if h.ack_note}: «{h.ack_note}»{/if}{/if}
              </div>
            </div>
            <div class="actions">
              {#if h.work_order_id}
                <Button size="sm" variant="ghost" on:click={() => navigate(`/work-orders?id=${h.work_order_id}`)}>{$t('hint.wo_exists').replace('{0}', h.work_order_id)}</Button>
              {:else if $canWrite}
                <Button size="sm" variant="secondary" disabled={busy === h.id} on:click={() => createOrder(h)}>{$t('hint.create_wo')}</Button>
              {/if}
              {#if !h.acknowledged_at && $canWrite}
                <Button size="sm" variant="secondary" disabled={busy === h.id} on:click={() => ack(h)}>{$t('hint.ack')}</Button>
              {/if}
              {#if $isAdmin}
                <Button size="sm" variant="ghost" disabled={busy === h.id} on:click={() => dismiss(h)}>{$t('hint.dismiss')}</Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if closed.length > 0}
      <table class="table history">
        <thead>
          <tr>
            <th>{$t('hint.col_rule')}</th>
            {#if !deviceId}<th>{$t('hint.col_device')}</th>{/if}
            <th>{$t('hint.col_value')}</th>
            <th>{$t('hint.col_since')}</th>
            <th>{$t('hint.col_status')}</th>
          </tr>
        </thead>
        <tbody>
          {#each closed as h (h.id)}
            <tr>
              <td>{label(h)}</td>
              {#if !deviceId}<td>{h.device_name || h.device_id}</td>{/if}
              <td class="mono">{reading(h)}</td>
              <td>{formatDate(h.opened_at)}</td>
              <td><span class="status {status(h)}">{$t(`hint.${status(h)}`)}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

{#if orderFor}
  <WorkOrderModal source={orderFor} on:created={onOrderCreated} on:close={() => orderFor = null} />
{/if}

<style>
  .head { margin-bottom: var(--space-3); }
  .head h3 { display: flex; align-items: center; gap: var(--space-2); margin: 0 0 4px; font-size: var(--text-lg); }
  .cards { list-style: none; margin: 0 0 var(--space-4); padding: 0; display: grid; gap: var(--space-2); }
  .card {
    display: flex; justify-content: space-between; gap: var(--space-3); align-items: flex-start;
    padding: var(--space-3); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-blue);
    border-radius: var(--radius-md); background: var(--bg-surface);
  }
  .card.warning { border-left-color: var(--accent-yellow); }
  .card.acked { opacity: .85; }
  .rule { font-weight: 600; }
  .device { color: var(--text-secondary); font-size: var(--text-sm); }
  .reading { font-family: var(--font-mono); font-size: var(--text-sm); margin-top: 2px; }
  .advice { margin-top: 4px; font-size: var(--text-sm); }
  .meta { margin-top: 4px; }
  .actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
  .status { font-size: var(--text-xs); padding: 2px 8px; border-radius: var(--radius-full); background: var(--bg-tertiary); }
  .status.resolved { color: var(--accent-green); }
  .status.dismissed { color: var(--text-secondary); }
  .mono { font-family: var(--font-mono); font-size: var(--text-sm); }
  .muted { color: var(--text-secondary); }
  .small { font-size: var(--text-sm); }
  .error { color: var(--accent-red); }
</style>
