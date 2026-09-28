<script>
  /**
   * «Потребують уваги» — the work of today, on the first screen (audit item 1).
   *
   * One row per thing a person should act on, most urgent first:
   *   1. open alarms — critical first, then the oldest;
   *   2. product out of its HACCP range (a live reading past the range, or a
   *      recorded temperature alarm the alarm list did not carry);
   *   3. equipment offline — the longest silent first;
   *   4. open maintenance hints;
   *   5. new work orders nobody has taken.
   * Each row names the site, the device, the reason, how long it has been so,
   * and who is responsible — the assignee of the work order when one exists,
   * else «виконавця ще немає» — and opens the device, the alarm list or the
   * work order.
   */
  import { navigate } from '../../lib/stores.js'
  import { t } from '../../lib/i18n.js'
  import { durationSince, alarmLabel } from '../../lib/format.js'
  import { tempState, haccpRangeLabel, isTempAlarm } from '../../lib/haccp.js'
  import Icon from '../ui/Icon.svelte'

  export let devices = []   // the dashboard's device list (GET /devices)
  export let alarms = []    // GET /alarms?active=true
  export let orders = []    // GET /work-orders?status=open — new, assigned and in progress
  export let now = Date.now()
  export let limit = 8

  let expanded = false

  const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }
  const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }
  const ts = (v) => { const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? 0 : n }
  const fmt1 = (v) => (v == null ? '—' : Number(v).toFixed(1).replace('-', '−'))

  // $t is passed in so the rows re-translate when the language changes
  $: rows = buildRows(devices, alarms, orders, $t)
  $: visible = expanded || rows.length <= limit ? rows : rows.slice(0, limit)

  function buildRows(devices, alarms, orders, tr) {
    const byMqtt = new Map(devices.map(d => [d.mqtt_device_id, d]))
    // The newest open order per alarm and per device: the list comes ordered
    // by priority then created_at DESC, so the first one seen wins.
    const orderByAlarm = new Map()
    const orderByDevice = new Map()
    for (const o of orders) {
      if (o.alarm_id != null && !orderByAlarm.has(String(o.alarm_id))) orderByAlarm.set(String(o.alarm_id), o)
      if (o.device_id && !orderByDevice.has(o.device_id)) orderByDevice.set(o.device_id, o)
    }
    const deviceTarget = (d) => `/device/${d.mqtt_device_id}`
    const out = []

    // 1. open alarms
    const alarmedDevices = new Set()
    const tempAlarmedDevices = new Set()
    for (const a of alarms) {
      const mqttId = a.mqtt_device_id || a.device_id
      const d = byMqtt.get(mqttId)
      alarmedDevices.add(mqttId)
      if (isTempAlarm(a.alarm_code)) tempAlarmedDevices.add(mqttId)
      out.push({
        key: `alarm-${a.id}`, kind: 'alarm',
        tone: a.severity === 'critical' ? 'critical' : a.severity === 'info' ? 'info' : 'warning',
        rank: [0, SEVERITY_RANK[a.severity] ?? 1, ts(a.triggered_at)],
        site: d?.site_name || '',
        device: a.device_name || d?.name || mqttId,
        reason: alarmLabel(a.alarm_code),
        detail: isTempAlarm(a.alarm_code) && d ? tempDetail(d) : '',
        since: a.triggered_at,
        order: orderByAlarm.get(String(a.id)) || (d ? orderByDevice.get(d.id) : null) || null,
        target: '/alarms',
      })
    }

    for (const d of devices) {
      const order = orderByDevice.get(d.id) || null
      // 2. out of the HACCP range without an alarm row above already saying so
      const outOfRange = tempState(d) === 'out_of_range' || !!d.temp_alarm_since
      if (outOfRange && !tempAlarmedDevices.has(d.mqtt_device_id)) {
        out.push({
          key: `range-${d.id}`, kind: 'range', tone: 'critical',
          rank: [1, 0, d.temp_alarm_since ? ts(d.temp_alarm_since) : Number.MAX_SAFE_INTEGER],
          site: d.site_name || '', device: d.name || d.mqtt_device_id,
          reason: tr('dashboard.attention_out_of_range'), detail: tempDetail(d),
          since: d.temp_alarm_since || null, order, target: deviceTarget(d),
        })
      }
      // 3. offline — a pending controller was never set up, so it is not an outage
      if (!d.online && d.status !== 'pending') {
        out.push({
          key: `offline-${d.id}`, kind: 'offline', tone: 'offline',
          rank: [2, 0, ts(d.last_seen)],
          site: d.site_name || '', device: d.name || d.mqtt_device_id,
          reason: tr('common.offline'), detail: '',
          since: d.last_seen || null, order, target: deviceTarget(d),
        })
      }
      // 4. open maintenance hints — the alarm row already points at this device
      if ((d.hints_open || 0) > 0 && !alarmedDevices.has(d.mqtt_device_id)) {
        out.push({
          key: `hint-${d.id}`, kind: 'hint', tone: 'hint',
          rank: [3, 0, 0],
          site: d.site_name || '', device: d.name || d.mqtt_device_id,
          reason: tr('dashboard.attention_hints', d.hints_open), detail: '',
          since: null, order, target: deviceTarget(d),
        })
      }
    }

    // 5. new work orders nobody has taken
    for (const o of orders) {
      if (o.status !== 'new') continue
      out.push({
        key: `wo-${o.id}`, kind: 'wo', tone: 'wo',
        rank: [4, PRIORITY_RANK[o.priority] ?? 2, ts(o.created_at)],
        site: o.site_name || '', device: o.device_name || '',
        reason: tr('dashboard.attention_wo_new'), detail: o.title || '',
        since: o.created_at, order: null, target: `/work-orders?id=${o.id}`,
      })
    }

    out.sort((a, b) => {
      for (let i = 0; i < 3; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]
      return String(a.device).localeCompare(String(b.device))
    })
    return out
  }

  /** "−12.4 °C · ≤ −18 °C (±3)" — the reading against the range it broke */
  function tempDetail(d) {
    const range = haccpRangeLabel(d)
    return `${fmt1(d.air_temp)} °C${range ? ` · ${range}` : ''}`
  }

  function open(row) {
    navigate(row.target)
  }
</script>

<section class="attention" aria-labelledby="attention-title">
  <header class="att-head">
    <div class="att-title">
      <Icon name="alert-triangle" size={16} />
      <h2 id="attention-title">{$t('dashboard.attention_title')}</h2>
      {#if rows.length}
        <span class="att-count">{rows.length}</span>
      {/if}
    </div>
    <p class="att-sub">{$t('dashboard.attention_sub')}</p>
  </header>

  {#if rows.length === 0}
    <p class="calm">
      <Icon name="check-circle" size={14} />
      {$t('dashboard.attention_empty')}
    </p>
  {:else}
    <div class="att-rows" role="list">
      <div class="att-row att-cols" aria-hidden="true">
        <span />
        <span>{$t('dashboard.attention_col_site')}</span>
        <span>{$t('dashboard.attention_col_device')}</span>
        <span>{$t('dashboard.attention_col_reason')}</span>
        <span class="right">{$t('dashboard.attention_col_duration')}</span>
        <span>{$t('dashboard.attention_col_responsible')}</span>
      </div>
      {#each visible as row (row.key)}
        <div class="att-row {row.tone}" role="listitem">
          <button type="button" class="att-main" on:click={() => open(row)}>
            <span class="att-dot" />
            <span class="att-site truncate">{row.site || $t('dashboard.no_site')}</span>
            <span class="att-device truncate">{row.device || '—'}</span>
            <span class="att-reason truncate">
              {row.reason}
              {#if row.detail}<span class="att-detail">{row.detail}</span>{/if}
            </span>
            <span class="att-duration">{row.since ? durationSince(row.since, now) : '—'}</span>
          </button>
          <span class="att-resp truncate">
            {#if row.kind === 'wo'}
              <span class="none">{$t('dashboard.attention_no_assignee')}</span>
            {:else if row.order && row.order.assigned_to_email}
              <a href="#/work-orders?id={row.order.id}" title={$t('dashboard.attention_wo', row.order.id)}>{row.order.assigned_to_email}</a>
            {:else if row.order}
              <a href="#/work-orders?id={row.order.id}">{$t('dashboard.attention_wo', row.order.id)} · {$t('dashboard.attention_no_assignee')}</a>
            {:else}
              <span class="none">{$t('dashboard.attention_no_assignee')}</span>
            {/if}
          </span>
        </div>
      {/each}
    </div>
    {#if rows.length > limit}
      <button type="button" class="att-more" on:click={() => (expanded = !expanded)}>
        {expanded ? $t('dashboard.attention_show_less') : $t('dashboard.attention_show_all', rows.length)}
      </button>
    {/if}
  {/if}
</section>

<style>
  .attention {
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .att-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .att-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-primary);
  }

  .att-title h2 {
    font-size: var(--text-base);
    font-weight: 600;
    margin: 0;
  }

  .att-count {
    background: rgba(239, 68, 68, 0.12);
    color: var(--accent-red);
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    font-family: var(--font-mono);
  }

  .att-sub {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .calm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) 0;
    font-size: var(--text-sm);
    color: var(--accent-green);
  }

  .att-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .att-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(140px, 220px);
    gap: var(--space-3);
    align-items: center;
    border-radius: var(--radius-sm);
  }

  /* Column headings share the row grid so they line up with the cells */
  .att-cols {
    grid-template-columns: 8px minmax(90px, 0.9fr) minmax(110px, 1fr) minmax(160px, 1.8fr) 84px minmax(140px, 220px);
    gap: var(--space-3);
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .att-cols .right { text-align: right; }

  .att-main {
    all: unset;
    cursor: pointer;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 8px minmax(90px, 0.9fr) minmax(110px, 1fr) minmax(160px, 1.8fr) 84px;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
    transition: background var(--transition-fast);
  }

  .att-main:hover { background: var(--bg-tertiary); }

  .att-main:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: -2px;
  }

  .att-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .critical .att-dot { background: var(--accent-red); box-shadow: 0 0 6px rgba(239, 68, 68, 0.6); }
  .warning  .att-dot { background: var(--accent-yellow); }
  .info     .att-dot { background: var(--accent-cyan); }
  .offline  .att-dot { background: var(--text-secondary); }
  .hint     .att-dot { background: var(--accent-blue); }
  .wo       .att-dot { background: var(--accent-purple); }

  .att-site { color: var(--text-secondary); }

  .att-device { font-weight: 600; }

  .att-reason { color: var(--text-primary); }

  .critical .att-reason { color: var(--accent-red); }

  .att-detail {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    margin-left: var(--space-1);
  }

  .att-duration {
    text-align: right;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .att-resp {
    font-size: var(--text-sm);
    padding-right: var(--space-2);
  }

  .att-resp a {
    color: var(--accent-blue);
    text-decoration: none;
  }

  .att-resp a:hover { text-decoration: underline; }

  .att-resp .none { color: var(--text-muted); font-style: italic; }

  .att-more {
    all: unset;
    cursor: pointer;
    align-self: flex-start;
    font-size: var(--text-sm);
    color: var(--accent-blue);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
  }

  .att-more:hover { background: var(--bg-tertiary); }

  .att-more:focus-visible {
    outline: 2px solid var(--accent-blue);
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  @media (max-width: 760px) {
    .att-cols { display: none; }
    .att-row {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .att-main {
      grid-template-columns: 8px minmax(0, 1fr) auto;
      grid-template-areas:
        'dot device duration'
        'dot site duration'
        'dot reason duration';
      row-gap: 2px;
    }
    .att-dot { grid-area: dot; align-self: start; margin-top: 6px; }
    .att-device { grid-area: device; }
    .att-site { grid-area: site; font-size: var(--text-xs); }
    .att-reason { grid-area: reason; white-space: normal; }
    .att-duration { grid-area: duration; align-self: start; }
    .att-resp { padding: 0 var(--space-2) var(--space-2) calc(8px + var(--space-3) + var(--space-2)); font-size: var(--text-xs); }
  }
</style>
