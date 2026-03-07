<script>
  import { onMount, onDestroy } from 'svelte';
  import { getDevice, sendCommand as apiSendCommand } from '../lib/api.js';
  import { subscribe, unsubscribe, on } from '../lib/ws.js';
  import { navigate, liveState } from '../lib/stores.js';
  import StateView from '../components/StateView.svelte';
  import AlarmBadge from '../components/AlarmBadge.svelte';

  export let deviceId;

  /** Writable keys grouped by category for the command dropdown */
  const COMMAND_KEYS = [
    { group: 'Thermostat', keys: [
      'thermostat.setpoint', 'thermostat.differential', 'thermostat.min_off_time',
      'thermostat.min_on_time', 'thermostat.startup_delay', 'thermostat.evap_fan_mode',
      'thermostat.fan_stop_temp', 'thermostat.fan_stop_hyst', 'thermostat.cond_fan_delay',
      'thermostat.safety_run_on', 'thermostat.safety_run_off', 'thermostat.night_setback',
      'thermostat.night_mode', 'thermostat.night_start', 'thermostat.night_end',
      'thermostat.night_active', 'thermostat.display_defrost',
    ]},
    { group: 'Protection', keys: [
      'protection.high_limit', 'protection.low_limit', 'protection.high_alarm_delay',
      'protection.low_alarm_delay', 'protection.door_delay', 'protection.manual_reset',
      'protection.post_defrost_delay', 'protection.reset_alarms',
      'protection.min_compressor_run', 'protection.max_starts_hour',
      'protection.max_continuous_run', 'protection.pulldown_timeout',
      'protection.pulldown_min_drop', 'protection.max_rise_rate', 'protection.rate_duration',
      'protection.compressor_hours',
    ]},
    { group: 'Defrost', keys: [
      'defrost.manual_start', 'defrost.manual_stop', 'defrost.type', 'defrost.interval',
      'defrost.counter_mode', 'defrost.initiation', 'defrost.termination',
      'defrost.end_temp', 'defrost.max_duration', 'defrost.demand_temp',
      'defrost.drip_time', 'defrost.fan_delay', 'defrost.fad_temp',
      'defrost.stabilize_time', 'defrost.valve_delay', 'defrost.equalize_time',
    ]},
    { group: 'Equipment', keys: [
      'equipment.filter_coeff', 'equipment.ntc_beta', 'equipment.ntc_r_series',
      'equipment.ntc_r_nominal', 'equipment.ds18b20_offset',
    ]},
    { group: 'Datalogger', keys: [
      'datalogger.enabled', 'datalogger.retention_hours', 'datalogger.sample_interval',
      'datalogger.log_evap', 'datalogger.log_cond', 'datalogger.log_setpoint',
      'datalogger.log_humidity',
    ]},
  ];

  let device = null;
  let loading = true;
  let error = null;
  let commandKey = 'thermostat.setpoint';
  let commandValue = '';
  let commandStatus = '';
  let sending = false;

  // WS listener unsubscribers
  let unsubs = [];

  async function loadDevice() {
    try {
      device = await getDevice(deviceId);
      liveState.set(device.last_state || {});
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function setupWs() {
    subscribe(deviceId);

    unsubs.push(on('state_full', (msg) => {
      if (msg.device_id === deviceId) {
        liveState.set(msg.state || {});
      }
    }));

    unsubs.push(on('state_update', (msg) => {
      if (msg.device_id === deviceId) {
        liveState.update(s => ({ ...s, ...msg.changes }));
      }
    }));

    unsubs.push(on('device_online', (msg) => {
      if (msg.device_id === deviceId && device) {
        device = { ...device, online: true };
      }
    }));

    unsubs.push(on('device_offline', (msg) => {
      if (msg.device_id === deviceId && device) {
        device = { ...device, online: false };
      }
    }));
  }

  async function handleCommand() {
    if (!commandKey) {
      commandStatus = 'Select a parameter';
      return;
    }
    if (commandValue === '') {
      commandStatus = 'Enter a value';
      return;
    }
    sending = true;
    commandStatus = 'Sending...';
    try {
      await apiSendCommand(deviceId, commandKey, parseCommandValue(commandValue));
      commandStatus = 'Sent!';
      setTimeout(() => { commandStatus = ''; }, 3000);
    } catch (e) {
      commandStatus = `Error: ${e.message}`;
    } finally {
      sending = false;
    }
  }

  function parseCommandValue(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    const n = Number(v);
    if (v !== '' && !isNaN(n)) return n;
    return v;
  }

  onMount(() => {
    loadDevice();
    setupWs();
  });

  onDestroy(() => {
    unsubscribe(deviceId);
    for (const fn of unsubs) fn();
  });
</script>

<div class="detail">
  <div class="breadcrumb">
    <a href="#/" on:click|preventDefault={() => navigate('/')}>Dashboard</a>
    <span>/</span>
    <span>{deviceId}</span>
  </div>

  {#if loading}
    <p class="status-msg">Loading...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else if device}
    <div class="device-header">
      <div class="device-info">
        <h1>
          <span class="status-dot" class:online={device.online}></span>
          {device.name || device.mqtt_device_id}
        </h1>
        <div class="meta">
          <span>ID: {device.mqtt_device_id}</span>
          {#if device.firmware_version}
            <span>FW: {device.firmware_version}</span>
          {/if}
          {#if device.location}
            <span>{device.location}</span>
          {/if}
          <span class="status-badge" class:online={device.online}>
            {device.online ? 'Online' : 'Offline'}
          </span>
          <AlarmBadge active={!!$liveState['protection.alarm_active']} />
        </div>
      </div>
    </div>

    <!-- Command panel -->
    <div class="command-panel">
      <h3>Send Command</h3>
      <form on:submit|preventDefault={handleCommand} class="command-form">
        <select bind:value={commandKey} class="input select-key">
          {#each COMMAND_KEYS as group}
            <optgroup label={group.group}>
              {#each group.keys as key}
                <option value={key}>{key}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <input
          type="text"
          bind:value={commandValue}
          placeholder="value"
          class="input input-value"
        />
        <button type="submit" class="btn" disabled={sending}>
          {sending ? 'Sending...' : 'Send'}
        </button>
        {#if commandStatus}
          <span class="command-status" class:error={commandStatus.startsWith('Error')}
                class:success={commandStatus === 'Sent!'}>
            {commandStatus}
          </span>
        {/if}
      </form>
    </div>

    <!-- Live state -->
    <div class="state-section">
      <h2>Live State</h2>
      <StateView state={$liveState} />
    </div>
  {/if}
</div>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .breadcrumb {
    font-size: 0.85rem;
    color: #636e72;
    display: flex;
    gap: 0.5rem;
  }

  .breadcrumb a {
    color: #0984e3;
    text-decoration: none;
  }

  .device-header {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
  }

  h1 {
    font-size: 1.4rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #b2bec3;
    display: inline-block;
  }

  .status-dot.online {
    background: #00b894;
    box-shadow: 0 0 6px #00b894;
  }

  .meta {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #636e72;
  }

  .status-badge {
    padding: 0.1rem 0.5rem;
    border-radius: 4px;
    background: #dfe6e9;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
  }

  .status-badge.online {
    background: #00b89433;
    color: #00b894;
  }

  .command-panel {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
  }

  .command-panel h3 {
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
    color: #636e72;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .command-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .input {
    padding: 0.5rem 0.75rem;
    border: 1px solid #dfe6e9;
    border-radius: 6px;
    font-size: 0.9rem;
    font-family: 'SF Mono', 'Consolas', monospace;
  }

  .input:focus {
    outline: none;
    border-color: #0984e3;
  }

  .select-key {
    min-width: 220px;
    cursor: pointer;
  }

  .input-value {
    width: 100px;
  }

  .btn {
    padding: 0.5rem 1rem;
    background: #0984e3;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .btn:hover {
    background: #0873c4;
  }

  .command-status {
    font-size: 0.85rem;
    color: #636e72;
    font-weight: 600;
  }

  .command-status.success {
    color: #00b894;
  }

  .command-status.error {
    color: #e17055;
  }

  .state-section {
    background: white;
    border-radius: 12px;
    padding: 1.25rem;
    border: 1px solid #dfe6e9;
  }

  .state-section h2 {
    font-size: 1.1rem;
    margin-bottom: 1rem;
  }

  .status-msg {
    text-align: center;
    color: #636e72;
    padding: 2rem;
  }

  .status-msg.error {
    color: #e17055;
  }
</style>
