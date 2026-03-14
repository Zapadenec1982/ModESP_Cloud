'use strict';

const mqttSvc = require('./mqtt');
const db      = require('./db');

let logger;

/** @type {Map<string, { send: Function }>}  channel name → handler */
const channels = new Map();

/** @type {Map<string, number>}  "deviceId:alarmCode:active" → last notification timestamp */
const debounceMap = new Map();
const DEBOUNCE_MS = 5000;  // 5 s cooldown per device+alarm+direction

/** @type {Map<string, NodeJS.Timeout>}  deviceId → pending offline notification timer */
const offlineTimers = new Map();
const OFFLINE_NOTIFY_DELAY_MS = 120000; // 2 min delay before notifying offline

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
 * Start push service — listen for alarm and device_status events from MQTT.
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
  mqttSvc.on('device_status', handleDeviceStatus);
}

/** Cleanup */
function shutdown() {
  mqttSvc.off('alarm', handleAlarm);
  mqttSvc.off('device_status', handleDeviceStatus);
  debounceMap.clear();
  for (const timer of offlineTimers.values()) clearTimeout(timer);
  offlineTimers.clear();
}

// ── Alarm handling ────────────────────────────────────────

/**
 * Handle alarm event from MQTT (both raise and clear).
 * @param {{ tenantSlug: string, deviceId: string, alarmCode: string, active: boolean, severity: string }} evt
 */
async function handleAlarm(evt) {
  try {
    // Debounce: include active flag in key so raise and clear don't cancel each other
    const debounceKey = `${evt.deviceId}:${evt.alarmCode}:${evt.active}`;
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

    // Build notification payload
    const payload = buildPayload(evt);

    // For alarm clears: compute duration from alarm record
    if (!evt.active) {
      try {
        const { rows } = await db.query(
          `SELECT triggered_at, cleared_at FROM alarms
           WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = $3
             AND active = false AND cleared_at IS NOT NULL
           ORDER BY cleared_at DESC LIMIT 1`,
          [tenantId, evt.deviceId, evt.alarmCode]
        );
        if (rows.length && rows[0].triggered_at) {
          const cleared = rows[0].cleared_at ? new Date(rows[0].cleared_at) : new Date();
          payload.duration = cleared.getTime() - new Date(rows[0].triggered_at).getTime();
        }
      } catch (err) {
        logger.warn({ err, deviceId: evt.deviceId }, 'Failed to compute alarm duration');
      }
    }

    // Resolve device name for enrichment
    const { rows: devRows } = await db.query(
      'SELECT id, name, location FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2',
      [tenantId, evt.deviceId]
    );
    const deviceUuid = devRows.length ? devRows[0].id : null;
    payload.deviceName = devRows.length ? devRows[0].name : null;
    payload.location = devRows.length ? devRows[0].location : null;

    // Path 1: Legacy notification_subscribers (alarm RAISE only — backward compat)
    if (evt.active) {
      const linkedTgIds = await getLinkedTelegramIds(tenantId);
      const subscribers = await getSubscribers(tenantId, evt.deviceId, deviceUuid);

      for (const sub of subscribers) {
        // Skip telegram subscribers that have a linked user account (avoid duplicates)
        if (sub.channel === 'telegram' && linkedTgIds.has(sub.address)) continue;

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
    }

    // Path 2: User-based Telegram notifications (both raise and clear)
    await dispatchToLinkedUsers(tenantId, evt.deviceId, deviceUuid, payload);

  } catch (err) {
    logger.error({ err, evt }, 'Push handleAlarm error');
  }
}

// ── Device offline handling ───────────────────────────────

/**
 * Handle device_status event — schedule offline notification with delay.
 * @param {{ tenantSlug: string, deviceId: string, online: boolean, lastSeen: string }} evt
 */
function handleDeviceStatus(evt) {
  if (evt.online) {
    // Device came back online: cancel pending offline notification
    const timer = offlineTimers.get(evt.deviceId);
    if (timer) {
      clearTimeout(timer);
      offlineTimers.delete(evt.deviceId);
      logger.debug({ deviceId: evt.deviceId }, 'Cancelled pending offline notification');
    }
    return;
  }

  // Device went offline: schedule delayed notification
  if (offlineTimers.has(evt.deviceId)) return; // already scheduled

  const timer = setTimeout(async () => {
    offlineTimers.delete(evt.deviceId);
    try {
      const tenantId = await resolveTenantId(evt.tenantSlug);
      if (!tenantId) return;

      // Resolve device info
      const { rows } = await db.query(
        'SELECT id, name, location FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2',
        [tenantId, evt.deviceId]
      );
      const deviceUuid = rows.length ? rows[0].id : null;

      const payload = {
        type:       'device_offline',
        deviceId:   evt.deviceId,
        deviceName: rows.length ? rows[0].name : null,
        location:   rows.length ? rows[0].location : null,
        lastSeen:   evt.lastSeen,
        timestamp:  new Date().toISOString(),
      };

      await dispatchToLinkedUsers(tenantId, evt.deviceId, deviceUuid, payload);
      logger.info({ deviceId: evt.deviceId }, 'Offline notification sent');
    } catch (err) {
      logger.error({ err, deviceId: evt.deviceId }, 'Offline notification failed');
    }
  }, OFFLINE_NOTIFY_DELAY_MS);

  offlineTimers.set(evt.deviceId, timer);
  logger.debug({ deviceId: evt.deviceId }, 'Scheduled offline notification (2 min delay)');
}

// ── User-based dispatch ───────────────────────────────────

/**
 * Send notification to all users who have telegram_id linked
 * and have access to this device (admin=all, others=user_devices).
 * Also dispatches to Web Push subscriptions.
 */
async function dispatchToLinkedUsers(tenantId, deviceId, deviceUuid, payload) {
  // Enrich payload with device UUID for deep links
  payload.deviceUuid = deviceUuid;

  // Get all users who have access to this tenant
  const { rows: users } = await db.query(
    `SELECT DISTINCT u.id, u.role, u.telegram_id
     FROM users u
     LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $1
     WHERE u.active = true
       AND (u.tenant_id = $1 OR ut.tenant_id IS NOT NULL OR u.role = 'superadmin')`,
    [tenantId]
  );

  const tgHandler = channels.get('telegram');
  const wpHandler = channels.get('webpush');

  for (const user of users) {
    // RBAC: admin/superadmin see all; others need user_devices entry
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      if (!deviceUuid) continue;
      const { rows: access } = await db.query(
        'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2 LIMIT 1',
        [user.id, deviceUuid]
      );
      if (!access.length) continue;
    }

    // Telegram
    if (tgHandler && user.telegram_id) {
      try {
        await tgHandler.send(String(user.telegram_id), payload);
        logger.info({
          channel: 'telegram', userId: user.id,
          deviceId, active: payload.active,
          type: payload.type || 'alarm',
        }, 'User push sent');
      } catch (err) {
        logger.error({ err, userId: user.id, telegram_id: user.telegram_id }, 'Telegram push send failed');
      }
    }

    // Web Push — send to all active subscriptions for this user
    if (wpHandler) {
      try {
        const { rows: subs } = await db.query(
          `SELECT endpoint, key_p256dh, key_auth FROM push_subscriptions
           WHERE user_id = $1 AND active = true`,
          [user.id]
        );
        for (const sub of subs) {
          const subscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.key_p256dh, auth: sub.key_auth }
          };
          try {
            await wpHandler.send(subscription, payload);
            logger.info({ channel: 'webpush', userId: user.id, deviceId }, 'WebPush sent');
          } catch (err) {
            // 410/404 handled inside webpush.js (deactivates sub)
            logger.debug({ err: err.statusCode || err.message, userId: user.id }, 'WebPush send failed');
          }
        }
      } catch (err) {
        logger.error({ err, userId: user.id }, 'WebPush dispatch error');
      }
    }
  }
}

/**
 * Get Set of telegram_ids for linked users in tenant (for duplicate prevention).
 */
async function getLinkedTelegramIds(tenantId) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.telegram_id FROM users u
     LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $1
     WHERE u.telegram_id IS NOT NULL AND u.active = true
       AND (u.tenant_id = $1 OR ut.tenant_id IS NOT NULL OR u.role = 'superadmin')`,
    [tenantId]
  );
  return new Set(rows.map(r => String(r.telegram_id)));
}

// ── Shared helpers ────────────────────────────────────────

async function resolveTenantId(slug) {
  const { rows } = await db.query(
    'SELECT id FROM tenants WHERE slug = $1 AND active = true',
    [slug]
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Get active notification_subscribers for a tenant, filtered by device.
 */
async function getSubscribers(tenantId, deviceId, deviceUuid) {
  const { rows } = await db.query(
    `SELECT id, channel, address, label, device_filter
     FROM notification_subscribers
     WHERE tenant_id = $1 AND active = true`,
    [tenantId]
  );

  return rows.filter(sub => {
    if (!sub.device_filter || sub.device_filter.length === 0) return true;
    return deviceUuid && sub.device_filter.includes(deviceUuid);
  });
}

function buildPayload(evt) {
  const state = mqttSvc.getDeviceState(evt.deviceId) || {};

  return {
    deviceId:    evt.deviceId,
    alarmCode:   evt.alarmCode,
    severity:    evt.severity,
    active:      evt.active,
    airTemp:     state['equipment.air_temp'],
    evapTemp:    state['equipment.evap_temp'],
    deviceName:  null,  // enriched later from DB
    timestamp:   new Date().toISOString(),
  };
}

async function logDelivery(tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage) {
  try {
    await db.query(
      `INSERT INTO notification_log (tenant_id, subscriber_id, channel, device_id, alarm_code, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage || null]
    );
  } catch (err) {
    if (logger) logger.error({ err }, 'Failed to log notification delivery');
  }
}

/**
 * Send a test notification to a specific subscriber.
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
