<script>
  import { onMount } from 'svelte';
  import { getDeviceAlarms, getAlarms } from '../lib/api.js';

  export let deviceId = null;
  export let limit = 20;

  const ALARM_LABELS = {
    high_temp_alarm:     'High Temperature',
    low_temp_alarm:      'Low Temperature',
    sensor1_alarm:       'Sensor 1 Failure',
    sensor2_alarm:       'Sensor 2 Failure',
    door_alarm:          'Door Open',
    short_cycle_alarm:   'Short Cycle',
    rapid_cycle_alarm:   'Rapid Cycling',
    continuous_run_alarm:'Continuous Run',
    pulldown_alarm:      'Pulldown Timeout',
    rate_alarm:          'Rate of Change',
  };

  let alarms = [];
  let loading = true;
  let error = '';

  function alarmLabel(code) {
    return ALARM_LABELS[code] || code;
  }

  function formatTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function duration(triggered, cleared) {
    if (!cleared) return null;
    const ms = new Date(cleared) - new Date(triggered);
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  onMount(async () => {
    loading = true;
    try {
      if (deviceId) {
        alarms = await getDeviceAlarms(deviceId, { limit });
      } else {
        alarms = await getAlarms({ limit });
      }
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  });
</script>

<div class="alarm-history">
  <h3>Alarm History</h3>

  {#if loading}
    <p class="muted">Loading...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if alarms.length === 0}
    <p class="muted">No alarms recorded</p>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>Time</th>
          {#if !deviceId}<th>Device</th>{/if}
          <th>Alarm</th>
          <th>Severity</th>
          <th>Duration</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {#each alarms as alarm}
          <tr>
            <td>{formatTime(alarm.triggered_at)}</td>
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
                <span class="status-active">Active</span>
              {:else}
                <span class="status-cleared">Cleared</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .alarm-history {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
  }

  h3 {
    font-size: 1rem;
    color: #2d3436;
    margin: 0 0 1rem;
  }

  .muted { color: #636e72; font-size: 0.9rem; }
  .error { color: #d63031; font-size: 0.9rem; }

  .table {
    width: 100%;
    border-collapse: collapse;
  }

  .table th {
    text-align: left;
    padding: 0.5rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #636e72;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 2px solid #f1f2f6;
  }

  .table td {
    padding: 0.5rem 0.6rem;
    font-size: 0.82rem;
    border-bottom: 1px solid #f1f2f6;
  }

  .badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-critical { background: #ffeaea; color: #d63031; }
  .badge-warning  { background: #fff3e0; color: #e17055; }

  .status-active {
    color: #d63031;
    font-weight: 600;
    font-size: 0.8rem;
  }

  .status-cleared {
    color: #636e72;
    font-size: 0.8rem;
  }
</style>
