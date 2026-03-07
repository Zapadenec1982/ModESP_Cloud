'use strict';

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { SYSTEM_TENANT_ID } = db;

let bot = null;
let logger = null;

// ── Alarm name translations (UA) ──────────────────────────

const ALARM_NAMES_UA = {
  'protection.high_temp_alarm':       'Висока температура',
  'protection.low_temp_alarm':        'Низька температура',
  'protection.sensor1_alarm':         'Несправність датчика 1',
  'protection.sensor2_alarm':         'Несправність датчика 2',
  'protection.door_alarm':            'Двері відкриті',
  'protection.short_cycle_alarm':     'Короткий цикл компресора',
  'protection.rapid_cycle_alarm':     'Часті цикли компресора',
  'protection.continuous_run_alarm':  'Безперервна робота компресора',
  'protection.pulldown_alarm':        'Повільне охолодження',
  'protection.rate_alarm':            'Швидка зміна температури',
  'test_notification':                'Тестове сповіщення',
};

const SEVERITY_EMOJI = {
  critical: '\u{1F6A8}',  // 🚨
  warning:  '\u{26A0}\u{FE0F}',   // ⚠️
  info:     '\u{2139}\u{FE0F}',   // ℹ️
};

/**
 * Initialize Telegram bot.
 * Returns channel handler or null if token not configured.
 * @param {import('pino').Logger} log
 * @returns {{ send: Function } | null}
 */
function init(log) {
  logger = log.child({ svc: 'telegram' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info('Telegram: TELEGRAM_BOT_TOKEN not set — channel disabled');
    return null;
  }

  bot = new TelegramBot(token, { polling: true });

  // Handle polling errors gracefully
  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Telegram polling error');
  });

  // Register commands
  setupCommands();

  logger.info('Telegram bot started (long-polling)');

  return { send };
}

/**
 * Shutdown bot.
 */
function shutdown() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    if (logger) logger.info('Telegram bot stopped');
  }
}

// ── Bot Commands ───────────────────────────────────────────

function setupCommands() {
  // /start — register this chat as notification subscriber
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    const chatName = msg.chat.title || msg.chat.first_name || `Chat ${chatId}`;

    try {
      // Check if already registered
      const existing = await db.query(
        `SELECT id, active FROM notification_subscribers
         WHERE tenant_id = $1 AND channel = 'telegram' AND address = $2`,
        [SYSTEM_TENANT_ID, chatId]
      );

      if (existing.rows.length > 0) {
        if (!existing.rows[0].active) {
          // Re-activate
          await db.query(
            'UPDATE notification_subscribers SET active = true WHERE id = $1',
            [existing.rows[0].id]
          );
          await bot.sendMessage(chatId,
            `\u{2705} Сповіщення повторно активовані для "${chatName}".\n` +
            'Ви будете отримувати аварійні сповіщення від ModESP Cloud.'
          );
        } else {
          await bot.sendMessage(chatId,
            `\u{2139}\u{FE0F} Цей чат вже зареєстрований для сповіщень.\n` +
            'Використовуйте /status для перевірки статусу.'
          );
        }
        return;
      }

      // Register new subscriber
      await db.query(
        `INSERT INTO notification_subscribers (tenant_id, channel, address, label)
         VALUES ($1, 'telegram', $2, $3)`,
        [SYSTEM_TENANT_ID, chatId, chatName]
      );

      await bot.sendMessage(chatId,
        `\u{2705} Чат "${chatName}" зареєстрований для сповіщень ModESP Cloud!\n\n` +
        'Команди:\n' +
        '/status — перевірити статус\n' +
        '/devices — список пристроїв\n' +
        '/stop — зупинити сповіщення'
      );

      logger.info({ chatId, chatName }, 'Telegram subscriber registered via /start');
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /start error');
      await bot.sendMessage(chatId, '\u{274C} Помилка реєстрації. Спробуйте пізніше.');
    }
  });

  // /stop — deactivate notifications
  bot.onText(/\/stop/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const result = await db.query(
        `UPDATE notification_subscribers SET active = false
         WHERE tenant_id = $1 AND channel = 'telegram' AND address = $2 AND active = true
         RETURNING id`,
        [SYSTEM_TENANT_ID, chatId]
      );

      if (result.rows.length > 0) {
        await bot.sendMessage(chatId,
          '\u{1F6D1} Сповіщення зупинені. Використовуйте /start щоб відновити.'
        );
      } else {
        await bot.sendMessage(chatId,
          '\u{2139}\u{FE0F} Цей чат не зареєстрований для сповіщень.'
        );
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /stop error');
    }
  });

  // /status — show subscriber status
  bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const { rows } = await db.query(
        `SELECT active, created_at FROM notification_subscribers
         WHERE tenant_id = $1 AND channel = 'telegram' AND address = $2`,
        [SYSTEM_TENANT_ID, chatId]
      );

      if (!rows.length) {
        await bot.sendMessage(chatId,
          '\u{2139}\u{FE0F} Цей чат не зареєстрований. Використовуйте /start.'
        );
        return;
      }

      const sub = rows[0];
      const status = sub.active ? '\u{2705} Активний' : '\u{1F6D1} Зупинений';
      const since = new Date(sub.created_at).toLocaleDateString('uk-UA');

      // Count recent notifications
      const logResult = await db.query(
        `SELECT COUNT(*) as cnt FROM notification_log
         WHERE subscriber_id = (
           SELECT id FROM notification_subscribers
           WHERE tenant_id = $1 AND channel = 'telegram' AND address = $2
         )
         AND created_at > NOW() - INTERVAL '24 hours'`,
        [SYSTEM_TENANT_ID, chatId]
      );
      const recentCount = logResult.rows[0]?.cnt || 0;

      await bot.sendMessage(chatId,
        `\u{1F4CA} Статус сповіщень:\n\n` +
        `Статус: ${status}\n` +
        `Зареєстровано: ${since}\n` +
        `Сповіщень за 24г: ${recentCount}`
      );
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /status error');
    }
  });

  // /devices — list devices
  bot.onText(/\/devices/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const { rows } = await db.query(
        `SELECT mqtt_device_id, name, online, firmware_version
         FROM devices WHERE tenant_id = $1 AND status = 'active'
         ORDER BY name NULLS LAST`,
        [SYSTEM_TENANT_ID]
      );

      if (!rows.length) {
        await bot.sendMessage(chatId, '\u{1F4E6} Немає активних пристроїв.');
        return;
      }

      const lines = rows.map(d => {
        const dot = d.online ? '\u{1F7E2}' : '\u{26AA}';
        const name = d.name || d.mqtt_device_id;
        const fw = d.firmware_version ? ` (FW: ${d.firmware_version})` : '';
        return `${dot} ${name}${fw}`;
      });

      await bot.sendMessage(chatId,
        `\u{1F4E6} Пристрої (${rows.length}):\n\n${lines.join('\n')}`
      );
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /devices error');
    }
  });
}

// ── Send notification ──────────────────────────────────────

/**
 * Send alarm notification to a Telegram chat.
 * @param {string} chatId
 * @param {object} payload  - { deviceId, alarmCode, severity, airTemp, evapTemp, deviceName, timestamp, isTest }
 */
async function send(chatId, payload) {
  if (!bot) throw new Error('Telegram bot not initialized');

  const alarmName = ALARM_NAMES_UA[payload.alarmCode] || payload.alarmCode;
  const emoji = SEVERITY_EMOJI[payload.severity] || SEVERITY_EMOJI.warning;

  // Try to get device name from DB
  let deviceName = payload.deviceName;
  if (!deviceName && payload.deviceId !== 'TEST') {
    try {
      const { rows } = await db.query(
        'SELECT name FROM devices WHERE mqtt_device_id = $1 LIMIT 1',
        [payload.deviceId]
      );
      deviceName = rows.length ? rows[0].name : null;
    } catch (_) { /* ignore */ }
  }

  const deviceLabel = deviceName
    ? `${deviceName} (${payload.deviceId})`
    : payload.deviceId;

  let message;
  if (payload.isTest) {
    message =
      `\u{1F514} Тестове сповіщення ModESP Cloud\n\n` +
      `Якщо ви бачите це повідомлення — сповіщення працюють коректно!\n` +
      `\u{23F0} ${formatTime(payload.timestamp)}`;
  } else {
    const lines = [
      `${emoji} АВАРІЯ: ${alarmName}`,
      `\u{1F4CD} Пристрій: ${deviceLabel}`,
    ];

    if (payload.airTemp != null) {
      lines.push(`\u{1F321}\u{FE0F} Температура: ${Number(payload.airTemp).toFixed(1)}\u{00B0}C`);
    }

    if (payload.severity === 'critical') {
      lines.push(`\n\u{26A0}\u{FE0F} Критична аварія — потрібна негайна увага!`);
    }

    lines.push(`\u{23F0} ${formatTime(payload.timestamp)}`);

    message = lines.join('\n');
  }

  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = { init, shutdown };
