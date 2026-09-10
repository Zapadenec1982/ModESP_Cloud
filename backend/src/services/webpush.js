'use strict';

const webpush = require('web-push');
const db      = require('./db');

let logger = null;

// Title, body and tag live in lib/push-strings.js, shared with the mobile channel
// (FCM) so the two cannot drift apart in wording or in language coverage.
const { buildNotification, ALARM_NAMES, W } = require('../lib/push-strings');

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

// __strings and __test still point at the shared module: the dictionaries moved,
// the tests and scripts/check-locales.js did not have to.
module.exports = { init, shutdown, __strings: { ALARM_NAMES, W }, __test: { buildNotification } };
