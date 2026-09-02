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
/** name → { sent, failed, last_ok_at, last_error_at, last_error } for /api/health/details */
const channelStats = new Map();

function registerChannel(name, handler) {
  const stats = { sent: 0, failed: 0, last_ok_at: null, last_error_at: null, last_error: null };
  channelStats.set(name, stats);
  // Wrap send() so every delivery, whatever path dispatches it, feeds the health
  // counters. The original handler keeps `this` — some channels are objects.
  channels.set(name, {
    ...handler,
    async send(...args) {
      try {
        const r = await handler.send.apply(handler, args);
        stats.sent++;
        stats.last_ok_at = new Date().toISOString();
        return r;
      } catch (err) {
        stats.failed++;
        stats.last_error_at = new Date().toISOString();
        stats.last_error = String(err && err.message || err).slice(0, 200);
        throw err;
      }
    },
  });
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
  // Offline is an alarm since plan epic 1.6 (mqtt.js raises device_offline), so
  // the delayed device_status path is gone; what remains is the escalation sweep.
  escalationTimer = setInterval(() => {
    runEscalations().catch(err => logger.error({ err }, 'Escalation sweep failed'));
  }, ESCALATION_SWEEP_MS);
  if (escalationTimer.unref) escalationTimer.unref();
}

/** Cleanup */
function shutdown() {
  mqttSvc.off('alarm', handleAlarm);
  debounceMap.clear();
  if (escalationTimer) { clearInterval(escalationTimer); escalationTimer = null; }
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
    payload.alarmId = evt.alarmId || null;
    if (evt.alarmCode === 'device_offline') {
      // Rendered by the channels' offline templates when raised; the generic
      // "alarm cleared" template names it when the device is back.
      if (evt.active) payload.type = 'device_offline';
      payload.lastSeen = evt.lastSeen || payload.timestamp;
    }

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
    // Info-severity alarms → push only to admin/superadmin (ISA-18.2 noise reduction)
    const roleFilter = evt.severity === 'info' ? ['admin', 'superadmin'] : null;
    await dispatchToLinkedUsers(tenantId, evt.deviceId, deviceUuid, payload, { roleFilter });

  } catch (err) {
    logger.error({ err, evt }, 'Push handleAlarm error');
  }
}

// ── Escalation of unacknowledged critical alarms ───────────
//
// A critical alarm that nobody acknowledged within ALARM_ACK_ESCALATION_MIN is
// re-sent once to the organisation's admins. State lives in alarms.escalated_at,
// so a restart neither loses nor duplicates an escalation. (Per-tenant override
// arrives with tenant_settings in plan epic 1.8.)

const ESCALATION_MIN      = parseInt(process.env.ALARM_ACK_ESCALATION_MIN, 10) || 15;
const ESCALATION_SWEEP_MS = parseInt(process.env.ALARM_ESCALATION_SWEEP_MS, 10) || 60_000;
let escalationTimer = null;

async function runEscalations(now = new Date()) {
  const { rows } = await db.query(
    `SELECT a.id, a.tenant_id, a.device_id, a.alarm_code, a.severity, a.triggered_at,
            COALESCE(s.ack_escalation_min, $2::int) AS escalation_min
       FROM alarms a
       LEFT JOIN tenant_settings s ON s.tenant_id = a.tenant_id
      WHERE a.active = true AND a.severity = 'critical'
        AND a.acknowledged_at IS NULL AND a.escalated_at IS NULL
        AND a.triggered_at <= $1::timestamptz - make_interval(mins => COALESCE(s.ack_escalation_min, $2::int))`,
    [now, ESCALATION_MIN]
  );

  let escalated = 0;
  for (const a of rows) {
    // Claim the row first so two sweeps can never both notify.
    const { rowCount } = await db.query(
      'UPDATE alarms SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL', [a.id]);
    if (rowCount === 0) continue;

    const { rows: devRows } = await db.query(
      'SELECT id, name, location FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2',
      [a.tenant_id, a.device_id]
    );
    const payload = buildPayload({ deviceId: a.device_id, alarmCode: a.alarm_code, severity: a.severity, active: true });
    payload.alarmId    = a.id;
    payload.type       = 'alarm_escalation';
    payload.escalation = { minutes: a.escalation_min, triggeredAt: a.triggered_at };
    payload.deviceName = devRows.length ? devRows[0].name : null;
    payload.location   = devRows.length ? devRows[0].location : null;

    await dispatchToLinkedUsers(a.tenant_id, a.device_id, devRows.length ? devRows[0].id : null, payload,
      { roleFilter: ['admin', 'superadmin'], ignoreQuietHours: true });
    escalated++;
    logger.warn({ alarmId: a.id, deviceId: a.device_id, alarmCode: a.alarm_code }, 'Critical alarm escalated to admins');
  }
  return escalated;
}

// ── User-based dispatch ───────────────────────────────────

/**
 * Send notification to all users who have telegram_id linked
 * and have access to this device (admin=all, others=user_devices).
 * Also dispatches to Web Push subscriptions.
 */
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Local HH:MM in an IANA time zone → minutes since midnight.
 */
function localMinutes(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date);
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function parseHHMM(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** True when `date` falls inside [from, to) local time; ranges may cross midnight. */
function inQuietHours(pref, date = new Date()) {
  const from = parseHHMM(pref.quiet_from);
  const to   = parseHHMM(pref.quiet_to);
  if (from === null || to === null || from === to) return false;
  const now = localMinutes(date, pref.quiet_tz || 'Europe/Kyiv');
  return from < to ? (now >= from && now < to) : (now >= from || now < to);
}

/**
 * Decide whether one user gets one payload. Exported for tests.
 * @returns {{ deliver: boolean, reason?: string, channels: {telegram:boolean, webpush:boolean, email:boolean} }}
 */
function evaluatePrefs(user, payload, { ignoreQuietHours = false, now = new Date() } = {}) {
  const off = { telegram: false, webpush: false, email: false };
  if (user.pref_enabled === false) return { deliver: false, reason: 'disabled', channels: off };

  const severity = payload.severity || 'warning';
  const minSev   = user.min_severity || 'info';
  if ((SEVERITY_RANK[severity] ?? 1) < (SEVERITY_RANK[minSev] ?? 0)) {
    return { deliver: false, reason: 'below_min_severity', channels: off };
  }
  // Quiet hours never hold back a critical alarm or an escalation.
  if (!ignoreQuietHours && severity !== 'critical' && inQuietHours(user, now)) {
    return { deliver: false, reason: 'quiet_hours', channels: off };
  }
  return {
    deliver: true,
    channels: {
      telegram: user.pref_telegram !== false,
      webpush:  user.pref_webpush  !== false,
      email:    user.pref_email    !== false,
    },
  };
}

/**
 * Send a notification to every user who may see this device (admins of the
 * organisation; technicians/viewers through user_devices ∪ user_sites — the
 * same rule middleware/device-access.js applies), honouring each user's
 * notification preferences. Superadmins are included only when they opted in
 * (users.receive_all_tenant_alerts). Every attempt is written to
 * notification_log with user_id and alarm_id.
 */
async function dispatchToLinkedUsers(tenantId, deviceId, deviceUuid, payload, { roleFilter, ignoreQuietHours = false } = {}) {
  // Enrich payload with device UUID for deep links
  payload.deviceUuid = deviceUuid;

  const { rows: users } = await db.query(
    `SELECT DISTINCT u.id, u.role, u.telegram_id, u.email, u.receive_all_tenant_alerts,
            p.enabled AS pref_enabled, p.min_severity,
            p.telegram AS pref_telegram, p.webpush AS pref_webpush, p.email AS pref_email,
            p.quiet_from, p.quiet_to, p.quiet_tz
       FROM users u
       LEFT JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = $1
       LEFT JOIN user_notification_prefs p ON p.user_id = u.id
      WHERE u.active = true
        AND (u.tenant_id = $1 OR ut.tenant_id IS NOT NULL OR u.role = 'superadmin')`,
    [tenantId]
  );
  if (!users.length) return [];

  // Access set for non-admins: user_devices ∪ user_sites (one query, no N+1)
  const nonAdminIds = users.filter(u => u.role !== 'admin' && u.role !== 'superadmin').map(u => u.id);
  const accessSet = new Set();
  if (nonAdminIds.length > 0 && deviceUuid) {
    const { rows: accessRows } = await db.query(
      `SELECT ud.user_id FROM user_devices ud
        WHERE ud.device_id = $2 AND ud.user_id = ANY($1)
       UNION
       SELECT us.user_id FROM user_sites us
         JOIN devices d ON d.site_id = us.site_id AND d.tenant_id = us.tenant_id
        WHERE d.id = $2 AND us.tenant_id = $3 AND us.user_id = ANY($1)`,
      [nonAdminIds, deviceUuid, tenantId]
    );
    for (const r of accessRows) accessSet.add(r.user_id);
  }

  const tgHandler    = channels.get('telegram');
  const wpHandler    = channels.get('webpush');
  const emailHandler = channels.get('email');

  const recipients = users.filter(u => {
    if (roleFilter && !roleFilter.includes(u.role)) return false;
    if (u.role === 'superadmin') return u.receive_all_tenant_alerts === true;
    if (u.role === 'admin') return true;
    return !!deviceUuid && accessSet.has(u.id);
  });

  let subsByUser = new Map();
  if (wpHandler && recipients.length > 0) {
    const { rows: allSubs } = await db.query(
      `SELECT user_id, endpoint, key_p256dh, key_auth FROM push_subscriptions
        WHERE user_id = ANY($1) AND active = true`,
      [recipients.map(u => u.id)]
    );
    for (const sub of allSubs) {
      if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, []);
      subsByUser.get(sub.user_id).push(sub);
    }
  }

  const delivered = [];
  const alarmCode = payload.alarmCode || null;
  const logCtx = { userId: null, alarmId: payload.alarmId || null };

  for (const user of recipients) {
    const verdict = evaluatePrefs(user, payload, { ignoreQuietHours });
    if (!verdict.deliver) {
      logger.debug({ userId: user.id, reason: verdict.reason }, 'Notification skipped by preferences');
      continue;
    }
    logCtx.userId = user.id;

    if (tgHandler && verdict.channels.telegram && user.telegram_id) {
      try {
        await tgHandler.send(String(user.telegram_id), payload);
        await logDelivery(tenantId, null, 'telegram', deviceId, alarmCode, 'sent', null, logCtx);
        delivered.push({ userId: user.id, channel: 'telegram' });
        logger.info({ channel: 'telegram', userId: user.id, deviceId, type: payload.type || 'alarm' }, 'User push sent');
      } catch (err) {
        await logDelivery(tenantId, null, 'telegram', deviceId, alarmCode, 'failed', err.message, logCtx);
        logger.error({ err, userId: user.id, telegram_id: user.telegram_id }, 'Telegram push send failed');
      }
    }

    const userSubs = subsByUser.get(user.id);
    if (wpHandler && verdict.channels.webpush && userSubs) {
      for (const sub of userSubs) {
        const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.key_p256dh, auth: sub.key_auth } };
        try {
          await wpHandler.send(subscription, payload);
          await logDelivery(tenantId, null, 'webpush', deviceId, alarmCode, 'sent', null, logCtx);
          delivered.push({ userId: user.id, channel: 'webpush' });
          logger.info({ channel: 'webpush', userId: user.id, deviceId }, 'WebPush sent');
        } catch (err) {
          await logDelivery(tenantId, null, 'webpush', deviceId, alarmCode, 'failed', String(err.statusCode || err.message), logCtx);
          logger.debug({ err: err.statusCode || err.message, userId: user.id }, 'WebPush send failed');
        }
      }
    }

    if (emailHandler && verdict.channels.email && user.email) {
      try {
        await emailHandler.send(user.email, payload);
        await logDelivery(tenantId, null, 'email', deviceId, alarmCode, 'sent', null, logCtx);
        delivered.push({ userId: user.id, channel: 'email' });
        logger.info({ channel: 'email', userId: user.id, deviceId }, 'Email sent');
      } catch (err) {
        await logDelivery(tenantId, null, 'email', deviceId, alarmCode, 'failed', err.message, logCtx);
        logger.error({ err: err.message, userId: user.id }, 'Email send failed');
      }
    }
  }
  return delivered;
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

async function logDelivery(tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage, ctx = {}) {
  try {
    await db.query(
      `INSERT INTO notification_log (tenant_id, subscriber_id, channel, device_id, alarm_code, status, error_message, user_id, alarm_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, subscriberId, channel, deviceId, alarmCode, status, errorMessage || null, ctx.userId || null, ctx.alarmId || null]
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

/** Delivery health per registered channel (empty when nothing is configured). */
function channelHealth() {
  const out = {};
  for (const [name, stats] of channelStats) out[name] = { configured: true, ...stats };
  return out;
}

module.exports = {
  registerChannel, start, shutdown, testSend, channelHealth,
  // test/notifications-dispatch.test.js drives the dispatch without a broker
  __test: {
    handleAlarm, dispatchToLinkedUsers, runEscalations, evaluatePrefs, inQuietHours,
    setLogger(l) { logger = l; },
    reset() { debounceMap.clear(); channels.clear(); channelStats.clear(); },
    ESCALATION_MIN,
  },
};
