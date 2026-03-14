'use strict';

const webpush = require('web-push');
const db      = require('./db');

let logger = null;

// Alarm names (same as fcm.js)
const ALARM_NAMES = {
  'protection.high_temp_alarm':       'Висока температура',
  'protection.low_temp_alarm':        'Низька температура',
  'protection.sensor1_alarm':         'Датчик 1 несправний',
  'protection.sensor2_alarm':         'Датчик 2 несправний',
  'protection.door_alarm':            'Двері відчинені',
  'protection.short_cycle_alarm':     'Короткий цикл',
  'protection.rapid_cycle_alarm':     'Часті цикли',
  'protection.continuous_run_alarm':  'Безперервна робота',
  'protection.pulldown_alarm':        'Повільне охолодження',
  'protection.rate_alarm':            'Швидка зміна температури',
  'test_notification':                'Тестове сповіщення',
};

/**
 * Initialize Web Push with VAPID keys.
 * Returns channel handler or null if not configured.
 * @param {import('pino').Logger} log
 * @returns {{ send: Function } | null}
 */
function init(log) {
  logger = log.child({ svc: 'webpush' });

  const publicKey  = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject    = process.env.VAPID_SUBJECT || 'mailto:admin@modesp.com.ua';

  if (!publicKey || !privateKey) {
    logger.info('WebPush: VAPID keys not configured — channel disabled. Generate with: npx web-push generate-vapid-keys');
    return null;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    logger.info('WebPush initialized with VAPID');
    return { send };
  } catch (err) {
    logger.error({ err }, 'WebPush initialization failed');
    return null;
  }
}

/**
 * Send push notification to a Web Push subscription endpoint.
 * @param {string} endpoint - NOT used directly; we query by endpoint from DB
 * @param {object} payload  - notification payload
 */
async function send(subscriptionJson, payload) {
  // subscriptionJson is the full subscription object stored as JSON string
  let sub;
  try {
    sub = typeof subscriptionJson === 'string' ? JSON.parse(subscriptionJson) : subscriptionJson;
  } catch {
    throw new Error('Invalid subscription data');
  }

  const alarmName = ALARM_NAMES[payload.alarmCode] || payload.alarmCode || '';
  const deviceName = payload.deviceName || payload.deviceId || '';
  const location = payload.location ? ` (${payload.location})` : '';

  let title, body, tag;

  if (payload.isTest) {
    title = 'ModESP Cloud — Тест';
    body  = 'Тестове сповіщення надіслано успішно.';
    tag   = 'test';
  } else if (payload.type === 'device_offline') {
    title = `⚠️ ${deviceName}${location} — офлайн`;
    body  = `Пристрій не відповідає`;
    tag   = `offline-${payload.deviceId}`;
  } else if (payload.active === false) {
    // Alarm cleared
    const durationStr = payload.duration ? formatDuration(payload.duration) : '';
    title = `✅ ${alarmName} — знято`;
    body  = `${deviceName}${location}${durationStr ? ' | ' + durationStr : ''}`;
    tag   = `alarm-${payload.deviceId}-${payload.alarmCode}`;
  } else {
    // Alarm raised
    const tempStr = payload.airTemp != null && isFinite(payload.airTemp)
      ? ` | ${Number(payload.airTemp).toFixed(1)}°C` : '';
    title = `🚨 ${alarmName}`;
    body  = `${deviceName}${location}${tempStr}`;
    tag   = `alarm-${payload.deviceId}-${payload.alarmCode}`;
  }

  const notifPayload = JSON.stringify({
    title,
    body,
    tag,
    icon: '/app/pwa-192x192.png',
    badge: '/app/favicon.svg',
    data: {
      url: `/app/#/device/${payload.deviceUuid || ''}`,
      deviceId: payload.deviceId,
      alarmCode: payload.alarmCode,
      type: payload.type || 'alarm',
    },
  });

  try {
    await webpush.sendNotification(sub, notifPayload, { TTL: 3600 });
  } catch (err) {
    // 410 Gone or 404 — subscription expired
    if (err.statusCode === 410 || err.statusCode === 404) {
      logger.warn({ endpoint: sub.endpoint }, 'WebPush subscription expired — deactivating');
      await deactivateSubscription(sub.endpoint);
    }
    throw err;
  }
}

/**
 * Deactivate expired subscription.
 */
async function deactivateSubscription(endpoint) {
  try {
    await db.query(
      `UPDATE push_subscriptions SET active = false WHERE endpoint = $1`,
      [endpoint]
    );
  } catch (err) {
    if (logger) logger.error({ err, endpoint }, 'Failed to deactivate push subscription');
  }
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} хв`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs} год ${rem} хв` : `${hrs} год`;
}

/** Shutdown */
function shutdown() {
  if (logger) logger.info('WebPush shutdown');
}

module.exports = { init, shutdown };
