'use strict';

const { Resend } = require('resend');

let resend = null;
let logger = null;
let fromAddress = null;
let appUrl = null;

// ── Dictionaries (uk / en / pl / de — plan epic 2.11) ─────
// scripts/check-locales.js fails CI when one language lacks a key.

const { pickLocale, formatDateTime, formatDuration: fmtDuration } = require('../lib/locale');

const ALARM_NAMES = {
  uk: {
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
    'device_offline':                   'Пристрій офлайн',
    'test_notification':                'Тестове сповіщення',
  },
  en: {
    'protection.high_temp_alarm':       'High Temperature',
    'protection.low_temp_alarm':        'Low Temperature',
    'protection.sensor1_alarm':         'Sensor 1 Fault',
    'protection.sensor2_alarm':         'Sensor 2 Fault',
    'protection.door_alarm':            'Door Open',
    'protection.short_cycle_alarm':     'Short Cycle',
    'protection.rapid_cycle_alarm':     'Rapid Cycling',
    'protection.continuous_run_alarm':  'Continuous Run',
    'protection.pulldown_alarm':        'Slow Pulldown',
    'protection.rate_alarm':            'Rapid Temperature Change',
    'device_offline':                   'Device Offline',
    'test_notification':                'Test Notification',
  },
  pl: {
    'protection.high_temp_alarm':       'Wysoka temperatura',
    'protection.low_temp_alarm':        'Niska temperatura',
    'protection.sensor1_alarm':         'Awaria czujnika 1',
    'protection.sensor2_alarm':         'Awaria czujnika 2',
    'protection.door_alarm':            'Drzwi otwarte',
    'protection.short_cycle_alarm':     'Krótki cykl',
    'protection.rapid_cycle_alarm':     'Częste cykle',
    'protection.continuous_run_alarm':  'Praca ciągła',
    'protection.pulldown_alarm':        'Wolne schładzanie',
    'protection.rate_alarm':            'Szybka zmiana temperatury',
    'device_offline':                   'Urządzenie offline',
    'test_notification':                'Powiadomienie testowe',
  },
  de: {
    'protection.high_temp_alarm':       'Hohe Temperatur',
    'protection.low_temp_alarm':        'Niedrige Temperatur',
    'protection.sensor1_alarm':         'Fühler 1 defekt',
    'protection.sensor2_alarm':         'Fühler 2 defekt',
    'protection.door_alarm':            'Tür offen',
    'protection.short_cycle_alarm':     'Kurzer Zyklus',
    'protection.rapid_cycle_alarm':     'Häufige Zyklen',
    'protection.continuous_run_alarm':  'Dauerlauf',
    'protection.pulldown_alarm':        'Langsames Abkühlen',
    'protection.rate_alarm':            'Schnelle Temperaturänderung',
    'device_offline':                   'Gerät offline',
    'test_notification':                'Testbenachrichtigung',
  },
};

const SEVERITY_COLORS = {
  critical: '#dc2626',
  warning:  '#f59e0b',
  info:     '#3b82f6',
};

const SEVERITY_LABELS = {
  uk: { critical: 'Критично', warning: 'Попередження', info: 'Інформація' },
  en: { critical: 'Critical', warning: 'Warning', info: 'Info' },
  pl: { critical: 'Krytyczny', warning: 'Ostrzeżenie', info: 'Informacja' },
  de: { critical: 'Kritisch', warning: 'Warnung', info: 'Info' },
};

// Labels of the notification e-mails. {0}, {1}, … are filled by fmt().
const L = {
  uk: {
    test_subject:   'ModESP Cloud — Тестове сповіщення',
    test_title:     'Тестове сповіщення',
    test_body:      'Email-канал налаштовано правильно. Сповіщення будуть надходити на цю адресу.',
    device:         'Пристрій',
    location:       'Розташування',
    temperature:    'Температура',
    time:           'Час',
    open_device:    'Відкрити пристрій',
    escalation:     '⏫ Не підтверджено {0} хв: ',
    cleared_subject: '✅ {0} знято — {1}',
    cleared_title:  '{0} — знято',
    duration:       'Тривалість',
    offline_subject: '⚠️ {0} — пристрій офлайн',
    offline_title:  'Пристрій офлайн',
    last_seen:      'Востаннє в мережі',
    wo_subject:     '📋 Наряд #{0}: {1}',
    wo_title:       'Вам призначено наряд #{0}',
    wo_task:        'Завдання',
    wo_priority:    'Пріоритет',
    wo_site:        'Точка',
    wo_address:     'Адреса',
    wo_scheduled:   'Заплановано на',
    wo_route:       'Маршрут до точки',
    hint_alarm:     'Аварія',
    hint_count:     'Скільки разів',
    hint_reading:   '{0} разів за {1} дн. (межа {2})',
    hint_advice:    'Що зробити',
  },
  en: {
    test_subject:   'ModESP Cloud — Test notification',
    test_title:     'Test notification',
    test_body:      'The e-mail channel is set up correctly. Notifications will arrive at this address.',
    device:         'Device',
    location:       'Location',
    temperature:    'Temperature',
    time:           'Time',
    open_device:    'Open device',
    escalation:     '⏫ Not acknowledged for {0} min: ',
    cleared_subject: '✅ {0} cleared — {1}',
    cleared_title:  '{0} — cleared',
    duration:       'Duration',
    offline_subject: '⚠️ {0} — device offline',
    offline_title:  'Device offline',
    last_seen:      'Last seen',
    wo_subject:     '📋 Work order #{0}: {1}',
    wo_title:       'Work order #{0} assigned to you',
    wo_task:        'Task',
    wo_priority:    'Priority',
    wo_site:        'Site',
    wo_address:     'Address',
    wo_scheduled:   'Scheduled for',
    wo_route:       'Route to the site',
    hint_alarm:     'Alarm',
    hint_count:     'How often',
    hint_reading:   '{0} times in {1} days (limit {2})',
    hint_advice:    'What to do',
  },
  pl: {
    test_subject:   'ModESP Cloud — Powiadomienie testowe',
    test_title:     'Powiadomienie testowe',
    test_body:      'Kanał e-mail jest skonfigurowany poprawnie. Powiadomienia będą przychodzić na ten adres.',
    device:         'Urządzenie',
    location:       'Lokalizacja',
    temperature:    'Temperatura',
    time:           'Czas',
    open_device:    'Otwórz urządzenie',
    escalation:     '⏫ Niepotwierdzony od {0} min: ',
    cleared_subject: '✅ {0} — ustąpił — {1}',
    cleared_title:  '{0} — ustąpił',
    duration:       'Czas trwania',
    offline_subject: '⚠️ {0} — urządzenie offline',
    offline_title:  'Urządzenie offline',
    last_seen:      'Ostatnio online',
    wo_subject:     '📋 Zlecenie #{0}: {1}',
    wo_title:       'Przydzielono Ci zlecenie #{0}',
    wo_task:        'Zadanie',
    wo_priority:    'Priorytet',
    wo_site:        'Punkt',
    wo_address:     'Adres',
    wo_scheduled:   'Zaplanowano na',
    wo_route:       'Trasa do punktu',
    hint_alarm:     'Alarm',
    hint_count:     'Ile razy',
    hint_reading:   '{0} razy w {1} dni (limit {2})',
    hint_advice:    'Co zrobić',
  },
  de: {
    test_subject:   'ModESP Cloud — Testbenachrichtigung',
    test_title:     'Testbenachrichtigung',
    test_body:      'Der E-Mail-Kanal ist richtig eingerichtet. Benachrichtigungen kommen an diese Adresse.',
    device:         'Gerät',
    location:       'Standort',
    temperature:    'Temperatur',
    time:           'Zeit',
    open_device:    'Gerät öffnen',
    escalation:     '⏫ Seit {0} Min. nicht quittiert: ',
    cleared_subject: '✅ {0} behoben — {1}',
    cleared_title:  '{0} — behoben',
    duration:       'Dauer',
    offline_subject: '⚠️ {0} — Gerät offline',
    offline_title:  'Gerät offline',
    last_seen:      'Zuletzt online',
    wo_subject:     '📋 Auftrag #{0}: {1}',
    wo_title:       'Ihnen wurde Auftrag #{0} zugewiesen',
    wo_task:        'Aufgabe',
    wo_priority:    'Priorität',
    wo_site:        'Standort',
    wo_address:     'Adresse',
    wo_scheduled:   'Geplant für',
    wo_route:       'Route zum Standort',
    hint_alarm:     'Alarm',
    hint_count:     'Wie oft',
    hint_reading:   '{0}-mal in {1} Tagen (Grenze {2})',
    hint_advice:    'Was zu tun ist',
  },
};

const HINT_NAMES = {
  uk: { alarm_repeat: 'Аварія повторюється' },
  en: { alarm_repeat: 'Recurring alarm' },
  pl: { alarm_repeat: 'Alarm się powtarza' },
  de: { alarm_repeat: 'Alarm wiederholt sich' },
};
const HINT_ADVICE = {
  uk: { alarm_repeat: 'Контролер піднімає цю аварію знову і знову. Ще одне підтвердження не допоможе — потрібен візит: створіть наряд.' },
  en: { alarm_repeat: 'The controller keeps raising this alarm. Another acknowledgement will not fix it — plan a visit: create a work order.' },
  pl: { alarm_repeat: 'Sterownik zgłasza ten alarm raz za razem. Kolejne potwierdzenie nic nie da — potrzebna wizyta: utwórz zlecenie.' },
  de: { alarm_repeat: 'Der Regler löst diesen Alarm immer wieder aus. Noch eine Quittierung hilft nicht — ein Einsatz ist nötig: Auftrag anlegen.' },
};

const PRIORITY_LABELS = {
  uk: { low: 'низький', normal: 'звичайний', high: 'високий', urgent: 'терміновий' },
  en: { low: 'low', normal: 'normal', high: 'high', urgent: 'urgent' },
  pl: { low: 'niski', normal: 'zwykły', high: 'wysoki', urgent: 'pilny' },
  de: { low: 'niedrig', normal: 'normal', high: 'hoch', urgent: 'dringend' },
};

function fmt(str, ...args) { return String(str).replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined ? '' : String(args[i]))); }

// ── Init / Shutdown ───────────────────────────────────────

/**
 * Initialize Resend email service.
 * Returns channel handler or null if not configured.
 * @param {import('pino').Logger} log
 * @returns {{ send: Function } | null}
 */
function init(log) {
  logger = log.child({ svc: 'email' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info('Email: RESEND_API_KEY not set — channel disabled');
    return null;
  }

  fromAddress = process.env.EMAIL_FROM || 'alerts@modesp.com.ua';
  appUrl = process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua';

  try {
    resend = new Resend(apiKey);
    logger.info({ from: fromAddress }, 'Email (Resend) initialized');
    return { send };
  } catch (err) {
    logger.error({ err }, 'Email initialization failed');
    return null;
  }
}

function shutdown() {
  resend = null;
  if (logger) logger.info('Email shutdown');
}

// ── Send ──────────────────────────────────────────────────

/**
 * Send email notification.
 * @param {string} emailAddress — recipient email
 * @param {object} payload — notification payload (same structure as telegram/fcm)
 */
async function send(emailAddress, payload) {
  if (!resend) throw new Error('Email service not initialized');

  const { subject, html } = buildEmail(payload);

  const { error } = await resend.emails.send({
    from: fromAddress,
    to: emailAddress,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  }
}

// ── Email builder ─────────────────────────────────────────

function alarmNameFor(lang, code) {
  const names = ALARM_NAMES[lang] || ALARM_NAMES.uk;
  return names[code] || names[`protection.${code}`] || code;
}

// Every notification renders in the recipient's language and time zone
// (payload.lang / payload.timezone, resolved by push.withUserLocale — plan epic 2.11).
function buildEmail(payload) {
  const lang = pickLocale(payload.lang);
  if (payload.isTest) return buildTestEmail(payload, lang);
  if (payload.type === 'work_order') return buildWorkOrderEmail(payload, lang);
  if (payload.type === 'hint') return buildHintEmail(payload, lang);
  if (payload.type === 'device_offline') return buildOfflineEmail(payload, lang);
  if (payload.active === false) return buildAlarmClearedEmail(payload, lang);
  return buildAlarmRaisedEmail(payload, lang);
}

function openDeviceButton(payload, T) {
  const deviceUrl = payload.deviceUuid ? `${appUrl}/app/#/device/${payload.deviceUuid}` : null;
  return deviceUrl ? `
      <div style="margin-top:20px;">
        <a href="${deviceUrl}" style="display:inline-block;padding:10px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">${T.open_device}</a>
      </div>` : '';
}

function buildTestEmail(payload, lang) {
  const T = L[lang];
  const html = wrapHtml(`
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#10b981;font-size:20px;">&#x2705; ${T.test_title}</h2>
      <p style="margin:0;color:#d1d5db;font-size:15px;">${T.test_body}</p>
    </td></tr>
  `, lang);
  return { subject: T.test_subject, html };
}

function buildAlarmRaisedEmail(payload, lang) {
  const T = L[lang];
  const alarmName = alarmNameFor(lang, payload.alarmCode);
  const severity = payload.severity || 'warning';
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;
  const sevLabel = (SEVERITY_LABELS[lang] || SEVERITY_LABELS.uk)[severity] || severity;
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const tempStr = payload.airTemp != null && isFinite(payload.airTemp)
    ? `${Number(payload.airTemp).toFixed(1)}°C` : '—';
  const time = formatTime(payload.timestamp, payload);

  const escalation = payload.escalation ? fmt(T.escalation, payload.escalation.minutes) : '';
  const subject = `${escalation}🚨 ${alarmName} — ${deviceName}${location ? ' (' + location + ')' : ''}`;

  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:${color};height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
          <td>
            <span style="display:inline-block;padding:4px 12px;background:${color};color:#fff;border-radius:4px;font-size:12px;font-weight:600;text-transform:uppercase;">${sevLabel}</span>
            <h2 style="margin:12px 0 4px;color:#f1f5f9;font-size:20px;">&#x1F6A8; ${escHtml(alarmName)}</h2>
          </td>
        </tr>
      </table>
      ${infoRow(T.device, escHtml(deviceName))}
      ${location ? infoRow(T.location, escHtml(location)) : ''}
      ${infoRow(T.temperature, tempStr)}
      ${infoRow(T.time, time)}
      ${openDeviceButton(payload, T)}
    </td></tr>
  `, lang);

  return { subject, html };
}

function buildAlarmClearedEmail(payload, lang) {
  const T = L[lang];
  const alarmName = alarmNameFor(lang, payload.alarmCode);
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const time = formatTime(payload.timestamp, payload);
  const durationStr = payload.duration ? fmtDuration(payload.duration, lang) : '—';

  const subject = fmt(T.cleared_subject, alarmName, deviceName);
  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:#10b981;height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#10b981;font-size:20px;">&#x2705; ${escHtml(fmt(T.cleared_title, alarmName))}</h2>
      ${infoRow(T.device, escHtml(deviceName))}
      ${location ? infoRow(T.location, escHtml(location)) : ''}
      ${infoRow(T.duration, durationStr)}
      ${infoRow(T.time, time)}
    </td></tr>
  `, lang);

  return { subject, html };
}

function buildOfflineEmail(payload, lang) {
  const T = L[lang];
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const lastSeen = payload.lastSeen ? formatTime(payload.lastSeen, payload) : '—';

  const subject = fmt(T.offline_subject, deviceName);
  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:#f59e0b;height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#f59e0b;font-size:20px;">&#x26A0;&#xFE0F; ${T.offline_title}</h2>
      ${infoRow(T.device, escHtml(deviceName))}
      ${location ? infoRow(T.location, escHtml(location)) : ''}
      ${infoRow(T.last_seen, lastSeen)}
      ${openDeviceButton(payload, T)}
    </td></tr>
  `, lang);

  return { subject, html };
}

// Work order assigned (plan epic 2.3) — the assignee only, see push.notifyWorkOrder()
function buildWorkOrderEmail(payload, lang) {
  const T = L[lang];
  const prio = (PRIORITY_LABELS[lang] || PRIORITY_LABELS.uk)[payload.priority] || payload.priority || '';
  const color = payload.priority === 'urgent' ? '#dc2626' : '#3b82f6';
  const subject = fmt(T.wo_subject, payload.orderId, `${payload.title}${payload.siteName ? ' — ' + payload.siteName : ''}`);
  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:${color};height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:${color};font-size:20px;">&#x1F4CB; ${escHtml(fmt(T.wo_title, String(payload.orderId)))}</h2>
      ${infoRow(T.wo_task, escHtml(payload.title || ''))}
      ${infoRow(T.wo_priority, escHtml(prio))}
      ${payload.deviceName || payload.deviceId ? infoRow(T.device, escHtml(payload.deviceName || payload.deviceId)) : ''}
      ${payload.siteName ? infoRow(T.wo_site, escHtml(payload.siteName)) : ''}
      ${payload.siteAddress ? infoRow(T.wo_address, escHtml(payload.siteAddress)) : ''}
      ${payload.scheduledAt ? infoRow(T.wo_scheduled, formatTime(payload.scheduledAt, payload)) : ''}
      ${payload.mapsUrl ? `
      <div style="margin-top:20px;">
        <a href="${escHtml(payload.mapsUrl)}" style="display:inline-block;padding:10px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">${T.wo_route}</a>
      </div>` : ''}
    </td></tr>
  `, lang);
  return { subject, html };
}

// Maintenance hint (plan epic 2.4) — admins only, see push.notifyHint()
function buildHintEmail(payload, lang) {
  const T = L[lang];
  const names  = HINT_NAMES[lang] || HINT_NAMES.uk;
  const advice = HINT_ADVICE[lang] || HINT_ADVICE.uk;
  const title  = names[payload.ruleKey] || payload.ruleKey;
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const alarmName = payload.sourceAlarmCode ? alarmNameFor(lang, payload.sourceAlarmCode) : null;
  const days = payload.windowHours ? Math.max(1, Math.round(payload.windowHours / 24)) : '—';
  const reading = payload.value != null ? fmt(T.hint_reading, payload.value, days, payload.threshold ?? '—') : null;

  const subject = `🔧 ${title}: ${alarmName || ''} — ${deviceName}${location ? ' (' + location + ')' : ''}`;
  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:#3b82f6;height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#3b82f6;font-size:20px;">&#x1F527; ${escHtml(title)}</h2>
      ${infoRow(T.device, escHtml(deviceName))}
      ${location ? infoRow(T.location, escHtml(location)) : ''}
      ${alarmName ? infoRow(T.hint_alarm, escHtml(alarmName)) : ''}
      ${reading ? infoRow(T.hint_count, escHtml(reading)) : ''}
      ${infoRow(T.hint_advice, escHtml(advice[payload.ruleKey] || ''))}
      ${infoRow(T.time, formatTime(payload.timestamp, payload))}
      ${openDeviceButton(payload, T)}
    </td></tr>
  `, lang);
  return { subject, html };
}

// ── HTML helpers ──────────────────────────────────────────

function wrapHtml(bodyRows, lang = 'uk') {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0f172a;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="background:#1e293b;border-radius:8px;border:1px solid #334155;max-width:100%;">
        ${bodyRows}
        <tr><td style="padding:16px 32px;border-top:1px solid #334155;">
          <p style="margin:0;color:#64748b;font-size:12px;">
            ModESP Cloud &mdash; <a href="${appUrl}" style="color:#3b82f6;text-decoration:none;">modesp.com.ua</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function infoRow(label, value) {
  return `<div style="margin:8px 0;padding:8px 0;border-bottom:1px solid #334155;">
    <span style="color:#94a3b8;font-size:13px;">${label}:</span>
    <span style="color:#f1f5f9;font-size:15px;font-weight:500;margin-left:8px;">${value}</span>
  </div>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** In the recipient's language and time zone (payload.lang / payload.timezone). */
function formatTime(isoStr, payload = {}) {
  return formatDateTime(isoStr, { locale: payload.lang, timezone: payload.timezone });
}

// ── Transactional mail (invitations, password reset) ─────

const TX = {
  uk: {
    invite_subject:  (org) => `Запрошення до «${org}» у ModESP Cloud`,
    invite_title:    'Вас запрошено до ModESP Cloud',
    invite_intro:    (org, by) => `${by ? escHtml(by) + ' запрошує вас' : 'Вас запрошено'} приєднатися до організації «${escHtml(org)}» на платформі моніторингу холодильного обладнання ModESP Cloud.`,
    invite_cta:      'Прийняти запрошення',
    invite_expires:  (h) => `Посилання дійсне ${h} год. Якщо ви не очікували цього листа — просто проігноруйте його.`,
    org:             'Організація',
    role:            'Роль',
    roles:           { admin: 'Адміністратор', technician: 'Технік', viewer: 'Перегляд' },
    reset_subject:   'Скидання пароля ModESP Cloud',
    reset_title:     'Скидання пароля',
    reset_intro:     'Хтось (сподіваємось, ви) попросив скинути пароль вашого акаунта ModESP Cloud. Натисніть кнопку, щоб задати новий пароль.',
    reset_cta:       'Задати новий пароль',
    reset_code:      'Код (якщо кнопка не працює)',
    reset_expires:   (m) => `Посилання дійсне ${m} хв. Якщо ви не просили скидання — нічого не робіть, пароль лишиться незмінним.`,
    link_fallback:   'Або скопіюйте посилання у браузер:',
  },
  en: {
    invite_subject:  (org) => `Invitation to “${org}” on ModESP Cloud`,
    invite_title:    'You have been invited to ModESP Cloud',
    invite_intro:    (org, by) => `${by ? escHtml(by) + ' invites you' : 'You have been invited'} to join the organisation “${escHtml(org)}” on ModESP Cloud, the refrigeration monitoring platform.`,
    invite_cta:      'Accept invitation',
    invite_expires:  (h) => `The link is valid for ${h} hours. If you did not expect this email, simply ignore it.`,
    org:             'Organisation',
    role:            'Role',
    roles:           { admin: 'Administrator', technician: 'Technician', viewer: 'Viewer' },
    reset_subject:   'ModESP Cloud password reset',
    reset_title:     'Password reset',
    reset_intro:     'Someone (hopefully you) asked to reset the password of your ModESP Cloud account. Press the button to choose a new password.',
    reset_cta:       'Choose a new password',
    reset_code:      'Code (if the button does not work)',
    reset_expires:   (m) => `The link is valid for ${m} minutes. If you did not request a reset, do nothing — your password stays as it is.`,
    link_fallback:   'Or copy the link into your browser:',
  },
  pl: {
    invite_subject:  (org) => `Zaproszenie do „${org}” w ModESP Cloud`,
    invite_title:    'Zaproszono Cię do ModESP Cloud',
    invite_intro:    (org, by) => `${by ? escHtml(by) + ' zaprasza Cię' : 'Zaproszono Cię'} do organizacji „${escHtml(org)}” na platformie monitoringu chłodnictwa ModESP Cloud.`,
    invite_cta:      'Przyjmij zaproszenie',
    invite_expires:  (h) => `Link jest ważny ${h} godz. Jeśli nie spodziewałeś się tej wiadomości, po prostu ją zignoruj.`,
    org:             'Organizacja',
    role:            'Rola',
    roles:           { admin: 'Administrator', technician: 'Technik', viewer: 'Podgląd' },
    reset_subject:   'Reset hasła ModESP Cloud',
    reset_title:     'Reset hasła',
    reset_intro:     'Ktoś (mamy nadzieję, że Ty) poprosił o reset hasła do konta ModESP Cloud. Naciśnij przycisk, aby ustawić nowe hasło.',
    reset_cta:       'Ustaw nowe hasło',
    reset_code:      'Kod (jeśli przycisk nie działa)',
    reset_expires:   (m) => `Link jest ważny ${m} min. Jeśli nie prosiłeś o reset, nic nie rób — hasło pozostanie bez zmian.`,
    link_fallback:   'Lub skopiuj link do przeglądarki:',
  },
  de: {
    invite_subject:  (org) => `Einladung zu „${org}“ bei ModESP Cloud`,
    invite_title:    'Sie wurden zu ModESP Cloud eingeladen',
    invite_intro:    (org, by) => `${by ? escHtml(by) + ' lädt Sie ein' : 'Sie wurden eingeladen'}, der Organisation „${escHtml(org)}“ auf der Kälteüberwachungsplattform ModESP Cloud beizutreten.`,
    invite_cta:      'Einladung annehmen',
    invite_expires:  (h) => `Der Link ist ${h} Stunden gültig. Wenn Sie diese E-Mail nicht erwartet haben, ignorieren Sie sie einfach.`,
    org:             'Organisation',
    role:            'Rolle',
    roles:           { admin: 'Administrator', technician: 'Techniker', viewer: 'Betrachter' },
    reset_subject:   'ModESP Cloud Passwort zurücksetzen',
    reset_title:     'Passwort zurücksetzen',
    reset_intro:     'Jemand (hoffentlich Sie) hat darum gebeten, das Passwort Ihres ModESP-Cloud-Kontos zurückzusetzen. Klicken Sie auf die Schaltfläche, um ein neues Passwort zu wählen.',
    reset_cta:       'Neues Passwort wählen',
    reset_code:      'Code (falls die Schaltfläche nicht funktioniert)',
    reset_expires:   (m) => `Der Link ist ${m} Minuten gültig. Wenn Sie kein Zurücksetzen angefordert haben, tun Sie nichts — Ihr Passwort bleibt unverändert.`,
    link_fallback:   'Oder kopieren Sie den Link in Ihren Browser:',
  },
};

function txLang(lang) { return pickLocale(lang); }

function ctaButton(href, label) {
  return `<p style="margin:24px 0;">
    <a href="${href}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">${label}</a>
  </p>`;
}

function txBody(title, intro, rows, button, note, link) {
  return `<tr><td style="padding:32px;">
    <h2 style="margin:0 0 16px;color:#f1f5f9;font-size:20px;">${title}</h2>
    <p style="margin:0 0 16px;color:#cbd5e1;font-size:15px;line-height:1.5;">${intro}</p>
    ${rows}
    ${button}
    <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;line-height:1.5;">${note}</p>
    <p style="margin:0;color:#64748b;font-size:12px;word-break:break-all;">${link}</p>
  </td></tr>`;
}

/** True when RESEND_API_KEY is set and the client initialised. */
function isConfigured() { return !!resend; }

/**
 * Invitation email. Resolves false when the channel is not configured — the
 * caller then shows the link to the admin instead of failing the invite.
 */
async function sendInvitation({ to, link, tenantName, role, invitedBy, lang, expiresHours = 72 }) {
  if (!resend) return false;
  const L = TX[txLang(lang)];
  const rows = infoRow(L.org, escHtml(tenantName)) + infoRow(L.role, L.roles[role] || escHtml(role));
  const html = wrapHtml(txBody(
    L.invite_title, L.invite_intro(tenantName, invitedBy), rows,
    ctaButton(link, L.invite_cta), L.invite_expires(expiresHours),
    `${L.link_fallback}<br>${escHtml(link)}`
  ), txLang(lang));
  const { error } = await resend.emails.send({ from: fromAddress, to, subject: L.invite_subject(tenantName), html });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  return true;
}

/** Self-service password reset email. Resolves false when not configured. */
async function sendPasswordReset({ to, link, code, lang, expiresMinutes = 30 }) {
  if (!resend) return false;
  const L = TX[txLang(lang)];
  const rows = infoRow(L.reset_code, `<code style="font-family:monospace;letter-spacing:1px;">${escHtml(code)}</code>`);
  const html = wrapHtml(txBody(
    L.reset_title, L.reset_intro, rows,
    ctaButton(link, L.reset_cta), L.reset_expires(expiresMinutes),
    `${L.link_fallback}<br>${escHtml(link)}`
  ), txLang(lang));
  const { error } = await resend.emails.send({ from: fromAddress, to, subject: L.reset_subject, html });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  return true;
}

/**
 * A pilot request from the landing page, to the founder (PILOT_REQUEST_EMAIL).
 * Resolves false when e-mail or the recipient is not configured — the request
 * is already stored in pilot_requests by then.
 */
async function sendPilotRequest({ to, request }) {
  if (!resend || !to) return false;
  const r = request || {};
  const rows =
    infoRow('Ім\'я', escHtml(r.name || '')) +
    infoRow('Компанія', escHtml(r.company || '—')) +
    infoRow('E-mail', escHtml(r.email || '')) +
    infoRow('Телефон', escHtml(r.phone || '—')) +
    infoRow('Сегмент', escHtml(r.segment || '—')) +
    infoRow('Точок', escHtml(r.sites == null ? '—' : String(r.sites))) +
    infoRow('Джерело', escHtml(r.source || 'landing')) +
    infoRow('Мова', escHtml(r.lang || 'uk'));
  const message = r.message ? `<p style="white-space:pre-wrap;">${escHtml(r.message)}</p>` : '';
  const html = wrapHtml(`<h2 style="margin:0 0 12px;">Запит на пілот</h2><table>${rows}</table>${message}<p style="color:#888;font-size:12px;">id ${escHtml(String(r.id || ''))}</p>`);
  const { error } = await resend.emails.send({
    from: fromAddress, to, replyTo: r.email || undefined,
    subject: `Запит на пілот: ${r.company || r.name || 'з лендінгу'}`, html,
  });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  return true;
}

module.exports = {
  init, shutdown, isConfigured, sendInvitation, sendPasswordReset, sendPilotRequest,
  // scripts/check-locales.js and test/notification-templates.test.js
  __strings: { ALARM_NAMES, SEVERITY_LABELS, L, HINT_NAMES, HINT_ADVICE, PRIORITY_LABELS, TX },
  __test: { buildEmail },
};
