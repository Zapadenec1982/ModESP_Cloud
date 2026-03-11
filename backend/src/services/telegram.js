'use strict';

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

let bot = null;
let logger = null;

// In-memory tenant context for multi-tenant users: Map<chatId_str, tenantId>
const tenantContext = new Map();

// ── Alarm name translations (UA) ──────────────────────────

const ALARM_NAMES_UA = {
  high_temp_alarm:       'Висока температура',
  low_temp_alarm:        'Низька температура',
  sensor1_alarm:         'Несправність датчика 1',
  sensor2_alarm:         'Несправність датчика 2',
  door_alarm:            'Двері відкриті',
  short_cycle_alarm:     'Короткий цикл компресора',
  rapid_cycle_alarm:     'Часті цикли компресора',
  continuous_run_alarm:  'Безперервна робота компресора',
  pulldown_alarm:        'Повільне охолодження',
  rate_alarm:            'Швидка зміна температури',
  test_notification:     'Тестове сповіщення',
};

const SEVERITY_EMOJI = {
  critical: '\u{1F6A8}',        // 🚨
  warning:  '\u{26A0}\u{FE0F}', // ⚠️
  info:     '\u{2139}\u{FE0F}', // ℹ️
};

// ── Inline Keyboard Helpers ──────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F4E6} Пристрої', callback_data: 'menu_devices' },
        { text: '\u{1F6A8} Аварії', callback_data: 'menu_alarms' },
      ],
      [
        { text: '\u{1F504} Тенант', callback_data: 'menu_tenant' },
        { text: '\u{2753} Допомога', callback_data: 'menu_help' },
      ],
    ],
  };
}

function refreshMenuKeyboard(refreshAction) {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F504} Оновити', callback_data: refreshAction },
        { text: '\u{1F4CB} Меню', callback_data: 'menu' },
      ],
    ],
  };
}

function backToMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '\u{1F4CB} Меню', callback_data: 'menu' }],
    ],
  };
}

// ── Init / Shutdown ───────────────────────────────────────

/**
 * Initialize Telegram bot.
 * Returns channel handler or null if token not configured.
 */
function init(log) {
  logger = log.child({ svc: 'telegram' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info('Telegram: TELEGRAM_BOT_TOKEN not set — channel disabled');
    return null;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Telegram polling error');
  });

  setupCommands();

  logger.info('Telegram bot started (long-polling)');

  return { send };
}

function shutdown() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    if (logger) logger.info('Telegram bot stopped');
  }
  tenantContext.clear();
}

// ── User Context Resolution ──────────────────────────────

/**
 * Resolve Telegram user from chat ID.
 * @returns {{ user: {id,email,role}, tenantId, tenantSlug, tenantName } | null}
 */
async function resolveUser(chatId) {
  const tgId = Number(chatId);

  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, u.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.telegram_id = $1 AND u.active = true`,
    [tgId]
  );

  if (!rows.length) return null;

  const user = rows[0];

  // Check for multi-tenant context override
  const overrideTenant = tenantContext.get(String(chatId));
  if (overrideTenant && overrideTenant !== user.tenant_id) {
    const { rows: tc } = await db.query(
      `SELECT t.id, t.slug, t.name FROM user_tenants ut
       JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = $1 AND ut.tenant_id = $2 AND t.active = true`,
      [user.id, overrideTenant]
    );
    if (tc.length) {
      return {
        user: { id: user.id, email: user.email, role: user.role },
        tenantId: tc[0].id, tenantSlug: tc[0].slug, tenantName: tc[0].name,
      };
    }
    tenantContext.delete(String(chatId));
  }

  return {
    user: { id: user.id, email: user.email, role: user.role },
    tenantId: user.tenant_id, tenantSlug: user.tenant_slug, tenantName: user.tenant_name,
  };
}

/**
 * Get device IDs accessible to a user.
 * Admin/superadmin: null (no restriction). Viewer/technician: { uuids, mqttIds }.
 */
async function getUserDeviceFilter(userId, role, tenantId) {
  if (role === 'admin' || role === 'superadmin') return null;

  const { rows } = await db.query(
    `SELECT d.id, d.mqtt_device_id
     FROM user_devices ud
     JOIN devices d ON d.id = ud.device_id
     WHERE ud.user_id = $1 AND d.tenant_id = $2
     LIMIT 500`,
    [userId, tenantId]
  );

  return { uuids: rows.map(r => r.id), mqttIds: rows.map(r => r.mqtt_device_id) };
}

/** Send "not linked" hint */
async function sendNotLinked(chatId) {
  await bot.sendMessage(chatId,
    'Telegram не прив\'язаний до акаунту ModESP.\n' +
    'Отримайте код у веб-інтерфейсі та надішліть: /start КОД'
  );
}

/**
 * Send new message or edit existing one in-place.
 * @param {number} chatId
 * @param {string} text
 * @param {object} opts - reply_markup, parse_mode, etc.
 * @param {number|null} editMsgId - if set, edit this message instead of sending new
 */
async function reply(chatId, text, opts, editMsgId) {
  if (editMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
      return;
    } catch (err) {
      // If edit fails (message too old, deleted, or unchanged), fall back to new message
      if (!err.message?.includes('message is not modified')) {
        logger.debug({ err: err.message, chatId, editMsgId }, 'Edit failed, sending new message');
      } else {
        return; // text unchanged — no-op
      }
    }
  }
  await bot.sendMessage(chatId, text, opts);
}

// ── Reusable Command Handlers ─────────────────────────────

async function handleDevices(chatId, ctx, editMsgId) {
  const filter = await getUserDeviceFilter(ctx.user.id, ctx.user.role, ctx.tenantId);

  let query, params;
  if (!filter) {
    query = `SELECT mqtt_device_id, name, online, last_state
             FROM devices WHERE tenant_id = $1 AND status = 'active'
             ORDER BY name NULLS LAST LIMIT 50`;
    params = [ctx.tenantId];
  } else if (filter.uuids.length === 0) {
    await reply(chatId, 'У вас немає призначених пристроїв.', {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  } else {
    query = `SELECT mqtt_device_id, name, online, last_state
             FROM devices WHERE tenant_id = $1 AND id = ANY($2) AND status = 'active'
             ORDER BY name NULLS LAST`;
    params = [ctx.tenantId, filter.uuids];
  }

  const { rows } = await db.query(query, params);
  if (!rows.length) {
    await reply(chatId, 'Немає активних пристроїв.', {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  }

  const lines = rows.map(d => {
    const dot = d.online ? '\u{1F7E2}' : '\u{26AA}';
    const name = d.name || d.mqtt_device_id;
    const temp = d.last_state?.['equipment.air_temp'];
    const tempStr = temp != null ? `  ${Number(temp).toFixed(1)}\u{00B0}C` : '';
    return `${dot} ${name} (${d.mqtt_device_id})${tempStr}`;
  });

  // Build device status buttons (rows of 3)
  const deviceButtons = [];
  for (let i = 0; i < rows.length && i < 30; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j < rows.length; j++) {
      const d = rows[j];
      row.push({ text: `\u{1F4CA} ${d.mqtt_device_id}`, callback_data: `status_${d.mqtt_device_id}` });
    }
    deviceButtons.push(row);
  }

  // Add refresh + menu row
  deviceButtons.push([
    { text: '\u{1F504} Оновити', callback_data: 'refresh_devices' },
    { text: '\u{1F4CB} Меню', callback_data: 'menu' },
  ]);

  await reply(chatId,
    `\u{1F4E6} Пристрої [${ctx.tenantName}] (${rows.length}):\n\n${lines.join('\n')}`,
    { reply_markup: { inline_keyboard: deviceButtons } },
    editMsgId
  );
}

async function handleStatus(chatId, ctx, deviceIdArg, editMsgId) {
  // RBAC check
  const filter = await getUserDeviceFilter(ctx.user.id, ctx.user.role, ctx.tenantId);
  if (filter && !filter.mqttIds.includes(deviceIdArg)) {
    await reply(chatId, '\u{1F6AB} У вас немає доступу до цього пристрою.', {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  }

  const { rows } = await db.query(
    `SELECT mqtt_device_id, name, online, last_seen, firmware_version, last_state
     FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2 AND status = 'active'`,
    [ctx.tenantId, deviceIdArg]
  );

  if (!rows.length) {
    await reply(chatId, `Пристрій ${deviceIdArg} не знайдений.`, {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  }

  const d = rows[0];
  const s = d.last_state || {};
  const dot = d.online ? '\u{1F7E2} Онлайн' : '\u{26AA} Офлайн';
  const name = d.name || d.mqtt_device_id;

  const lines = [
    `\u{1F4CD} ${name} (${d.mqtt_device_id})`,
    `Статус: ${dot}`,
  ];

  if (d.last_seen) {
    lines.push(`Востаннє: ${formatTime(d.last_seen)}`);
  }
  if (s['equipment.air_temp'] != null) {
    lines.push(`\u{1F321}\u{FE0F} Повітря: ${Number(s['equipment.air_temp']).toFixed(1)}\u{00B0}C`);
  }
  if (s['equipment.evap_temp'] != null) {
    lines.push(`\u{2744}\u{FE0F} Випарник: ${Number(s['equipment.evap_temp']).toFixed(1)}\u{00B0}C`);
  }
  if (s['thermostat.effective_setpoint'] != null) {
    lines.push(`\u{1F3AF} Уставка: ${Number(s['thermostat.effective_setpoint']).toFixed(1)}\u{00B0}C`);
  }
  if (s['equipment.compressor'] != null) {
    lines.push(`\u{2699}\u{FE0F} Компресор: ${s['equipment.compressor'] ? 'Увімк' : 'Вимк'}`);
  }
  if (s['defrost.active'] != null && s['defrost.active']) {
    lines.push(`\u{1F525} Розморозка: Активна`);
  }

  // Active alarms
  const { rows: alarms } = await db.query(
    `SELECT alarm_code, severity, triggered_at FROM alarms
     WHERE tenant_id = $1 AND device_id = $2 AND active = true
     ORDER BY triggered_at DESC`,
    [ctx.tenantId, deviceIdArg]
  );

  if (alarms.length) {
    lines.push('');
    lines.push(`\u{1F6A8} Активні аварії (${alarms.length}):`);
    for (const a of alarms) {
      const aName = ALARM_NAMES_UA[a.alarm_code] || a.alarm_code;
      const emoji = a.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
      lines.push(`  ${emoji} ${aName}`);
    }
  }

  if (d.firmware_version) {
    lines.push(`\nFW: ${d.firmware_version}`);
  }

  await reply(chatId, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '\u{1F504} Оновити', callback_data: `status_${deviceIdArg}` },
          { text: '\u{1F4E6} Пристрої', callback_data: 'menu_devices' },
          { text: '\u{1F4CB} Меню', callback_data: 'menu' },
        ],
      ],
    },
  }, editMsgId);
}

async function handleAlarms(chatId, ctx, editMsgId) {
  const filter = await getUserDeviceFilter(ctx.user.id, ctx.user.role, ctx.tenantId);

  let query, params;
  if (!filter) {
    query = `SELECT a.alarm_code, a.severity, a.triggered_at, a.device_id,
                    d.name AS device_name
             FROM alarms a
             LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = $1
             WHERE a.tenant_id = $1 AND a.active = true
             ORDER BY a.triggered_at DESC LIMIT 30`;
    params = [ctx.tenantId];
  } else if (filter.mqttIds.length === 0) {
    await reply(chatId, 'У вас немає призначених пристроїв.', {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  } else {
    query = `SELECT a.alarm_code, a.severity, a.triggered_at, a.device_id,
                    d.name AS device_name
             FROM alarms a
             LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = $1
             WHERE a.tenant_id = $1 AND a.active = true AND a.device_id = ANY($2)
             ORDER BY a.triggered_at DESC LIMIT 30`;
    params = [ctx.tenantId, filter.mqttIds];
  }

  const { rows } = await db.query(query, params);
  if (!rows.length) {
    await reply(chatId, '\u{2705} Активних аварій немає.', {
      reply_markup: refreshMenuKeyboard('refresh_alarms'),
    }, editMsgId);
    return;
  }

  const lines = rows.map(a => {
    const emoji = a.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
    const name = ALARM_NAMES_UA[a.alarm_code] || a.alarm_code;
    const dev = a.device_name || a.device_id;
    return `${emoji} ${name}\n   ${dev} \u{2022} ${formatTime(a.triggered_at)}`;
  });

  await reply(chatId,
    `\u{1F6A8} Активні аварії (${rows.length}):\n\n${lines.join('\n\n')}`,
    { reply_markup: refreshMenuKeyboard('refresh_alarms') },
    editMsgId
  );
}

async function handleTenantList(chatId, ctx, editMsgId) {
  const { rows: tenants } = await db.query(
    `SELECT t.id, t.name, t.slug FROM user_tenants ut
     JOIN tenants t ON t.id = ut.tenant_id
     WHERE ut.user_id = $1 AND t.active = true ORDER BY t.name`,
    [ctx.user.id]
  );

  if (tenants.length <= 1) {
    await reply(chatId, `Поточний тенант: ${ctx.tenantName}`, {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  }

  const lines = tenants.map(t => {
    const marker = t.id === ctx.tenantId ? ' \u{2190} поточний' : '';
    return `  ${t.slug} \u{2014} ${t.name}${marker}`;
  });

  // Build tenant switch buttons (rows of 2)
  const tenantButtons = [];
  for (let i = 0; i < tenants.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < tenants.length; j++) {
      const t = tenants[j];
      const current = t.id === ctx.tenantId ? '\u{2705} ' : '';
      row.push({ text: `${current}${t.name}`, callback_data: `tenant_${t.slug}` });
    }
    tenantButtons.push(row);
  }
  tenantButtons.push([{ text: '\u{1F4CB} Меню', callback_data: 'menu' }]);

  await reply(chatId,
    `Поточний тенант: ${ctx.tenantName}\n\nДоступні:\n${lines.join('\n')}`,
    { reply_markup: { inline_keyboard: tenantButtons } },
    editMsgId
  );
}

async function handleTenantSwitch(chatId, ctx, slug, editMsgId) {
  const { rows: tenants } = await db.query(
    `SELECT t.id, t.name, t.slug FROM user_tenants ut
     JOIN tenants t ON t.id = ut.tenant_id
     WHERE ut.user_id = $1 AND t.active = true ORDER BY t.name`,
    [ctx.user.id]
  );

  const target = tenants.find(t => t.slug === slug);
  if (!target) {
    await reply(chatId, `Тенант "${slug}" не знайдений серед доступних.`, {
      reply_markup: backToMenuKeyboard(),
    }, editMsgId);
    return;
  }

  tenantContext.set(String(chatId), target.id);
  await reply(chatId,
    `\u{2705} Переключено на: ${target.name} (${target.slug})`,
    { reply_markup: mainMenuKeyboard() },
    editMsgId
  );
}

async function handleHelp(chatId, editMsgId) {
  await reply(chatId, commandList(), {
    reply_markup: mainMenuKeyboard(),
  }, editMsgId);
}

async function sendMainMenu(chatId, editMsgId) {
  await reply(chatId, '\u{1F4CB} Головне меню:', {
    reply_markup: mainMenuKeyboard(),
  }, editMsgId);
}

// ── Bot Commands ──────────────────────────────────────────

function setupCommands() {

  // ── /start [CODE] — link account or show help ──────────

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match?.[1]?.trim();

    try {
      if (!code) {
        // Check if already linked
        const ctx = await resolveUser(chatId);
        if (ctx) {
          await bot.sendMessage(chatId,
            `\u{2705} Акаунт ${ctx.user.email} прив\'язаний.\n\n` +
            commandList(),
            { reply_markup: mainMenuKeyboard() }
          );
          return;
        }
        await bot.sendMessage(chatId,
          'ModESP Cloud Bot\n\n' +
          'Для прив\'язки акаунту отримайте код у WebUI та надішліть:\n' +
          '/start КОД\n\n' +
          'Після прив\'язки ви зможете:\n' +
          '\u{2022} Отримувати сповіщення про аварії\n' +
          '\u{2022} Перевіряти стан пристроїв\n' +
          '\u{2022} Переглядати активні аварії'
        );
        return;
      }

      // Validate link code
      const { rows } = await db.query(
        `SELECT id, email, tenant_id FROM users
         WHERE telegram_link_code = $1
           AND telegram_link_expires > NOW()
           AND active = true`,
        [code]
      );

      if (!rows.length) {
        await bot.sendMessage(chatId,
          '\u{274C} Невірний або прострочений код. Згенеруйте новий у WebUI.'
        );
        return;
      }

      const user = rows[0];

      // Check if this telegram_id is already linked to ANOTHER user
      const { rows: existing } = await db.query(
        'SELECT id, email FROM users WHERE telegram_id = $1 AND id != $2',
        [chatId, user.id]
      );
      if (existing.length) {
        await bot.sendMessage(chatId,
          `Цей Telegram вже прив\'язаний до ${existing[0].email}.\n` +
          'Спочатку відв\'яжіть його командою /unlink.'
        );
        return;
      }

      // Link account
      await db.query(
        `UPDATE users SET telegram_id = $1, telegram_link_code = NULL, telegram_link_expires = NULL
         WHERE id = $2`,
        [chatId, user.id]
      );

      await bot.sendMessage(chatId,
        `\u{2705} Акаунт ${user.email} успішно прив\'язаний!\n` +
        'Ви будете отримувати сповіщення про аварії.',
        { reply_markup: mainMenuKeyboard() }
      );

      logger.info({ chatId, userId: user.id, email: user.email }, 'Telegram account linked');
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /start error');
      await safeSend(chatId, '\u{274C} Помилка. Спробуйте пізніше.');
    }
  });

  // ── /devices — RBAC-aware device list ──────────────────

  bot.onText(/\/devices/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);
      await handleDevices(chatId, ctx);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /devices error');
      await safeSend(chatId, '\u{274C} Помилка отримання списку.');
    }
  });

  // ── /status DEVICE_ID — detailed device state ──────────

  bot.onText(/\/status(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const deviceIdArg = match?.[1]?.trim()?.toUpperCase();

    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      if (!deviceIdArg) {
        await bot.sendMessage(chatId,
          'Використання: /status ID\nНаприклад: /status F27FCD',
          { reply_markup: backToMenuKeyboard() }
        );
        return;
      }

      await handleStatus(chatId, ctx, deviceIdArg);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /status error');
      await safeSend(chatId, '\u{274C} Помилка отримання статусу.');
    }
  });

  // ── /alarms — active alarms for accessible devices ─────

  bot.onText(/\/alarms/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);
      await handleAlarms(chatId, ctx);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /alarms error');
      await safeSend(chatId, '\u{274C} Помилка отримання аварій.');
    }
  });

  // ── /tenant [slug] — show or switch tenant ─────────────

  bot.onText(/\/tenant(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      const targetSlug = match?.[1]?.trim();
      if (!targetSlug) {
        await handleTenantList(chatId, ctx);
        return;
      }
      await handleTenantSwitch(chatId, ctx, targetSlug);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /tenant error');
    }
  });

  // ── /unlink — unlink Telegram account ──────────────────

  bot.onText(/\/unlink/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const { rowCount } = await db.query(
        'UPDATE users SET telegram_id = NULL WHERE telegram_id = $1 AND active = true',
        [chatId]
      );

      tenantContext.delete(String(chatId));

      if (rowCount > 0) {
        await bot.sendMessage(chatId,
          '\u{2705} Акаунт відв\'язаний. Сповіщення вимкнені.\n' +
          'Для повторної прив\'язки отримайте новий код.'
        );
      } else {
        await bot.sendMessage(chatId, 'Цей Telegram не прив\'язаний до жодного акаунту.');
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /unlink error');
    }
  });

  // ── /help — command list ───────────────────────────────

  bot.onText(/\/help/, async (msg) => {
    await handleHelp(msg.chat.id);
  });

  // ── /menu — show main menu ─────────────────────────────

  bot.onText(/\/menu/, async (msg) => {
    await sendMainMenu(msg.chat.id);
  });

  // ── Callback query handler (inline button taps) ────────

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id; // edit this message in-place

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (_) { /* ignore if already answered */ }

    try {
      // Main menu doesn't need auth
      if (query.data === 'menu') {
        return sendMainMenu(chatId, msgId);
      }
      if (query.data === 'menu_help') {
        return handleHelp(chatId, msgId);
      }

      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      switch (query.data) {
        case 'menu_devices':
        case 'refresh_devices':
          return handleDevices(chatId, ctx, msgId);

        case 'menu_alarms':
        case 'refresh_alarms':
          return handleAlarms(chatId, ctx, msgId);

        case 'menu_tenant':
          return handleTenantList(chatId, ctx, msgId);

        default:
          if (query.data.startsWith('tenant_')) {
            const slug = query.data.slice(7);
            return handleTenantSwitch(chatId, ctx, slug, msgId);
          }
          if (query.data.startsWith('status_')) {
            const deviceId = query.data.slice(7);
            return handleStatus(chatId, ctx, deviceId, msgId);
          }
      }
    } catch (err) {
      logger.error({ err, chatId, data: query.data }, 'Telegram callback_query error');
      await safeSend(chatId, '\u{274C} Помилка. Спробуйте пізніше.');
    }
  });
}

function commandList() {
  return (
    'Команди ModESP Bot:\n\n' +
    '/devices \u{2014} список пристроїв\n' +
    '/status ID \u{2014} детальний стан пристрою\n' +
    '/alarms \u{2014} активні аварії\n' +
    '/tenant \u{2014} показати/переключити тенант\n' +
    '/unlink \u{2014} відв\'язати Telegram\n' +
    '/menu \u{2014} головне меню\n' +
    '/help \u{2014} ця довідка'
  );
}

// ── Send notification ─────────────────────────────────────

/**
 * Send notification to a Telegram chat.
 * Supports: alarm raised, alarm cleared, device offline, test.
 * @param {string} chatId
 * @param {object} payload
 */
async function send(chatId, payload) {
  if (!bot) throw new Error('Telegram bot not initialized');

  let message;
  if (payload.isTest) {
    message = buildTestMessage(payload);
  } else if (payload.type === 'device_offline') {
    message = buildOfflineMessage(payload);
  } else if (payload.active === false) {
    message = buildAlarmClearedMessage(payload);
  } else {
    message = buildAlarmRaisedMessage(payload);
  }

  await bot.sendMessage(chatId, message);
}

function buildTestMessage(payload) {
  return (
    `\u{1F514} Тестове сповіщення ModESP Cloud\n\n` +
    `Якщо ви бачите це повідомлення \u{2014} сповіщення працюють коректно!\n` +
    `\u{23F0} ${formatTime(payload.timestamp)}`
  );
}

function buildAlarmRaisedMessage(payload) {
  const alarmName = ALARM_NAMES_UA[payload.alarmCode] || payload.alarmCode;
  const emoji = SEVERITY_EMOJI[payload.severity] || SEVERITY_EMOJI.warning;
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  const lines = [
    `${emoji} АВАРІЯ: ${alarmName}`,
    `\u{1F4CD} Пристрій: ${deviceLabel}`,
  ];

  if (payload.airTemp != null) {
    lines.push(`\u{1F321}\u{FE0F} Температура: ${Number(payload.airTemp).toFixed(1)}\u{00B0}C`);
  }
  if (payload.severity === 'critical') {
    lines.push(`\n\u{26A0}\u{FE0F} Критична аварія \u{2014} потрібна негайна увага!`);
  }
  lines.push(`\u{23F0} ${formatTime(payload.timestamp)}`);

  return lines.join('\n');
}

function buildAlarmClearedMessage(payload) {
  const alarmName = ALARM_NAMES_UA[payload.alarmCode] || payload.alarmCode;
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  const lines = [
    `\u{1F7E2} Аварія зникла: ${alarmName}`,
    `\u{1F4CD} Пристрій: ${deviceLabel}`,
  ];

  if (payload.airTemp != null) {
    lines.push(`\u{1F321}\u{FE0F} Температура: ${Number(payload.airTemp).toFixed(1)}\u{00B0}C`);
  }
  if (payload.duration != null) {
    lines.push(`\u{23F1}\u{FE0F} Тривалість: ${formatDuration(payload.duration)}`);
  }
  lines.push(`\u{23F0} ${formatTime(payload.timestamp)}`);

  return lines.join('\n');
}

function buildOfflineMessage(payload) {
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  return [
    `\u{26AA} Пристрій офлайн: ${deviceLabel}`,
    `\u{1F550} Востаннє: ${formatTime(payload.lastSeen)}`,
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────

function formatTime(isoStr) {
  if (!isoStr) return '\u{2014}';
  return new Date(isoStr).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1 хв';
  if (mins < 60) return `${mins} хв`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} год ${m} хв` : `${h} год`;
}

/** Safe send — won't throw if chat is blocked/deleted */
async function safeSend(chatId, text) {
  try {
    if (bot) await bot.sendMessage(chatId, text);
  } catch (_) { /* ignore send errors in error handlers */ }
}

module.exports = { init, shutdown };
