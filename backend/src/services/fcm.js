'use strict';

const path = require('path');
const db   = require('./db');

let admin  = null;
let logger = null;

// Alarm names for FCM notification title
const ALARM_NAMES = {
  'protection.high_temp_alarm':       'High Temperature',
  'protection.low_temp_alarm':        'Low Temperature',
  'protection.sensor1_alarm':         'Sensor 1 Fault',
  'protection.sensor2_alarm':         'Sensor 2 Fault',
  'protection.door_alarm':            'Door Open',
  'protection.short_cycle_alarm':     'Short Cycle',
  'protection.rapid_cycle_alarm':     'Rapid Cycling',
  'protection.continuous_run_alarm':  'Continuous Run',
  'protection.pulldown_alarm':        'Slow Pulldown',
  'protection.rate_alarm':            'Rate of Change',
  'test_notification':                'Test Notification',
};

/**
 * Initialize Firebase Cloud Messaging.
 * Returns channel handler or null if service account not configured.
 * @param {import('pino').Logger} log
 * @returns {{ send: Function } | null}
 */
function init(log) {
  logger = log.child({ svc: 'fcm' });

  const saPath = process.env.FCM_SERVICE_ACCOUNT_PATH;
  if (!saPath) {
    logger.info('FCM: FCM_SERVICE_ACCOUNT_PATH not set — channel disabled');
    return null;
  }

  try {
    const firebaseAdmin = require('firebase-admin');
    const serviceAccount = require(path.resolve(saPath));

    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
    });

    admin = firebaseAdmin;
    logger.info('FCM initialized');

    return { send };
  } catch (err) {
    logger.error({ err }, 'FCM initialization failed');
    return null;
  }
}

/** Shutdown */
function shutdown() {
  if (admin) {
    admin.app().delete().catch(() => {});
    admin = null;
    if (logger) logger.info('FCM shutdown');
  }
}

// ── Send notification ──────────────────────────────────────

/**
 * Send push notification via FCM.
 * @param {string} fcmToken  - device registration token
 * @param {object} payload   - { deviceId, alarmCode, severity, airTemp, deviceName, timestamp, isTest }
 */
async function send(fcmToken, payload) {
  if (!admin) throw new Error('FCM not initialized');

  const alarmName = ALARM_NAMES[payload.alarmCode] || payload.alarmCode;

  let title, body;

  if (payload.isTest) {
    title = 'ModESP Cloud — Test';
    body  = 'Test notification sent successfully.';
  } else {
    title = `${payload.severity === 'critical' ? '\u{1F6A8} ' : ''}${alarmName}`;
    body  = `Device: ${payload.deviceName || payload.deviceId}`;
    if (payload.airTemp != null) {
      body += ` | Temp: ${Number(payload.airTemp).toFixed(1)}\u{00B0}C`;
    }
  }

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: {
      deviceId:  String(payload.deviceId),
      alarmCode: String(payload.alarmCode),
      severity:  String(payload.severity || 'warning'),
      timestamp: String(payload.timestamp),
    },
    android: {
      priority: payload.severity === 'critical' ? 'high' : 'normal',
      notification: {
        channelId: 'modesp_alarms',
        priority:  payload.severity === 'critical' ? 'max' : 'high',
        sound:     'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound:    'default',
          badge:    1,
          category: 'ALARM',
        },
      },
    },
  };

  try {
    await admin.messaging().send(message);
  } catch (err) {
    // Check if token is stale and deactivate subscriber
    if (isStaleTokenError(err)) {
      logger.warn({ fcmToken }, 'FCM token stale — deactivating subscriber');
      await deactivateSubscriber(fcmToken);
    }
    throw err;
  }
}

/**
 * Check if FCM error indicates an invalid/stale token.
 * @param {Error} err
 * @returns {boolean}
 */
function isStaleTokenError(err) {
  const code = err.code || err.errorInfo?.code || '';
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

/**
 * Deactivate subscriber with the given FCM token.
 * @param {string} fcmToken
 */
async function deactivateSubscriber(fcmToken) {
  try {
    await db.query(
      `UPDATE notification_subscribers SET active = false
       WHERE channel = 'fcm' AND address = $1 AND active = true`,
      [fcmToken]
    );
  } catch (err) {
    if (logger) logger.error({ err, fcmToken }, 'Failed to deactivate stale FCM subscriber');
  }
}

module.exports = { init, shutdown };
