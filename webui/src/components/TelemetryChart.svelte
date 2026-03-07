<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { getTelemetry } from '../lib/api.js';

  export let deviceId;

  const CHANNELS = ['air', 'evap', 'cond', 'setpoint'];
  const RANGES = [
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

  let selectedRange = RANGES[0];
  let loading = false;
  let noData = false;
  let chartEl;
  let chart = null;
  let resizeObserver;

  /**
   * Determine which channels actually have data (non-null, non-zero values).
   */
  function getActiveChannels(rows) {
    const seen = new Set();
    for (const row of rows) {
      if (row.value !== null && row.value !== 0) {
        seen.add(row.channel);
      }
    }
    // Always include air; include others only if they have real data
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
    if (width < 50) return; // DOM not ready

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
          label: '°C',
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

  // Store last fetched data for resize recreation
  let lastData = null;
  let lastChannels = null;

  async function loadData() {
    loading = true;
    noData = false;
    try {
      const rows = await getTelemetry(deviceId, {
        hours: selectedRange.hours,
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

    // Wait for Svelte to remove the loading overlay, then create chart
    if (lastData) {
      await tick();
      createChart(lastData, lastChannels);
    }
  }

  function selectRange(range) {
    selectedRange = range;
    loadData();
  }

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
    <div class="range-buttons">
      {#each RANGES as range}
        <button
          class:active={selectedRange === range}
          on:click={() => selectRange(range)}
          disabled={loading}
        >{range.label}</button>
      {/each}
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
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 1rem;
    color: #2d3436;
    margin: 0;
  }

  .range-buttons {
    display: flex;
    gap: 0.25rem;
  }

  .range-buttons button {
    padding: 0.3rem 0.6rem;
    border: 1px solid #dfe6e9;
    border-radius: 4px;
    background: white;
    font-size: 0.75rem;
    cursor: pointer;
    color: #636e72;
    transition: all 0.2s;
  }

  .range-buttons button:hover { background: #f8f9fa; }

  .range-buttons button.active {
    background: #0984e3;
    color: white;
    border-color: #0984e3;
  }

  .range-buttons button:disabled { opacity: 0.5; cursor: not-allowed; }

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
