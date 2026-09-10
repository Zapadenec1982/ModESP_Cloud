'use strict';

const path = require('path');
const db   = require('./db');

// The same words the browser push uses, in the recipient's language. This file used
// to carry eleven alarm names in English and read nothing else — payload.lang, which
// push.js resolves for every recipient, was ignored, so a Ukrainian user got «High
// Temperature» on the phone and «Висока температура» in the same alarm's e-mail.
const { buildNotification } = require('../lib/push-strings');

let admin  = null;
let logger = null;

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
 * The FCM message for one notification. Pure — no Firebase, no database — so a test
 * can read what the phone would actually show without a service account.
 * @param {string} fcmToken  - device registration token
 * @param {object} payload   - { deviceId, alarmCode, severity, airTemp, deviceName, lang, timestamp, isTest }
 */
function buildMessage(fcmToken, payload) {
  // Title and body come from the shared builder, which already carries the siren for
  // a raised alarm, the device name, its location and the temperature — all in
  // payload.lang. FCM adds only what is its own: priority, channel, sound.
  const { title, body } = buildNotification(payload);

  return {
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
}

/**
 * Send push notification via FCM.
 * @param {string} fcmToken  - device registration token
 * @param {object} payload   - see buildMessage
 */
async function send(fcmToken, payload) {
  if (!admin) throw new Error('FCM not initialized');

  try {
    await admin.messaging().send(buildMessage(fcmToken, payload));
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

// buildMessage is pure, so test/push-locale.test.js reads the message the phone
// would show without a Firebase service account.
module.exports = { init, shutdown, __test: { buildMessage } };
