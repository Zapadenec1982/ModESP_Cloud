'use strict';

const webpush = require('web-push');
const db      = require('./db');

let logger = null;

const { pickLocale, formatDuration } = require('../lib/locale');

// Dictionaries (uk / en / pl / de — plan epic 2.11); scripts/check-locales.js keeps them in step.
const ALARM_NAMES = {
  uk: {
    high_temp_alarm: 'Висока температура', low_temp_alarm: 'Низька температура',
    sensor1_alarm: 'Датчик 1 несправний', sensor2_alarm: 'Датчик 2 несправний',
    door_alarm: 'Двері відчинені', short_cycle_alarm: 'Короткий цикл', rapid_cycle_alarm: 'Часті цикли',
    continuous_run_alarm: 'Безперервна робота', pulldown_alarm: 'Повільне охолодження',
    rate_alarm: 'Швидка зміна температури', device_offline: 'Пристрій офлайн', test_notification: 'Тестове сповіщення',
  },
  en: {
    high_temp_alarm: 'High temperature', low_temp_alarm: 'Low temperature',
    sensor1_alarm: 'Sensor 1 fault', sensor2_alarm: 'Sensor 2 fault',
    door_alarm: 'Door open', short_cycle_alarm: 'Short cycle', rapid_cycle_alarm: 'Rapid cycling',
    continuous_run_alarm: 'Continuous run', pulldown_alarm: 'Slow pulldown',
    rate_alarm: 'Rapid temperature change', device_offline: 'Device offline', test_notification: 'Test notification',
  },
  pl: {
    high_temp_alarm: 'Wysoka temperatura', low_temp_alarm: 'Niska temperatura',
    sensor1_alarm: 'Awaria czujnika 1', sensor2_alarm: 'Awaria czujnika 2',
    door_alarm: 'Drzwi otwarte', short_cycle_alarm: 'Krótki cykl', rapid_cycle_alarm: 'Częste cykle',
    continuous_run_alarm: 'Praca ciągła', pulldown_alarm: 'Wolne schładzanie',
    rate_alarm: 'Szybka zmiana temperatury', device_offline: 'Urządzenie offline', test_notification: 'Powiadomienie testowe',
  },
  de: {
    high_temp_alarm: 'Hohe Temperatur', low_temp_alarm: 'Niedrige Temperatur',
    sensor1_alarm: 'Fühler 1 defekt', sensor2_alarm: 'Fühler 2 defekt',
    door_alarm: 'Tür offen', short_cycle_alarm: 'Kurzer Zyklus', rapid_cycle_alarm: 'Häufige Zyklen',
    continuous_run_alarm: 'Dauerlauf', pulldown_alarm: 'Langsames Abkühlen',
    rate_alarm: 'Schnelle Temperaturänderung', device_offline: 'Gerät offline', test_notification: 'Testbenachrichtigung',
  },
};

const W = {
  uk: { test_title: 'ModESP Cloud — Тест', test_body: 'Тестове сповіщення надіслано успішно.',
        wo_title: '📋 Наряд #{0}: {1}', hint_title: '🔧 Аварія повторюється', hint_body: '{0}× за {1} дн.',
        offline_title: '⚠️ {0} — офлайн', offline_body: 'Пристрій не відповідає',
        cleared: '✅ {0} — знято', escalation: '⏫ {0} хв без підтвердження: {1}' },
  en: { test_title: 'ModESP Cloud — Test', test_body: 'Test notification sent successfully.',
        wo_title: '📋 Work order #{0}: {1}', hint_title: '🔧 Recurring alarm', hint_body: '{0}× in {1} days',
        offline_title: '⚠️ {0} — offline', offline_body: 'Device is not responding',
        cleared: '✅ {0} — cleared', escalation: '⏫ {0} min unacknowledged: {1}' },
  pl: { test_title: 'ModESP Cloud — Test', test_body: 'Powiadomienie testowe wysłane pomyślnie.',
        wo_title: '📋 Zlecenie #{0}: {1}', hint_title: '🔧 Alarm się powtarza', hint_body: '{0}× w {1} dni',
        offline_title: '⚠️ {0} — offline', offline_body: 'Urządzenie nie odpowiada',
        cleared: '✅ {0} — ustąpił', escalation: '⏫ {0} min bez potwierdzenia: {1}' },
  de: { test_title: 'ModESP Cloud — Test', test_body: 'Testbenachrichtigung erfolgreich gesendet.',
        wo_title: '📋 Auftrag #{0}: {1}', hint_title: '🔧 Alarm wiederholt sich', hint_body: '{0}× in {1} Tagen',
        offline_title: '⚠️ {0} — offline', offline_body: 'Gerät antwortet nicht',
        cleared: '✅ {0} — behoben', escalation: '⏫ {0} Min. nicht quittiert: {1}' },
};

function fmt(str, ...args) { return String(str).replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined ? '' : String(args[i]))); }

function alarmNameFor(lang, code) {
  const names = ALARM_NAMES[lang] || ALARM_NAMES.uk;
  const key = String(code || '').replace(/^protection\./, '');
  return names[key] || code || '';
}

/**
 * Title / body / tag of one push, in the recipient's language
 * (payload.lang, resolved by push.withUserLocale). Exported for tests.
 */
function buildNotification(payload) {
  const lang = pickLocale(payload.lang);
  const T = W[lang];
  const alarmName = alarmNameFor(lang, payload.alarmCode);
  const deviceName = payload.deviceName || payload.deviceId || '';
  const location = payload.location ? ` (${payload.location})` : '';

  let title, body, tag;
  if (payload.isTest) {
    title = T.test_title;
    body  = T.test_body;
    tag   = 'test';
  } else if (payload.type === 'work_order') {
    title = fmt(T.wo_title, payload.orderId, payload.title);
    body  = [payload.siteName, payload.siteAddress].filter(Boolean).join(' · ') || (payload.deviceName || '');
    tag   = `wo-${payload.orderId}`;
  } else if (payload.type === 'hint') {
    // The controller keeps raising the same alarm (plan epic 2.4)
    const src = payload.sourceAlarmCode;
    const repeatName = src ? alarmNameFor(lang, src) : '';
    const days = payload.windowHours ? Math.max(1, Math.round(payload.windowHours / 24)) : '—';
    title = `${T.hint_title}${repeatName ? ': ' + repeatName : ''}`;
    body  = `${deviceName}${location}${payload.value != null ? ` · ${fmt(T.hint_body, payload.value, days)}` : ''}`;
    tag   = `hint-${payload.deviceId}-${src || payload.ruleKey}`;
  } else if (payload.type === 'device_offline') {
    title = fmt(T.offline_title, `${deviceName}${location}`);
    body  = T.offline_body;
    tag   = `offline-${payload.deviceId}`;
  } else if (payload.active === false) {
    const durationStr = payload.duration ? formatDuration(payload.duration, lang) : '';
    title = fmt(T.cleared, alarmName);
    body  = `${deviceName}${location}${durationStr ? ' | ' + durationStr : ''}`;
    tag   = `alarm-${payload.deviceId}-${payload.alarmCode}`;
  } else {
    const tempStr = payload.airTemp != null && isFinite(payload.airTemp)
      ? ` | ${Number(payload.airTemp).toFixed(1)}°C` : '';
    title = payload.escalation ? fmt(T.escalation, payload.escalation.minutes, alarmName) : `🚨 ${alarmName}`;
    body  = `${deviceName}${location}${tempStr}`;
    tag   = `alarm-${payload.deviceId}-${payload.alarmCode}`;
  }
  return { title, body, tag };
}

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

  const { title, body, tag } = buildNotification(payload);

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

/** Shutdown */
function shutdown() {
  if (logger) logger.info('WebPush shutdown');
}

module.exports = { init, shutdown, __strings: { ALARM_NAMES, W }, __test: { buildNotification } };
