'use strict';

const mqttSvc = require('./mqtt');
const db      = require('./db');

let logger;

/** @type {Map<string, { send: Function }>}  channel name → handler */
const channels = new Map();

/** @type {Map<string, number>}  "deviceId:alarmCode" → last notification timestamp */
const debounceMap = new Map();
const DEBOUNCE_MS = 5000;  // 5 s cooldown per device+alarm

// ── Public API ─────────────────────────────────────────────

/**
 * Register a notification channel handler.
 * @param {string} name    e.g. 'telegram', 'fcm'
 * @param {{ send: (address: string, payload: object) => Promise<void> }} handler
 */
function registerChannel(name, handler) {
  channels.set(name, handler);
}

/**
 * Start push service — listen for alarm events from MQTT.
 * @param {import('pino').Logger} log
 */
function start(log) {
  logger = log.child({ svc: 'push' });

  if (channels.size === 0) {
    logger.info('Push: no channels registered — notifications disabled');
    return;
  }

  logger.info(
    { channels: Array.from(channels.keys()) },
    'Push service started'
  );

  mqttSvc.on('alarm', handleAlarm);
}

/** Cleanup */
function shutdown() {
  mqttSvc.off('alarm', handleAlarm);
  debounceMap.clear();
}

// ── Internal ───────────────────────────────────────────────

/**
 * Handle alarm event from MQTT.
 * @param {{ tenantSlug: string, deviceId: string, alarmCode: string, active: boolean, severity: string }} evt
 */
async function handleAlarm(evt) {
  try {
    // Only notify on alarm raise, not clear
    if (!evt.active) return;

    // Debounce: skip if same device+alarm notified recently
    const debounceKey = `${evt.deviceId}:${evt.alarmCode}`;
    const now = Date.now();
    const lastNotified = debounceMap.get(debounceKey) || 0;
    if (now - lastNotified < DEBOUNCE_MS) {
      logger.debug({ debounceKey }, 'Push debounced — skipping');
      return;
    }
    debounceMap.set(debounceKey, now);

    // Resolve tenant slug → tenant ID
    const tenantId = await resolveTenantId(evt.tenantSlug);
    if (!tenantId) {
      logger.warn({ tenantSlug: evt.tenantSlug }, 'Push: unknown tenant — skipping');
      return;
    }

    // Get active subscribers for this tenant
    const subscribers = await getSubscribers(tenantId, evt.deviceId);
    if (subscribers.length === 0) {
      logger.debug({ tenantId, deviceId: evt.deviceId }, 'No subscribers — skipping push');
      return;
    }

    // Build notification payload
    const payload = buildPayload(evt);

    // Dispatch to each subscriber
    for (const sub of subscribers) {
      const handler = channels.get(sub.channel);
      if (!handler) continue;

      try {
        await handler.send(sub.address, payload);
        await logDelivery(tenantId, sub.id, sub.channel, evt.deviceId, evt.alarmCode, 'sent');
        logger.info({ channel: sub.channel, deviceId: evt.deviceId, alarmCode: evt.alarmCode }, 'Push sent');
      } catch (err) {
        await logDelivery(tenantId, sub.id, sub.channel, evt.deviceId, evt.alarmCode, 'failed', err.message);
        logger.error({ err, channel: sub.channel, subscriberId: sub.id }, 'Push send failed');
      }
    }
  } catch (err) {
    logger.error({ err, evt }, 'Push handleAlarm error');
  }
}

/**
 * Resolve tenant slug to UUID.
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
async function resolveTenantId(slug) {
  const { rows } = await db.query(
    'SELECT id FROM tenants WHERE slug = $1 AND active = true',
    [slug]
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Get active subscribers for a tenant, optionally filtered by device.
 * @param {string} tenantId
 * @param {string} deviceId  mqtt_device_id
 * @returns {Promise<Array>}
 */
async function getSubscribers(tenantId, deviceId) {
  // Get device UUID for device_filter matching
  const devResult = await db.query(
    'SELECT id FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2',
    [tenantId, deviceId]
  );
  const deviceUuid = devResult.rows.length ? devResult.rows[0].id : null;

  // Fetch all active subscribers for this tenant
  const { rows } = await db.query(
    `SELECT id, channel, address, label, device_filter
     FROM notification_subscribers
     WHERE tenant_id = $1 AND active = true`,
    [tenantId]
  );

  // Filter: if subscriber has device_filter set, check if device is in the list
  return rows.filter(sub => {
    if (!sub.device_filter || sub.device_filter.length === 0) return true;
    return deviceUuid && sub.device_filter.includes(deviceUuid);
  });
}

/**
 * Build notification payload from alarm event.
 * @param {{ tenantSlug: string, deviceId: string, alarmCode: string, active: boolean, severity: string }} evt
 * @returns {object}
 */
function buildPayload(evt) {
  // Try to get live state for context (temperature etc.)
  const state = mqttSvc.getDeviceState(evt.deviceId) || {};
  const meta  = mqttSvc.getDeviceMeta(evt.deviceId) || {};

  return {
    deviceId:    evt.deviceId,
    alarmCode:   evt.alarmCode,
    severity:    evt.severity,
    active:      evt.active,
    airTemp:     state['equipment.air_temp'],
    evapTemp:    state['equipment.evap_temp'],
    deviceName:  null,  // will be enriched per-channel from DB if needed
    timestamp:   new Date().toISOString(),
  };
}

/**
 * Log notification delivery attempt.
 */
async function logDelivery(tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage) {
  try {
    await db.query(
      `INSERT INTO notification_log (tenant_id, subscriber_id, channel, device_id, alarm_code, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage || null]
    );
  } catch (err) {
    // Don't let logging failures cascade
    if (logger) logger.error({ err }, 'Failed to log notification delivery');
  }
}

/**
 * Send a test notification to a specific subscriber.
 * @param {string} tenantId
 * @param {string} subscriberId
 * @returns {Promise<{status: string, error?: string}>}
 */
async function testSend(tenantId, subscriberId) {
  const { rows } = await db.query(
    'SELECT id, channel, address FROM notification_subscribers WHERE id = $1 AND tenant_id = $2 AND active = true',
    [subscriberId, tenantId]
  );
  if (!rows.length) throw new Error('Subscriber not found');

  const sub = rows[0];
  const handler = channels.get(sub.channel);
  if (!handler) throw new Error(`Channel '${sub.channel}' not configured`);

  const testPayload = {
    deviceId:  'TEST',
    alarmCode: 'test_notification',
    severity:  'info',
    active:    true,
    airTemp:   null,
    evapTemp:  null,
    deviceName: 'Test Device',
    timestamp: new Date().toISOString(),
    isTest:    true,
  };

  try {
    await handler.send(sub.address, testPayload);
    await logDelivery(tenantId, sub.id, sub.channel, 'TEST', 'test_notification', 'sent');
    return { status: 'sent' };
  } catch (err) {
    await logDelivery(tenantId, sub.id, sub.channel, 'TEST', 'test_notification', 'failed', err.message);
    return { status: 'failed', error: err.message };
  }
}

module.exports = { registerChannel, start, shutdown, testSend };
