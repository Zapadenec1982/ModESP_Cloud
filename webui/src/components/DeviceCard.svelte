<script>
  import AlarmBadge from './AlarmBadge.svelte';
  import { navigate } from '../lib/stores.js';

  export let device;

  $: online = device.online;
  $: temp = device.air_temp != null ? device.air_temp.toFixed(1) : '--';
  $: statusLabel = device.status === 'pending' ? 'pending' : (online ? 'online' : 'offline');

  function handleClick() {
    navigate(`/device/${device.mqtt_device_id}`);
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
</script>

<button class="card" on:click={handleClick}>
  <div class="card-header">
    <div class="status-dot" class:online class:offline={!online}></div>
    <span class="device-name">{device.name || device.mqtt_device_id}</span>
    <AlarmBadge active={device.alarm_active} />
  </div>

  <div class="card-body">
    <div class="temp">{temp}<span class="unit">°C</span></div>
    <div class="meta">
      <span class="status-label">{statusLabel}</span>
      <span class="last-seen">{timeAgo(device.last_seen)}</span>
    </div>
  </div>

  {#if device.location}
    <div class="card-footer">{device.location}</div>
  {/if}
</button>

<style>
  .card {
    all: unset;
    cursor: pointer;
    background: white;
    border: 1px solid #dfe6e9;
    border-radius: 12px;
    padding: 1rem;
    transition: box-shadow 0.2s, transform 0.15s;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .card:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    transform: translateY(-2px);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.online {
    background: #00b894;
    box-shadow: 0 0 6px #00b894;
  }

  .status-dot.offline {
    background: #b2bec3;
  }

  .device-name {
    font-weight: 600;
    font-size: 0.95rem;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-body {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
  }

  .temp {
    font-size: 2rem;
    font-weight: 300;
    line-height: 1;
    color: #2d3436;
  }

  .unit {
    font-size: 1rem;
    color: #636e72;
  }

  .meta {
    text-align: right;
    font-size: 0.8rem;
    color: #636e72;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .status-label {
    text-transform: uppercase;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.05em;
  }

  .card-footer {
    font-size: 0.8rem;
    color: #636e72;
    border-top: 1px solid #f0f0f0;
    padding-top: 0.5rem;
  }
</style>
