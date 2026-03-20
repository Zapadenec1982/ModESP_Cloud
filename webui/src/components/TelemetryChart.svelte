<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { getTelemetry, getDeviceEvents, exportTelemetryCsv, exportTelemetryPdf } from '../lib/api.js';
  import { liveState } from '../lib/stores.js';
  import { t } from '../lib/i18n.js';
  import { toast } from '../lib/toast.js';

  export let deviceId;

  // ── Events overlay state ─────────────────────────────────
  let deviceEvents = [];
  let showEventLog = false;

  // Temperature channels + equipment state channels
  const TEMP_CHANNELS = ['air', 'evap', 'cond', 'setpoint'];
  const STATE_CHANNELS = ['comp', 'defrost'];
  const ALL_CHANNELS = [...TEMP_CHANNELS, ...STATE_CHANNELS];

  const PRESETS = [
    { label: '1h',  hours: 1 },
    { label: '6h',  hours: 6 },
    { label: '24h', hours: 24 },
    { label: '7d',  hours: 168 },
    { label: '30d', hours: 720 },
  ];

  const SERIES_CONFIG = {
    air:      { label: 'Air',        stroke: '#22d3ee', width: 2 },
    evap:     { label: 'Evaporator', stroke: '#34d399', width: 2 },
    cond:     { label: 'Condenser',  stroke: '#f97316', width: 2 },
    setpoint: { label: 'Setpoint',   stroke: '#a78bfa', width: 2, dash: [5, 5] },
    comp:     { label: 'Compressor', stroke: 'rgba(59,130,246,0.5)', fill: 'rgba(59,130,246,0.08)', band: true },
    defrost:  { label: 'Defrost',    stroke: 'rgba(251,146,60,0.5)', fill: 'rgba(251,146,60,0.12)', band: true },
  };

  // Map liveState keys → telemetry channels for real-time append
  const LIVE_KEY_MAP = {
    'equipment.air_temp':             'air',
    'equipment.evap_temp':            'evap',
    'equipment.cond_temp':            'cond',
    'thermostat.effective_setpoint':  'setpoint',
    'equipment.compressor':           'comp',
    'defrost.active':                 'defrost',
  };

  // ── Date range state ─────────────────────────────────────

  function toLocalInput(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}`;
  }

  function initRange(hoursAgo) {
    const now = new Date();
    const from = new Date(now.getTime() - hoursAgo * 3600 * 1000);
    return { from: toLocalInput(from), to: toLocalInput(now) };
  }

  let range = initRange(24);
  let activePreset = '24h';

  let loading = false;
  let noData = false;
  let chartEl;
  let chart = null;
  let resizeObserver;

  // Track active channels and data for real-time append
  let activeChannels = [];
  let uData = null;

  // ── Data helpers ──────────────────────────────────────────

  function getActiveChannels(rows) {
    const seen = new Set();
    for (const row of rows) {
      if (row.value !== null && row.value !== 0) {
        seen.add(row.channel);
      }
    }
    // Always show air; show others only if they have data
    const active = TEMP_CHANNELS.filter(ch => ch === 'air' || seen.has(ch));
    // Always include state channels if they have any data
    for (const ch of STATE_CHANNELS) {
      if (seen.has(ch)) active.push(ch);
    }
    return active.length > 0 ? active : TEMP_CHANNELS;
  }

  function transformToUplot(rows, channels) {
    const timeMap = new Map();
    for (const row of rows) {
      if (!channels.includes(row.channel)) continue;
      const ts = Math.floor(new Date(row.time).getTime() / 1000);
      if (!timeMap.has(ts)) timeMap.set(ts, {});
      timeMap.get(ts)[row.channel] = row.value;
    }

    const sortedTimes = [...timeMap.keys()].sort((a, b) => a - b);
    if (sortedTimes.length === 0) return null;

    const data = [
      sortedTimes,
      ...channels.map(ch => sortedTimes.map(t => timeMap.get(t)?.[ch] ?? null)),
    ];

    return data;
  }

  // ── Band plugin for compressor/defrost ─────────────────────

  function bandPlugin(channels) {
    return {
      hooks: {
        drawSeries: [
          (u, si) => {
            const ch = channels[si - 1];
            const cfg = SERIES_CONFIG[ch];
            if (!cfg || !cfg.band) return;

            const ctx = u.ctx;
            const data = u.data[si];
            const xData = u.data[0];
            if (!data || !xData) return;

            const yScale = u.scales.y;
            const yMin = u.valToPos(yScale.min, 'y', true);
            const yMax = u.valToPos(yScale.max, 'y', true);

            ctx.save();
            ctx.fillStyle = cfg.fill;

            let inBand = false;
            let startX = 0;

            for (let i = 0; i < data.length; i++) {
              const val = data[i];
              const x = u.valToPos(xData[i], 'x', true);

              if (val >= 1 && !inBand) {
                inBand = true;
                startX = x;
              } else if ((val < 1 || val === null) && inBand) {
                inBand = false;
                ctx.fillRect(startX, yMax, x - startX, yMin - yMax);
              }
            }
            // Close open band
            if (inBand) {
              const lastX = u.valToPos(xData[xData.length - 1], 'x', true);
              ctx.fillRect(startX, yMax, lastX - startX, yMin - yMax);
            }

            ctx.restore();
          }
        ]
      }
    };
  }

  // ── Events overlay plugin ─────────────────────────────────
  const EVENT_COLORS = {
    device_online:   '#22c55e',
    device_offline:  '#ef4444',
    compressor_on:   'rgba(59,130,246,0.4)',
    compressor_off:  'rgba(59,130,246,0.4)',
    defrost_start:   'rgba(251,146,60,0.4)',
    defrost_end:     'rgba(251,146,60,0.4)',
  };

  function eventsPlugin(events) {
    return {
      hooks: {
        drawClear: [
          (u) => {
            if (!events || events.length === 0) return;
            const ctx = u.ctx;
            ctx.save();

            for (const ev of events) {
              const ts = Math.floor(new Date(ev.time).getTime() / 1000);
              const x = u.valToPos(ts, 'x', true);

              // Skip events outside visible range
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;

              const color = EVENT_COLORS[ev.event_type] || 'rgba(139,148,158,0.4)';

              ctx.strokeStyle = color;
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
            }

            ctx.setLineDash([]);
            ctx.restore();
          }
        ]
      }
    };
  }

  function createChart(data, channels) {
    if (chart) { chart.destroy(); chart = null; }
    if (!chartEl || !data) return;

    const width = chartEl.clientWidth;
    if (width < 50) return;

    const series = [
      {},  // x-axis
      ...channels.map(ch => {
        const cfg = SERIES_CONFIG[ch];
        if (cfg.band) {
          return {
            label:    cfg.label,
            stroke:   cfg.stroke,
            width:    0,
            fill:     cfg.fill,
            spanGaps: true,
            points:   { show: false },
            paths:    () => null,      // don't draw line — band plugin handles it
            scale:    'state',
          };
        }
        return {
          label:    cfg.label,
          stroke:   cfg.stroke,
          width:    cfg.width,
          dash:     cfg.dash,
          spanGaps: true,
          points:   { show: data[0].length < 100 },
        };
      }),
    ];

    const hasBands = channels.some(ch => SERIES_CONFIG[ch].band);

    const axes = [
      {
        stroke: 'rgba(139, 148, 158, 0.6)',
        grid: { stroke: 'rgba(48, 54, 61, 0.6)', width: 1 },
        font: '11px "IBM Plex Sans", system-ui',
        ticks: { stroke: 'rgba(48, 54, 61, 0.6)' },
      },
      {
        stroke: 'rgba(139, 148, 158, 0.6)',
        grid: { stroke: 'rgba(48, 54, 61, 0.6)', width: 1 },
        size: 55,
        label: '\u00B0C',
        font: '11px "IBM Plex Sans", system-ui',
        labelFont: 'bold 12px "IBM Plex Sans", system-ui',
        ticks: { stroke: 'rgba(48, 54, 61, 0.6)' },
      },
    ];

    // Hidden axis for state channels (0/1 scale)
    if (hasBands) {
      axes.push({
        scale: 'state',
        show: false,
      });
    }

    const scales = {
      x: { time: true },
      y: { auto: true },
    };
    if (hasBands) {
      scales.state = { auto: false, range: [0, 1] };
    }

    const opts = {
      width,
      height: 320,
      cursor: { show: true, drag: { x: true, y: false } },
      scales,
      axes,
      series,
      plugins: [bandPlugin(channels), eventsPlugin(deviceEvents)],
      legend: {
        show: true,
      },
    };

    chart = new uPlot(opts, data, chartEl);
  }

  // ── Load & render ─────────────────────────────────────────

  async function loadData() {
    loading = true;
    noData = false;
    try {
      const fromISO = new Date(range.from).toISOString();
      const toISO   = new Date(range.to).toISOString();

      const [rows, events] = await Promise.all([
        getTelemetry(deviceId, {
          from: fromISO,
          to: toISO,
          channels: ALL_CHANNELS,
        }),
        getDeviceEvents(deviceId, {
          from: fromISO,
          to: toISO,
          limit: 200,
        }).catch(() => []),  // Non-critical — don't block chart on events failure
      ]);

      deviceEvents = events;
      activeChannels = getActiveChannels(rows);
      uData = transformToUplot(rows, activeChannels);

      if (!uData) {
        noData = true;
        if (chart) { chart.destroy(); chart = null; }
      }
    } catch (e) {
      console.error('[TelemetryChart] Load failed:', e);
      noData = true;
      uData = null;
    } finally {
      loading = false;
    }

    if (uData) {
      await tick();
      createChart(uData, activeChannels);
    }
  }

  // ── Real-time updates from liveState ──────────────────────

  let liveUnsub;
  let lastAppendTs = 0;
  const APPEND_INTERVAL = 60;  // append at most every 60 seconds

  function handleLiveUpdate(state) {
    if (!chart || !uData || !activeChannels.length) return;

    const now = Math.floor(Date.now() / 1000);
    // Throttle: only append a new point every APPEND_INTERVAL seconds
    if (now - lastAppendTs < APPEND_INTERVAL) return;

    // Check if we have any temperature data to append
    let hasData = false;
    const newPoint = {};
    for (const [stateKey, ch] of Object.entries(LIVE_KEY_MAP)) {
      if (!activeChannels.includes(ch)) continue;
      const val = state[stateKey];
      if (val !== undefined) {
        const isBool = SERIES_CONFIG[ch]?.band;
        newPoint[ch] = isBool ? (val ? 1 : 0) : (typeof val === 'number' ? val : null);
        if (newPoint[ch] !== null) hasData = true;
      }
    }

    if (!hasData) return;
    lastAppendTs = now;

    // Append new data point
    const newData = uData.map((arr, i) => {
      if (i === 0) return [...arr, now];
      const ch = activeChannels[i - 1];
      return [...arr, newPoint[ch] ?? null];
    });

    uData = newData;

    try {
      chart.setData(uData);
    } catch {
      // uPlot might throw if chart was destroyed during async
    }
  }

  // ── UI actions ────────────────────────────────────────────

  function applyPreset(preset) {
    range = initRange(preset.hours);
    activePreset = preset.label;
    loadData();
  }

  function applyCustomRange() {
    if (!range.from || !range.to) return;
    const f = new Date(range.from);
    const t = new Date(range.to);
    if (f >= t) return;
    const maxMs = 31 * 24 * 3600 * 1000;
    if (t - f > maxMs) {
      range.from = toLocalInput(new Date(t.getTime() - maxMs));
    }
    activePreset = null;
    loadData();
  }

  function handleDateChange() {
    activePreset = null;
  }

  let exporting = false;

  async function handleExportCsv() {
    exporting = true;
    try {
      const fromISO = new Date(range.from).toISOString();
      const toISO   = new Date(range.to).toISOString();
      await exportTelemetryCsv(deviceId, fromISO, toISO);
      toast.success($t('export.export_success'));
    } catch (e) {
      toast.error(e.message || $t('export.export_error'));
    } finally {
      exporting = false;
    }
  }

  async function handleExportPdf() {
    exporting = true;
    try {
      const fromISO = new Date(range.from).toISOString();
      const toISO   = new Date(range.to).toISOString();
      await exportTelemetryPdf(deviceId, fromISO, toISO);
      toast.success($t('export.export_success'));
    } catch (e) {
      toast.error(e.message || $t('export.export_error'));
    } finally {
      exporting = false;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  onMount(() => {
    loadData();

    resizeObserver = new ResizeObserver(() => {
      if (chart && chartEl) {
        const w = chartEl.clientWidth;
        if (w > 50) {
          chart.setSize({ width: w, height: 320 });
        }
      }
    });
    resizeObserver.observe(chartEl);

    // Subscribe to live state for real-time chart updates
    liveUnsub = liveState.subscribe(handleLiveUpdate);
  });

  onDestroy(() => {
    if (chart) chart.destroy();
    if (resizeObserver) resizeObserver.disconnect();
    if (liveUnsub) liveUnsub();
  });
</script>

<div class="telemetry-chart">
  <div class="chart-header">
    <h3>Temperature History</h3>
    <div class="presets">
      {#each PRESETS as preset}
        <button
          class:active={activePreset === preset.label}
          on:click={() => applyPreset(preset)}
          disabled={loading}
        >{preset.label}</button>
      {/each}
    </div>
  </div>

  <div class="range-picker">
    <label>
      <span>From</span>
      <input
        type="datetime-local"
        bind:value={range.from}
        on:change={handleDateChange}
        disabled={loading}
      />
    </label>
    <label>
      <span>To</span>
      <input
        type="datetime-local"
        bind:value={range.to}
        on:change={handleDateChange}
        disabled={loading}
      />
    </label>
    <button class="btn-apply" on:click={applyCustomRange} disabled={loading}>
      Apply
    </button>
    <div class="export-buttons">
      <button class="btn-export" on:click={handleExportCsv} disabled={exporting || loading} title={$t('export.export_csv')}>
        CSV
      </button>
      <button class="btn-export btn-export-pdf" on:click={handleExportPdf} disabled={exporting || loading} title={$t('export.export_pdf')}>
        {exporting ? $t('export.exporting') : 'PDF'}
      </button>
    </div>
  </div>

  <div class="chart-wrap">
    <div class="chart-container" bind:this={chartEl}></div>
    {#if loading}
      <div class="chart-overlay">Loading...</div>
    {:else if noData}
      <div class="chart-overlay">No telemetry data for this period</div>
    {/if}
  </div>

  <!-- Event log toggle -->
  {#if deviceEvents.length > 0}
    <button class="event-log-toggle" on:click={() => showEventLog = !showEventLog}>
      {showEventLog ? '▾' : '▸'}
      {$t('event.history')} ({deviceEvents.length})
    </button>

    {#if showEventLog}
      <div class="event-log">
        <table class="event-table">
          <thead>
            <tr>
              <th>{$t('event.col_time')}</th>
              <th>{$t('event.col_type')}</th>
            </tr>
          </thead>
          <tbody>
            {#each deviceEvents as ev (ev.id)}
              <tr>
                <td class="event-time">{new Date(ev.time).toLocaleString()}</td>
                <td>
                  <span class="event-badge" class:ev-online={ev.event_type === 'device_online'}
                    class:ev-offline={ev.event_type === 'device_offline'}
                    class:ev-comp={ev.event_type.startsWith('compressor')}
                    class:ev-defrost={ev.event_type.startsWith('defrost')}
                  >
                    {$t(`event.type_${ev.event_type}`, ev.event_type)}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .telemetry-chart {
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    border: 1px solid var(--border-default);
  }

  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  h3 {
    font-size: var(--text-base);
    color: var(--text-primary);
    font-weight: 600;
    margin: 0;
  }

  .presets {
    display: flex;
    gap: var(--space-1);
  }

  .presets button {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    font-size: var(--text-xs);
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .presets button:hover { background: var(--bg-hover); color: var(--text-primary); }

  .presets button.active {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .presets button:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Range picker row ─────────────────────────── */

  .range-picker {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  .range-picker label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .range-picker span {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .range-picker input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
    color-scheme: dark;
  }

  .range-picker input:focus {
    border-color: var(--accent-blue);
  }

  .range-picker input:disabled {
    opacity: 0.5;
  }

  .btn-apply {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--accent-blue);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--accent-blue);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-apply:hover {
    background: var(--accent-blue);
    color: #fff;
  }

  .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }

  .export-buttons {
    display: flex;
    gap: var(--space-1);
    margin-left: auto;
  }

  .btn-export {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-export:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-export-pdf {
    border-color: var(--accent-green, #22c55e);
    color: var(--accent-green, #22c55e);
  }

  .btn-export-pdf:hover:not(:disabled) {
    background: var(--accent-green, #22c55e);
    color: #fff;
  }

  .btn-export:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Chart area ───────────────────────────────── */

  .chart-wrap {
    position: relative;
    min-height: 320px;
  }

  .chart-container {
    width: 100%;
  }

  .chart-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    background: rgba(13, 17, 23, 0.7);
    z-index: 1;
  }

  .telemetry-chart :global(.u-legend) {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    padding: 0.25rem 0;
  }

  .telemetry-chart :global(.u-legend .u-label) {
    color: var(--text-secondary);
  }

  .telemetry-chart :global(.u-legend .u-value) {
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  /* Override uPlot cursor tooltip */
  .telemetry-chart :global(.u-cursor-pt) {
    border-color: var(--accent-blue) !important;
  }

  /* ── Event log ─────────────────────────────── */

  .event-log-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: color 0.2s;
  }

  .event-log-toggle:hover {
    color: var(--text-primary);
  }

  .event-log {
    margin-top: var(--space-2);
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
  }

  .event-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .event-table th {
    position: sticky;
    top: 0;
    background: var(--bg-tertiary);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 1px solid var(--border-default);
  }

  .event-table td {
    padding: var(--space-1) var(--space-3);
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-secondary);
  }

  .event-table tbody tr:hover {
    background: var(--bg-hover);
  }

  .event-time {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .event-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .ev-online {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .ev-offline {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .ev-comp {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
  }

  .ev-defrost {
    background: rgba(251, 146, 60, 0.15);
    color: #fb923c;
  }
</style>
