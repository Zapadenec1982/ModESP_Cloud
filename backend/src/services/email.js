'use strict';

const { Resend } = require('resend');

let resend = null;
let logger = null;
let fromAddress = null;
let appUrl = null;

// ── Alarm names (UA + EN) ─────────────────────────────────

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
    'protection.rate_alarm':            'Rate of Change',
    'test_notification':                'Test Notification',
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
};

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

function buildEmail(payload) {
  const lang = 'uk'; // default Ukrainian; can be extended per-user later

  if (payload.isTest) {
    return buildTestEmail(lang);
  }
  if (payload.type === 'device_offline') {
    return buildOfflineEmail(payload, lang);
  }
  if (payload.active === false) {
    return buildAlarmClearedEmail(payload, lang);
  }
  return buildAlarmRaisedEmail(payload, lang);
}

function buildTestEmail(lang) {
  const subject = 'ModESP Cloud — Тестове сповіщення';
  const html = wrapHtml(`
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#10b981;font-size:20px;">&#x2705; Тестове сповіщення</h2>
      <p style="margin:0;color:#d1d5db;font-size:15px;">
        Email-канал налаштовано правильно. Сповіщення будуть надходити на цю адресу.
      </p>
    </td></tr>
  `);
  return { subject, html };
}

function buildAlarmRaisedEmail(payload, lang) {
  const alarmName = (ALARM_NAMES[lang] || ALARM_NAMES.uk)[payload.alarmCode] || payload.alarmCode;
  const severity = payload.severity || 'warning';
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;
  const sevLabel = (SEVERITY_LABELS[lang] || SEVERITY_LABELS.uk)[severity] || severity;
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const tempStr = payload.airTemp != null && isFinite(payload.airTemp)
    ? `${Number(payload.airTemp).toFixed(1)}°C` : '—';
  const time = formatTime(payload.timestamp);
  const deviceUrl = payload.deviceUuid ? `${appUrl}/app/#/device/${payload.deviceUuid}` : null;

  const subject = `🚨 ${alarmName} — ${deviceName}${location ? ' (' + location + ')' : ''}`;

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
      ${infoRow('Пристрій', escHtml(deviceName))}
      ${location ? infoRow('Розташування', escHtml(location)) : ''}
      ${infoRow('Температура', tempStr)}
      ${infoRow('Час', time)}
      ${deviceUrl ? `
      <div style="margin-top:20px;">
        <a href="${deviceUrl}" style="display:inline-block;padding:10px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Відкрити пристрій</a>
      </div>` : ''}
    </td></tr>
  `);

  return { subject, html };
}

function buildAlarmClearedEmail(payload, lang) {
  const alarmName = (ALARM_NAMES[lang] || ALARM_NAMES.uk)[payload.alarmCode] || payload.alarmCode;
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const time = formatTime(payload.timestamp);
  const durationStr = payload.duration ? formatDuration(payload.duration) : '—';

  const subject = `✅ ${alarmName} знято — ${deviceName}`;

  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:#10b981;height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#10b981;font-size:20px;">&#x2705; ${escHtml(alarmName)} — знято</h2>
      ${infoRow('Пристрій', escHtml(deviceName))}
      ${location ? infoRow('Розташування', escHtml(location)) : ''}
      ${infoRow('Тривалість', durationStr)}
      ${infoRow('Час', time)}
    </td></tr>
  `);

  return { subject, html };
}

function buildOfflineEmail(payload, lang) {
  const deviceName = payload.deviceName || payload.deviceId || '—';
  const location = payload.location || '';
  const lastSeen = payload.lastSeen ? formatTime(payload.lastSeen) : '—';
  const deviceUrl = payload.deviceUuid ? `${appUrl}/app/#/device/${payload.deviceUuid}` : null;

  const subject = `⚠️ ${deviceName} — пристрій офлайн`;

  const html = wrapHtml(`
    <tr><td style="padding:0;"><div style="background:#f59e0b;height:4px;border-radius:8px 8px 0 0;"></div></td></tr>
    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 12px;color:#f59e0b;font-size:20px;">&#x26A0;&#xFE0F; Пристрій офлайн</h2>
      ${infoRow('Пристрій', escHtml(deviceName))}
      ${location ? infoRow('Розташування', escHtml(location)) : ''}
      ${infoRow('Востаннє в мережі', lastSeen)}
      ${deviceUrl ? `
      <div style="margin-top:20px;">
        <a href="${deviceUrl}" style="display:inline-block;padding:10px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Відкрити пристрій</a>
      </div>` : ''}
    </td></tr>
  `);

  return { subject, html };
}

// ── HTML helpers ──────────────────────────────────────────

function wrapHtml(bodyRows) {
  return `<!DOCTYPE html>
<html lang="uk">
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

function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', hour12: false });
  } catch {
    return isoStr || '—';
  }
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} хв`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs} год ${rem} хв` : `${hrs} год`;
}

module.exports = { init, shutdown };
