<script>
  import { onMount, onDestroy } from 'svelte';
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
    air:      { label: 'Air',      stroke: '#0984e3', width: 2 },
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

  function transformToUplot(rows) {
    const timeMap = new Map();
    for (const row of rows) {
      const ts = Math.floor(new Date(row.time).getTime() / 1000);
      if (!timeMap.has(ts)) timeMap.set(ts, {});
      timeMap.get(ts)[row.channel] = row.value;
    }

    const sortedTimes = [...timeMap.keys()].sort((a, b) => a - b);
    if (sortedTimes.length === 0) return null;

    const data = [
      sortedTimes,
      ...CHANNELS.map(ch => sortedTimes.map(t => timeMap.get(t)?.[ch] ?? null)),
    ];

    return data;
  }

  function createChart(data) {
    if (chart) { chart.destroy(); chart = null; }
    if (!chartEl || !data) return;

    const width = chartEl.clientWidth || 600;

    const opts = {
      width,
      height: 300,
      cursor: { show: true, drag: { x: true, y: false } },
      scales: { x: { time: true } },
      axes: [
        { stroke: '#636e72', grid: { stroke: '#f1f2f6' } },
        { stroke: '#636e72', grid: { stroke: '#f1f2f6' }, size: 55, label: '°C' },
      ],
      series: [
        {},
        ...CHANNELS.map(ch => ({
          label:  SERIES_CONFIG[ch].label,
          stroke: SERIES_CONFIG[ch].stroke,
          width:  SERIES_CONFIG[ch].width,
          dash:   SERIES_CONFIG[ch].dash,
          spanGaps: true,
        })),
      ],
    };

    chart = new uPlot(opts, data, chartEl);
  }

  async function loadData() {
    loading = true;
    noData = false;
    try {
      const rows = await getTelemetry(deviceId, {
        hours: selectedRange.hours,
        channels: CHANNELS,
      });
      const data = transformToUplot(rows);
      if (!data) {
        noData = true;
        if (chart) { chart.destroy(); chart = null; }
      } else {
        createChart(data);
      }
    } catch (e) {
      console.error('[TelemetryChart] Load failed:', e);
      noData = true;
    } finally {
      loading = false;
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
        chart.setSize({ width: chartEl.clientWidth, height: 300 });
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

  <div class="chart-container" bind:this={chartEl}>
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

  .chart-container {
    position: relative;
    min-height: 300px;
    overflow: hidden;
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
  }

  /* uPlot global overrides */
  .telemetry-chart :global(.u-wrap) {
    width: 100% !important;
  }

  .telemetry-chart :global(.u-legend) {
    font-size: 0.8rem;
    padding: 0.25rem 0;
  }
</style>
