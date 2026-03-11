'use strict';

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

let bot = null;
let logger = null;

// In-memory tenant context for multi-tenant users: Map<chatId_str, tenantId>
const tenantContext = new Map();

/** @type {Map<string, number>}  chatId_str → last bot message_id (for cleanup) */
const lastBotMsg = new Map();

/** @type {Map<string, string>}  chatId_str → 'uk' | 'en' */
const langContext = new Map();

// ── i18n ──────────────────────────────────────────────────

const STRINGS = {
  uk: {
    btn_devices: '\u{1F4E6} Пристрої',
    btn_alarms:  '\u{1F6A8} Аварії',
    btn_tenant:  '\u{1F504} Тенант',
    btn_lang:    '\u{1F310} EN',
    devices_title: '\u{1F4E6} Пристрої',
    devices_empty: 'Немає активних пристроїв.',
    devices_no_access: 'У вас немає призначених пристроїв.',
    alarms_title: '\u{1F6A8} Активні аварії',
    alarms_empty: '\u{2705} Активних аварій немає.',
    alarms_no_access: 'У вас немає призначених пристроїв.',
    status_online: '\u{1F7E2} Онлайн',
    status_offline: '\u{26AA} Офлайн',
    status_not_found: 'Пристрій не знайдений.',
    status_no_access: '\u{1F6AB} У вас немає доступу до цього пристрою.',
    status_usage: 'Використання: /status ID\nНаприклад: /status F27FCD',
    status_label: 'Статус',
    last_seen: 'Востаннє',
    air_temp: '\u{1F321}\u{FE0F} Повітря',
    evap_temp: '\u{2744}\u{FE0F} Випарник',
    setpoint: '\u{1F3AF} Уставка',
    compressor: '\u{2699}\u{FE0F} Компресор',
    compressor_on: 'Увімк',
    compressor_off: 'Вимк',
    defrost_active: '\u{1F525} Розморозка: Активна',
    active_alarms: '\u{1F6A8} Активні аварії',
    current_tenant: 'Поточний тенант',
    available_tenants: 'Доступні',
    tenant_not_found: 'Тенант не знайдений серед доступних.',
    tenant_switched: '\u{2705} Переключено на',
    tenant_current: 'поточний',
    account_linked_msg: '\u{2705} Акаунт прив\'язаний.',
    use_buttons: 'Використовуйте кнопки внизу \u{2B07}\u{FE0F}',
    link_prompt: 'ModESP Cloud Bot\n\nДля прив\'язки акаунту отримайте код у WebUI та надішліть:\n/start КОД',
    link_success: '\u{2705} Акаунт успішно прив\'язаний!\nВи будете отримувати сповіщення про аварії.',
    link_invalid: '\u{274C} Невірний або прострочений код. Згенеруйте новий у WebUI.',
    link_other_user: 'Цей Telegram вже прив\'язаний до',
    unlink_first: 'Спочатку відв\'яжіть його командою /unlink.',
    not_linked: 'Telegram не прив\'язаний до акаунту ModESP.\nОтримайте код у веб-інтерфейсі та надішліть: /start КОД',
    unlinked: '\u{2705} Акаунт відв\'язаний. Сповіщення вимкнені.\nДля повторної прив\'язки отримайте новий код.',
    not_linked_any: 'Цей Telegram не прив\'язаний до жодного акаунту.',
    lang_switched: '\u{1F310} Мова: Українська',
    error: '\u{274C} Помилка. Спробуйте пізніше.',
    // Notification messages
    alarm_raised: 'АВАРІЯ',
    alarm_cleared: 'Аварія зникла',
    temperature: '\u{1F321}\u{FE0F} Температура',
    critical_alarm: '\u{26A0}\u{FE0F} Критична аварія \u{2014} потрібна негайна увага!',
    duration_label: '\u{23F1}\u{FE0F} Тривалість',
    device_offline_msg: '\u{26AA} Пристрій офлайн',
    device_last_seen: '\u{1F550} Востаннє',
    test_notification: '\u{1F514} Тестове сповіщення ModESP Cloud\n\nЯкщо ви бачите це повідомлення \u{2014} сповіщення працюють коректно!',
    device_label: '\u{1F4CD} Пристрій',
    // Alarm names
    alarm_high_temp:       'Висока температура',
    alarm_low_temp:        'Низька температура',
    alarm_sensor1:         'Несправність датчика 1',
    alarm_sensor2:         'Несправність датчика 2',
    alarm_door:            'Двері відкриті',
    alarm_short_cycle:     'Короткий цикл компресора',
    alarm_rapid_cycle:     'Часті цикли компресора',
    alarm_continuous_run:  'Безперервна робота компресора',
    alarm_pulldown:        'Повільне охолодження',
    alarm_rate:            'Швидка зміна температури',
    alarm_test:            'Тестове сповіщення',
    duration_min: 'хв',
    duration_hour: 'год',
    duration_less: '<1 хв',
    // Inline buttons
    btn_refresh: '\u{1F504}',
    btn_back_devices: '\u{1F4E6} Пристрої',
  },
  en: {
    btn_devices: '\u{1F4E6} Devices',
    btn_alarms:  '\u{1F6A8} Alarms',
    btn_tenant:  '\u{1F504} Tenant',
    btn_lang:    '\u{1F310} UA',
    devices_title: '\u{1F4E6} Devices',
    devices_empty: 'No active devices.',
    devices_no_access: 'You have no assigned devices.',
    alarms_title: '\u{1F6A8} Active alarms',
    alarms_empty: '\u{2705} No active alarms.',
    alarms_no_access: 'You have no assigned devices.',
    status_online: '\u{1F7E2} Online',
    status_offline: '\u{26AA} Offline',
    status_not_found: 'Device not found.',
    status_no_access: '\u{1F6AB} You don\'t have access to this device.',
    status_usage: 'Usage: /status ID\nExample: /status F27FCD',
    status_label: 'Status',
    last_seen: 'Last seen',
    air_temp: '\u{1F321}\u{FE0F} Air',
    evap_temp: '\u{2744}\u{FE0F} Evaporator',
    setpoint: '\u{1F3AF} Setpoint',
    compressor: '\u{2699}\u{FE0F} Compressor',
    compressor_on: 'On',
    compressor_off: 'Off',
    defrost_active: '\u{1F525} Defrost: Active',
    active_alarms: '\u{1F6A8} Active alarms',
    current_tenant: 'Current tenant',
    available_tenants: 'Available',
    tenant_not_found: 'Tenant not found among available.',
    tenant_switched: '\u{2705} Switched to',
    tenant_current: 'current',
    account_linked_msg: '\u{2705} Account linked.',
    use_buttons: 'Use the buttons below \u{2B07}\u{FE0F}',
    link_prompt: 'ModESP Cloud Bot\n\nTo link your account, get a code in WebUI and send:\n/start CODE',
    link_success: '\u{2705} Account linked successfully!\nYou will receive alarm notifications.',
    link_invalid: '\u{274C} Invalid or expired code. Generate a new one in WebUI.',
    link_other_user: 'This Telegram is already linked to',
    unlink_first: 'Unlink it first with /unlink.',
    not_linked: 'Telegram is not linked to a ModESP account.\nGet a code in WebUI and send: /start CODE',
    unlinked: '\u{2705} Account unlinked. Notifications disabled.\nTo re-link, get a new code.',
    not_linked_any: 'This Telegram is not linked to any account.',
    lang_switched: '\u{1F310} Language: English',
    error: '\u{274C} Error. Try again later.',
    alarm_raised: 'ALARM',
    alarm_cleared: 'Alarm cleared',
    temperature: '\u{1F321}\u{FE0F} Temperature',
    critical_alarm: '\u{26A0}\u{FE0F} Critical alarm \u{2014} immediate attention required!',
    duration_label: '\u{23F1}\u{FE0F} Duration',
    device_offline_msg: '\u{26AA} Device offline',
    device_last_seen: '\u{1F550} Last seen',
    test_notification: '\u{1F514} ModESP Cloud test notification\n\nIf you see this message \u{2014} notifications are working correctly!',
    device_label: '\u{1F4CD} Device',
    alarm_high_temp:       'High temperature',
    alarm_low_temp:        'Low temperature',
    alarm_sensor1:         'Sensor 1 fault',
    alarm_sensor2:         'Sensor 2 fault',
    alarm_door:            'Door open',
    alarm_short_cycle:     'Short compressor cycle',
    alarm_rapid_cycle:     'Rapid compressor cycling',
    alarm_continuous_run:  'Continuous compressor run',
    alarm_pulldown:        'Slow cooldown',
    alarm_rate:            'Rapid temperature change',
    alarm_test:            'Test notification',
    duration_min: 'min',
    duration_hour: 'h',
    duration_less: '<1 min',
    btn_refresh: '\u{1F504}',
    btn_back_devices: '\u{1F4E6} Devices',
  },
};

const ALARM_KEY_MAP = {
  high_temp_alarm:       'alarm_high_temp',
  low_temp_alarm:        'alarm_low_temp',
  sensor1_alarm:         'alarm_sensor1',
  sensor2_alarm:         'alarm_sensor2',
  door_alarm:            'alarm_door',
  short_cycle_alarm:     'alarm_short_cycle',
  rapid_cycle_alarm:     'alarm_rapid_cycle',
  continuous_run_alarm:  'alarm_continuous_run',
  pulldown_alarm:        'alarm_pulldown',
  rate_alarm:            'alarm_rate',
  test_notification:     'alarm_test',
};

const SEVERITY_EMOJI = {
  critical: '\u{1F6A8}',        // 🚨
  warning:  '\u{26A0}\u{FE0F}', // ⚠️
  info:     '\u{2139}\u{FE0F}', // ℹ️
};

/** Get language for chat */
function lang(chatId) {
  return langContext.get(String(chatId)) || 'uk';
}

/** Get translated string */
function t(chatId, key) {
  const l = lang(chatId);
  return STRINGS[l]?.[key] || STRINGS.uk[key] || key;
}

/** Get alarm name translated */
function getAlarmName(chatId, alarmCode) {
  const key = ALARM_KEY_MAP[alarmCode];
  return key ? t(chatId, key) : alarmCode;
}

// ── Persistent Reply Keyboard (bottom buttons) ──────────

function persistentKeyboard(chatId) {
  return {
    keyboard: [
      [{ text: t(chatId, 'btn_devices') }, { text: t(chatId, 'btn_alarms') }],
      [{ text: t(chatId, 'btn_tenant') },  { text: t(chatId, 'btn_lang') }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** Check if text matches any language variant of a button */
function matchButton(text) {
  for (const l of ['uk', 'en']) {
    if (text === STRINGS[l].btn_devices) return 'devices';
    if (text === STRINGS[l].btn_alarms)  return 'alarms';
    if (text === STRINGS[l].btn_tenant)  return 'tenant';
    if (text === STRINGS[l].btn_lang)    return 'lang';
  }
  return null;
}

// ── Init / Shutdown ───────────────────────────────────────

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
  lastBotMsg.clear();
  langContext.clear();
}

// ── User Context Resolution ──────────────────────────────

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

async function sendNotLinked(chatId) {
  await bot.sendMessage(chatId, t(chatId, 'not_linked'));
}

/**
 * Send new message or edit existing one in-place.
 */
async function reply(chatId, text, opts, editMsgId) {
  if (editMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
      lastBotMsg.set(String(chatId), editMsgId);
      return;
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        logger.debug({ err: err.message, chatId, editMsgId }, 'Edit failed, sending new message');
      } else {
        return;
      }
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  if (sent?.message_id) lastBotMsg.set(String(chatId), sent.message_id);
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
    await reply(chatId, t(chatId, 'devices_no_access'), {}, editMsgId);
    return;
  } else {
    query = `SELECT mqtt_device_id, name, online, last_state
             FROM devices WHERE tenant_id = $1 AND id = ANY($2) AND status = 'active'
             ORDER BY name NULLS LAST`;
    params = [ctx.tenantId, filter.uuids];
  }

  const { rows } = await db.query(query, params);
  if (!rows.length) {
    await reply(chatId, t(chatId, 'devices_empty'), {}, editMsgId);
    return;
  }

  const lines = rows.map(d => {
    const dot = d.online ? '\u{1F7E2}' : '\u{26AA}';
    const name = d.name || d.mqtt_device_id;
    const temp = Number(d.last_state?.['equipment.air_temp']);
    const tempStr = isFinite(temp) ? `  ${temp.toFixed(1)}\u{00B0}C` : '';
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

  await reply(chatId,
    `${t(chatId, 'devices_title')} [${ctx.tenantName}] (${rows.length}):\n\n${lines.join('\n')}`,
    { reply_markup: { inline_keyboard: deviceButtons } },
    editMsgId
  );
}

async function handleStatus(chatId, ctx, deviceIdArg, editMsgId) {
  const filter = await getUserDeviceFilter(ctx.user.id, ctx.user.role, ctx.tenantId);
  if (filter && !filter.mqttIds.includes(deviceIdArg)) {
    await reply(chatId, t(chatId, 'status_no_access'), {}, editMsgId);
    return;
  }

  const { rows } = await db.query(
    `SELECT mqtt_device_id, name, online, last_seen, firmware_version, last_state, location
     FROM devices WHERE tenant_id = $1 AND mqtt_device_id = $2 AND status = 'active'`,
    [ctx.tenantId, deviceIdArg]
  );

  if (!rows.length) {
    await reply(chatId, `${t(chatId, 'status_not_found')} (${deviceIdArg})`, {}, editMsgId);
    return;
  }

  const d = rows[0];
  const s = d.last_state || {};
  const dot = d.online ? t(chatId, 'status_online') : t(chatId, 'status_offline');
  const name = d.name || d.mqtt_device_id;

  const lines = [
    `\u{1F4CD} ${name} (${d.mqtt_device_id})`,
  ];
  if (d.location) {
    lines.push(`\u{1F4CD} ${d.location}`);
  }
  lines.push(`${t(chatId, 'status_label')}: ${dot}`);

  if (d.last_seen) {
    lines.push(`${t(chatId, 'last_seen')}: ${formatTime(chatId, d.last_seen)}`);
  }
  const airT = Number(s['equipment.air_temp']);
  if (isFinite(airT)) {
    lines.push(`${t(chatId, 'air_temp')}: ${airT.toFixed(1)}\u{00B0}C`);
  }
  const evapT = Number(s['equipment.evap_temp']);
  if (isFinite(evapT)) {
    lines.push(`${t(chatId, 'evap_temp')}: ${evapT.toFixed(1)}\u{00B0}C`);
  }
  const setpT = Number(s['thermostat.effective_setpoint']);
  if (isFinite(setpT)) {
    lines.push(`${t(chatId, 'setpoint')}: ${setpT.toFixed(1)}\u{00B0}C`);
  }
  if (s['equipment.compressor'] != null) {
    const onOff = s['equipment.compressor'] ? t(chatId, 'compressor_on') : t(chatId, 'compressor_off');
    lines.push(`${t(chatId, 'compressor')}: ${onOff}`);
  }
  if (s['defrost.active'] != null && s['defrost.active']) {
    lines.push(t(chatId, 'defrost_active'));
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
    lines.push(`${t(chatId, 'active_alarms')} (${alarms.length}):`);
    for (const a of alarms) {
      const aName = getAlarmName(chatId, a.alarm_code);
      const emoji = a.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
      lines.push(`  ${emoji} ${aName}`);
    }
  }

  if (d.firmware_version) {
    lines.push(`\nFW: ${d.firmware_version}`);
  }

  await reply(chatId, lines.join('\n'), {}, editMsgId);
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
    await reply(chatId, t(chatId, 'alarms_no_access'), {}, editMsgId);
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
    await reply(chatId, t(chatId, 'alarms_empty'), {}, editMsgId);
    return;
  }

  const lines = rows.map(a => {
    const emoji = a.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
    const name = getAlarmName(chatId, a.alarm_code);
    const dev = a.device_name || a.device_id;
    return `${emoji} ${name}\n   ${dev} \u{2022} ${formatTime(chatId, a.triggered_at)}`;
  });

  await reply(chatId,
    `${t(chatId, 'alarms_title')} (${rows.length}):\n\n${lines.join('\n\n')}`,
    {},
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
    await reply(chatId, `${t(chatId, 'current_tenant')}: ${ctx.tenantName}`, {}, editMsgId);
    return;
  }

  const lines = tenants.map(tn => {
    const marker = tn.id === ctx.tenantId ? ` \u{2190} ${t(chatId, 'tenant_current')}` : '';
    return `  ${tn.slug} \u{2014} ${tn.name}${marker}`;
  });

  // Build tenant switch buttons (rows of 2)
  const tenantButtons = [];
  for (let i = 0; i < tenants.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < tenants.length; j++) {
      const tn = tenants[j];
      const current = tn.id === ctx.tenantId ? '\u{2705} ' : '';
      row.push({ text: `${current}${tn.name}`, callback_data: `tenant_${tn.slug}` });
    }
    tenantButtons.push(row);
  }

  await reply(chatId,
    `${t(chatId, 'current_tenant')}: ${ctx.tenantName}\n\n${t(chatId, 'available_tenants')}:\n${lines.join('\n')}`,
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

  const target = tenants.find(tn => tn.slug === slug);
  if (!target) {
    await reply(chatId, `${t(chatId, 'tenant_not_found')} ("${slug}")`, {}, editMsgId);
    return;
  }

  tenantContext.set(String(chatId), target.id);
  await reply(chatId,
    `${t(chatId, 'tenant_switched')}: ${target.name} (${target.slug})`,
    {},
    editMsgId
  );
}

// ── Bot Commands ──────────────────────────────────────────

function setupCommands() {

  bot.setMyCommands([
    { command: 'devices', description: '\u{1F4E6} Пристрої / Devices' },
    { command: 'alarms',  description: '\u{1F6A8} Аварії / Alarms' },
    { command: 'tenant',  description: '\u{1F504} Тенант / Tenant' },
    { command: 'status',  description: '\u{1F4CA} Статус пристрою / Device status' },
    { command: 'unlink',  description: '\u{274C} Відв\'язати / Unlink' },
  ]).catch(err => logger.warn({ err: err.message }, 'Failed to set bot commands'));

  // ── Persistent keyboard text handler ───────────────────

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    const handler = matchButton(text);
    if (!handler) return;

    // Delete the user's button-tap message
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

    // Delete previous bot response
    const prevMsgId = lastBotMsg.get(String(chatId));
    if (prevMsgId) {
      try { await bot.deleteMessage(chatId, prevMsgId); } catch (_) {}
    }

    try {
      // Language switch
      if (handler === 'lang') {
        const current = lang(chatId);
        const newLang = current === 'uk' ? 'en' : 'uk';
        langContext.set(String(chatId), newLang);
        await bot.sendMessage(chatId, t(chatId, 'lang_switched'), {
          reply_markup: persistentKeyboard(chatId),
        });
        return;
      }

      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      switch (handler) {
        case 'devices': return handleDevices(chatId, ctx);
        case 'alarms':  return handleAlarms(chatId, ctx);
        case 'tenant':  return handleTenantList(chatId, ctx);
      }
    } catch (err) {
      logger.error({ err, chatId, handler }, 'Telegram button handler error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });

  // ── /start [CODE] — link account or show help ──────────

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match?.[1]?.trim();

    try {
      if (!code) {
        const ctx = await resolveUser(chatId);
        if (ctx) {
          await bot.sendMessage(chatId,
            `${t(chatId, 'account_linked_msg')} (${ctx.user.email})\n\n${t(chatId, 'use_buttons')}`,
            { reply_markup: persistentKeyboard(chatId) }
          );
          return;
        }
        await bot.sendMessage(chatId, t(chatId, 'link_prompt'));
        return;
      }

      const { rows } = await db.query(
        `SELECT id, email, tenant_id FROM users
         WHERE telegram_link_code = $1
           AND telegram_link_expires > NOW()
           AND active = true`,
        [code]
      );

      if (!rows.length) {
        await bot.sendMessage(chatId, t(chatId, 'link_invalid'));
        return;
      }

      const user = rows[0];

      const { rows: existing } = await db.query(
        'SELECT id, email FROM users WHERE telegram_id = $1 AND id != $2',
        [chatId, user.id]
      );
      if (existing.length) {
        await bot.sendMessage(chatId,
          `${t(chatId, 'link_other_user')} ${existing[0].email}.\n${t(chatId, 'unlink_first')}`
        );
        return;
      }

      await db.query(
        `UPDATE users SET telegram_id = $1, telegram_link_code = NULL, telegram_link_expires = NULL
         WHERE id = $2`,
        [chatId, user.id]
      );

      await bot.sendMessage(chatId,
        `${t(chatId, 'link_success')}\n\n${t(chatId, 'use_buttons')}`,
        { reply_markup: persistentKeyboard(chatId) }
      );

      logger.info({ chatId, userId: user.id, email: user.email }, 'Telegram account linked');
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /start error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });

  // ── /devices ──────────────────────────────────────────

  bot.onText(/\/devices/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);
      await handleDevices(chatId, ctx);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /devices error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });

  // ── /status DEVICE_ID ─────────────────────────────────

  bot.onText(/\/status(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const deviceIdArg = match?.[1]?.trim()?.toUpperCase();

    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      if (!deviceIdArg) {
        await bot.sendMessage(chatId, t(chatId, 'status_usage'));
        return;
      }

      await handleStatus(chatId, ctx, deviceIdArg);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /status error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });

  // ── /alarms ───────────────────────────────────────────

  bot.onText(/\/alarms/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);
      await handleAlarms(chatId, ctx);
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /alarms error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });

  // ── /tenant [slug] ───────────────────────────────────

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

  // ── /unlink ───────────────────────────────────────────

  bot.onText(/\/unlink/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const { rowCount } = await db.query(
        'UPDATE users SET telegram_id = NULL WHERE telegram_id = $1 AND active = true',
        [chatId]
      );

      tenantContext.delete(String(chatId));
      langContext.delete(String(chatId));

      if (rowCount > 0) {
        await bot.sendMessage(chatId, t(chatId, 'unlinked'));
      } else {
        await bot.sendMessage(chatId, t(chatId, 'not_linked_any'));
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Telegram /unlink error');
    }
  });

  // ── Callback query handler (inline button taps) ────────
  // Only device status and tenant switch buttons

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (_) {}

    try {
      const ctx = await resolveUser(chatId);
      if (!ctx) return sendNotLinked(chatId);

      if (query.data.startsWith('tenant_')) {
        const slug = query.data.slice(7);
        return handleTenantSwitch(chatId, ctx, slug, msgId);
      }
      if (query.data.startsWith('status_')) {
        const deviceId = query.data.slice(7);
        return handleStatus(chatId, ctx, deviceId, msgId);
      }
    } catch (err) {
      logger.error({ err, chatId, data: query.data }, 'Telegram callback_query error');
      await safeSend(chatId, t(chatId, 'error'));
    }
  });
}

// ── Send notification ─────────────────────────────────────

async function send(chatId, payload) {
  if (!bot) throw new Error('Telegram bot not initialized');

  let message;
  if (payload.isTest) {
    message = buildTestMessage(chatId, payload);
  } else if (payload.type === 'device_offline') {
    message = buildOfflineMessage(chatId, payload);
  } else if (payload.active === false) {
    message = buildAlarmClearedMessage(chatId, payload);
  } else {
    message = buildAlarmRaisedMessage(chatId, payload);
  }

  await bot.sendMessage(chatId, message);
}

function buildTestMessage(chatId, payload) {
  return `${t(chatId, 'test_notification')}\n\u{23F0} ${formatTime(chatId, payload.timestamp)}`;
}

function buildAlarmRaisedMessage(chatId, payload) {
  const aName = getAlarmName(chatId, payload.alarmCode);
  const emoji = SEVERITY_EMOJI[payload.severity] || SEVERITY_EMOJI.warning;
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  const lines = [
    `${emoji} ${t(chatId, 'alarm_raised')}: ${aName}`,
    `${t(chatId, 'device_label')}: ${deviceLabel}`,
  ];

  const airTemp = Number(payload.airTemp);
  if (payload.airTemp != null && isFinite(airTemp)) {
    lines.push(`${t(chatId, 'temperature')}: ${airTemp.toFixed(1)}\u{00B0}C`);
  }
  if (payload.severity === 'critical') {
    lines.push(`\n${t(chatId, 'critical_alarm')}`);
  }
  lines.push(`\u{23F0} ${formatTime(chatId, payload.timestamp)}`);

  return lines.join('\n');
}

function buildAlarmClearedMessage(chatId, payload) {
  const aName = getAlarmName(chatId, payload.alarmCode);
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  const lines = [
    `\u{1F7E2} ${t(chatId, 'alarm_cleared')}: ${aName}`,
    `${t(chatId, 'device_label')}: ${deviceLabel}`,
  ];

  const airTemp = Number(payload.airTemp);
  if (payload.airTemp != null && isFinite(airTemp)) {
    lines.push(`${t(chatId, 'temperature')}: ${airTemp.toFixed(1)}\u{00B0}C`);
  }
  if (payload.duration != null) {
    lines.push(`${t(chatId, 'duration_label')}: ${formatDuration(chatId, payload.duration)}`);
  }
  lines.push(`\u{23F0} ${formatTime(chatId, payload.timestamp)}`);

  return lines.join('\n');
}

function buildOfflineMessage(chatId, payload) {
  const deviceLabel = payload.deviceName
    ? `${payload.deviceName} (${payload.deviceId})`
    : payload.deviceId;

  return [
    `${t(chatId, 'device_offline_msg')}: ${deviceLabel}`,
    `${t(chatId, 'device_last_seen')}: ${formatTime(chatId, payload.lastSeen)}`,
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────

function formatTime(chatId, isoStr) {
  if (!isoStr) return '\u{2014}';
  const locale = lang(chatId) === 'en' ? 'en-GB' : 'uk-UA';
  return new Date(isoStr).toLocaleString(locale, {
    timeZone: 'Europe/Kyiv',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(chatId, ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return t(chatId, 'duration_less');
  if (mins < 60) return `${mins} ${t(chatId, 'duration_min')}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hourLabel = t(chatId, 'duration_hour');
  const minLabel = t(chatId, 'duration_min');
  return m > 0 ? `${h} ${hourLabel} ${m} ${minLabel}` : `${h} ${hourLabel}`;
}

/** Safe send — won't throw if chat is blocked/deleted */
async function safeSend(chatId, text) {
  try {
    if (bot) await bot.sendMessage(chatId, text);
  } catch (_) {}
}

module.exports = { init, shutdown };
