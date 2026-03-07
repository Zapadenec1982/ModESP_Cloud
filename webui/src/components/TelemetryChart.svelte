<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { getTelemetry } from '../lib/api.js';

  export let deviceId;

  const CHANNELS = ['air', 'evap', 'cond', 'setpoint'];

  const PRESETS = [
    { label: '24h', hours: 24 },
    { label: '7d',  hours: 168 },
    { label: '30d', hours: 720 },
  ];

  const SERIES_CONFIG = {
    air:      { label: 'Air',        stroke: '#0984e3', width: 2 },
    evap:     { label: 'Evaporator', stroke: '#00b894', width: 2 },
    cond:     { label: 'Condenser',  stroke: '#e17055', width: 2 },
    setpoint: { label: 'Setpoint',   stroke: '#fdcb6e', width: 2, dash: [5, 5] },
  };

  // ── Date range state ─────────────────────────────────────
  // datetime-local inputs use "YYYY-MM-DDThh:mm" format (no seconds, no TZ)

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

  // ── Data helpers ──────────────────────────────────────────

  function getActiveChannels(rows) {
    const seen = new Set();
    for (const row of rows) {
      if (row.value !== null && row.value !== 0) {
        seen.add(row.channel);
      }
    }
    const active = CHANNELS.filter(ch => ch === 'air' || seen.has(ch));
    return active.length > 0 ? active : CHANNELS;
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

    return { data, channels };
  }

  function createChart(uData, channels) {
    if (chart) { chart.destroy(); chart = null; }
    if (!chartEl || !uData) return;

    const width = chartEl.clientWidth;
    if (width < 50) return;

    const opts = {
      width,
      height: 300,
      cursor: { show: true, drag: { x: true, y: false } },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: '#636e72',
          grid: { stroke: '#f1f2f6' },
          font: '11px system-ui',
          ticks: { stroke: '#f1f2f6' },
        },
        {
          stroke: '#636e72',
          grid: { stroke: '#f1f2f6' },
          size: 55,
          label: '\u00B0C',
          font: '11px system-ui',
          labelFont: 'bold 12px system-ui',
          ticks: { stroke: '#f1f2f6' },
        },
      ],
      series: [
        {},
        ...channels.map(ch => ({
          label:    SERIES_CONFIG[ch].label,
          stroke:   SERIES_CONFIG[ch].stroke,
          width:    SERIES_CONFIG[ch].width,
          dash:     SERIES_CONFIG[ch].dash,
          spanGaps: true,
          points:   { show: uData[0].length < 100 },
        })),
      ],
    };

    chart = new uPlot(opts, uData, chartEl);
  }

  // ── Load & render ─────────────────────────────────────────

  let lastData = null;
  let lastChannels = null;

  async function loadData() {
    loading = true;
    noData = false;
    try {
      const fromISO = new Date(range.from).toISOString();
      const toISO   = new Date(range.to).toISOString();

      const rows = await getTelemetry(deviceId, {
        from: fromISO,
        to: toISO,
        channels: CHANNELS,
      });

      const activeChannels = getActiveChannels(rows);
      const result = transformToUplot(rows, activeChannels);

      if (!result) {
        noData = true;
        lastData = null;
        lastChannels = null;
        if (chart) { chart.destroy(); chart = null; }
      } else {
        lastData = result.data;
        lastChannels = result.channels;
      }
    } catch (e) {
      console.error('[TelemetryChart] Load failed:', e);
      noData = true;
      lastData = null;
      lastChannels = null;
    } finally {
      loading = false;
    }

    if (lastData) {
      await tick();
      createChart(lastData, lastChannels);
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
    // Validate: from < to, max 31 days
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
    // Deselect preset when user manually changes dates
    activePreset = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  onMount(() => {
    loadData();

    resizeObserver = new ResizeObserver(() => {
      if (chart && chartEl) {
        const w = chartEl.clientWidth;
        if (w > 50) {
          chart.setSize({ width: w, height: 300 });
        }
      }
    });
    resizeObserver.observe(chartEl);
  });

  onDestroy(() => {
    if (chart) chart.destroy();
    if (resizeObserver) resizeObserver.disconnect();
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
  </div>

  <div class="chart-wrap">
    <div class="chart-container" bind:this={chartEl}></div>
    {#if loading}
      <div class="chart-overlay">Loading...</div>
    {:else if noData}
      <div class="chart-overlay">No telemetry data for this period</div>
    {/if}
  </div>
</div>

<style>
  .telemetry-chart {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
  }

  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  h3 {
    font-size: 1rem;
    color: #2d3436;
    margin: 0;
  }

  .presets {
    display: flex;
    gap: 0.25rem;
  }

  .presets button {
    padding: 0.3rem 0.6rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    background: white;
    font-size: 0.75rem;
    cursor: pointer;
    color: #636e72;
    transition: all 0.2s;
  }

  .presets button:hover { background: #f8f9fa; }

  .presets button.active {
    background: #0984e3;
    color: white;
    border-color: #0984e3;
  }

  .presets button:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Range picker row ─────────────────────────── */

  .range-picker {
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .range-picker label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .range-picker span {
    font-size: 0.7rem;
    color: #636e72;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .range-picker input {
    padding: 0.35rem 0.5rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    font-size: 0.8rem;
    color: #2d3436;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
  }

  .range-picker input:focus {
    border-color: #0984e3;
  }

  .range-picker input:disabled {
    opacity: 0.5;
  }

  .btn-apply {
    padding: 0.4rem 0.8rem;
    border: 1px solid #0984e3;
    border-radius: 4px;
    background: white;
    color: #0984e3;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-apply:hover {
    background: #0984e3;
    color: white;
  }

  .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Chart area ───────────────────────────────── */

  .chart-wrap {
    position: relative;
    min-height: 300px;
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
    color: #636e72;
    font-size: 0.9rem;
    background: rgba(255, 255, 255, 0.8);
    z-index: 1;
  }

  .telemetry-chart :global(.u-legend) {
    font-size: 0.8rem;
    padding: 0.25rem 0;
  }
</style>
