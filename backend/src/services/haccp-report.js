'use strict';

/**
 * HACCP temperature report (plan epic 1.9).
 *
 * Builds the pdfmake document for one device or for every device of a site:
 * localised (uk/en/pl/de), headed with the organisation's legal name, the
 * site's address and local time zone, with a responsible-person signature
 * block, a sensor-verification note, and a footer carrying the SHA-256 of the
 * report data plus a verification code that GET /api/public/report/:code
 * confirms. Data comes from raw telemetry for recent periods and from
 * telemetry_hourly (the three-year archive) once the raw retention of the
 * organisation's plan has passed.
 */

const crypto    = require('crypto');
const pdfmake   = require('pdfmake/build/pdfmake');
const vfs_fonts = require('pdfmake/build/vfs_fonts');
const { generateClaimCode } = require('../lib/claim-code');

pdfmake.addVirtualFileSystem(vfs_fonts);

const BUCKETS = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
const RAW_MAX_DAYS    = 31;    // raw rows: keep the existing 31-day window
const HOURLY_MAX_DAYS = 366;   // hourly archive: a year per report
const MAX_ROWS        = 10000;
const HOURLY_RETENTION_DAYS = 1095;

const STRINGS = {
  uk: {
    title: 'Журнал контролю температури (HACCP)', site_title: 'Журнал контролю температури точки (HACCP)',
    organisation: 'Організація', tax_id: 'Код ЄДРПОУ/ІПН', site: 'Точка', address: 'Адреса', timezone: 'Часовий пояс',
    device: 'Обладнання', device_id: 'Ідентифікатор', serial: 'Серійний номер', model: 'Модель',
    period: 'Період', bucket: 'Інтервал', generated: 'Сформовано', by: 'ким',
    source: 'Джерело даних', source_raw: 'первинні вимірювання', source_hourly: 'погодинний архів (мін/макс/середнє за годину)',
    summary: 'Підсумок', channel: 'Канал', min: 'Мін °C', max: 'Макс °C', avg: 'Сер. °C', samples: 'Вимірювань',
    alarms: 'Аварії за період', no_alarms: 'Аварій за період не зафіксовано.',
    time: 'Час', code: 'Код', severity: 'Важливість', value: 'Значення', cleared: 'Знято', active: 'Активна', ack: 'Підтверджено',
    log: 'Температурний журнал', responsible: 'Відповідальна особа', position: 'Посада', signature: 'Підпис', date: 'Дата',
    sensors_note: 'Примітка про датчики: температура вимірюється датчиками контролера ModESP; періодичність повірки/калібрування визначає організація згідно з власною програмою HACCP. Остання сервісна відмітка щодо обладнання:',
    no_service: 'записів обслуговування за період зберігання немає',
    verify: 'Перевірка автентичності', verify_text: 'Код перевірки та SHA-256 даних звіту зберігаються платформою. Перевірити:',
    page: 'Сторінка', of: 'з', no_data: 'Дані за період відсутні',
    ch: { air: 'Повітря', evap: 'Випарник', cond: 'Конденсатор', setpoint: 'Уставка', comp: 'Компресор', defrost: 'Розморожування', energy: 'Енергія' },
  },
  en: {
    title: 'HACCP Temperature Compliance Log', site_title: 'HACCP Temperature Compliance Log — site',
    organisation: 'Organisation', tax_id: 'Tax ID', site: 'Site', address: 'Address', timezone: 'Time zone',
    device: 'Equipment', device_id: 'Identifier', serial: 'Serial number', model: 'Model',
    period: 'Period', bucket: 'Interval', generated: 'Generated', by: 'by',
    source: 'Data source', source_raw: 'raw measurements', source_hourly: 'hourly archive (min/max/avg per hour)',
    summary: 'Summary', channel: 'Channel', min: 'Min °C', max: 'Max °C', avg: 'Avg °C', samples: 'Samples',
    alarms: 'Alarms during the period', no_alarms: 'No alarms during this period.',
    time: 'Time', code: 'Code', severity: 'Severity', value: 'Value', cleared: 'Cleared', active: 'Active', ack: 'Acknowledged',
    log: 'Temperature log', responsible: 'Responsible person', position: 'Position', signature: 'Signature', date: 'Date',
    sensors_note: 'Sensor note: temperatures are measured by the ModESP controller sensors; the verification/calibration interval is set by the organisation in its HACCP programme. Last service record for this equipment:',
    no_service: 'no service records within the retention period',
    verify: 'Authenticity check', verify_text: 'The verification code and the SHA-256 of the report data are stored by the platform. Verify at:',
    page: 'Page', of: 'of', no_data: 'No data for the period',
    ch: { air: 'Air', evap: 'Evaporator', cond: 'Condenser', setpoint: 'Setpoint', comp: 'Compressor', defrost: 'Defrost', energy: 'Energy' },
  },
  pl: {
    title: 'Dziennik kontroli temperatury (HACCP)', site_title: 'Dziennik kontroli temperatury lokalizacji (HACCP)',
    organisation: 'Organizacja', tax_id: 'NIP', site: 'Lokalizacja', address: 'Adres', timezone: 'Strefa czasowa',
    device: 'Urządzenie', device_id: 'Identyfikator', serial: 'Numer seryjny', model: 'Model',
    period: 'Okres', bucket: 'Interwał', generated: 'Wygenerowano', by: 'przez',
    source: 'Źródło danych', source_raw: 'pomiary surowe', source_hourly: 'archiwum godzinowe (min/maks/śr. na godzinę)',
    summary: 'Podsumowanie', channel: 'Kanał', min: 'Min °C', max: 'Maks °C', avg: 'Śr. °C', samples: 'Pomiary',
    alarms: 'Alarmy w okresie', no_alarms: 'Brak alarmów w tym okresie.',
    time: 'Czas', code: 'Kod', severity: 'Ważność', value: 'Wartość', cleared: 'Zakończony', active: 'Aktywny', ack: 'Potwierdzony',
    log: 'Dziennik temperatur', responsible: 'Osoba odpowiedzialna', position: 'Stanowisko', signature: 'Podpis', date: 'Data',
    sensors_note: 'Uwaga o czujnikach: temperatury mierzą czujniki sterownika ModESP; częstotliwość sprawdzania/kalibracji ustala organizacja w swoim programie HACCP. Ostatni wpis serwisowy dla urządzenia:',
    no_service: 'brak wpisów serwisowych w okresie przechowywania',
    verify: 'Weryfikacja autentyczności', verify_text: 'Kod weryfikacyjny i SHA-256 danych raportu są przechowywane przez platformę. Sprawdź:',
    page: 'Strona', of: 'z', no_data: 'Brak danych za okres',
    ch: { air: 'Powietrze', evap: 'Parownik', cond: 'Skraplacz', setpoint: 'Nastawa', comp: 'Sprężarka', defrost: 'Odszranianie', energy: 'Energia' },
  },
  de: {
    title: 'Temperaturprotokoll (HACCP)', site_title: 'Temperaturprotokoll des Standorts (HACCP)',
    organisation: 'Organisation', tax_id: 'Steuernummer', site: 'Standort', address: 'Adresse', timezone: 'Zeitzone',
    device: 'Anlage', device_id: 'Kennung', serial: 'Seriennummer', model: 'Modell',
    period: 'Zeitraum', bucket: 'Intervall', generated: 'Erstellt', by: 'von',
    source: 'Datenquelle', source_raw: 'Rohmessungen', source_hourly: 'Stundenarchiv (Min/Max/Mittel je Stunde)',
    summary: 'Zusammenfassung', channel: 'Kanal', min: 'Min °C', max: 'Max °C', avg: 'Mittel °C', samples: 'Messungen',
    alarms: 'Alarme im Zeitraum', no_alarms: 'Keine Alarme in diesem Zeitraum.',
    time: 'Zeit', code: 'Code', severity: 'Schwere', value: 'Wert', cleared: 'Beendet', active: 'Aktiv', ack: 'Bestätigt',
    log: 'Temperaturprotokoll', responsible: 'Verantwortliche Person', position: 'Position', signature: 'Unterschrift', date: 'Datum',
    sensors_note: 'Hinweis zu Sensoren: Die Temperaturen werden von den Sensoren des ModESP-Controllers gemessen; das Prüf-/Kalibrierintervall legt die Organisation in ihrem HACCP-Programm fest. Letzter Serviceeintrag für diese Anlage:',
    no_service: 'keine Serviceeinträge im Aufbewahrungszeitraum',
    verify: 'Echtheitsprüfung', verify_text: 'Prüfcode und SHA-256 der Berichtsdaten werden von der Plattform gespeichert. Prüfen unter:',
    page: 'Seite', of: 'von', no_data: 'Keine Daten für den Zeitraum',
    ch: { air: 'Luft', evap: 'Verdampfer', cond: 'Verflüssiger', setpoint: 'Sollwert', comp: 'Verdichter', defrost: 'Abtauung', energy: 'Energie' },
  },
};

function strings(lang) { return STRINGS[lang] || STRINGS.uk; }
function pickLang(raw) { return STRINGS[raw] ? raw : 'uk'; }

function localFmt(date, tz, withTime = true) {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d)) return '—';
  try {
    const opts = { timeZone: tz || 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit', hour12: false });
    return new Intl.DateTimeFormat('sv-SE', opts).format(d);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, withTime ? 16 : 10);
  }
}

/** Choose the data source and a sane bucket for the requested window. */
function planSource({ from, to, rawRetentionDays, bucketKey, now = new Date() }) {
  const rawBoundary = new Date(now.getTime() - rawRetentionDays * 86400 * 1000);
  const source = from < rawBoundary ? 'hourly' : 'raw';
  let bucketSec = BUCKETS[bucketKey] || BUCKETS['1h'];
  const spanDays = (to - from) / 86400000;
  if (source === 'hourly' && bucketSec < 3600) bucketSec = 3600;
  if (spanDays > 31 && bucketSec < 21600) bucketSec = 21600;
  if (spanDays > 120 && bucketSec < 86400) bucketSec = 86400;
  const bucketOut = Object.keys(BUCKETS).find(k => BUCKETS[k] === bucketSec) || '1h';
  return { source, bucketSec, bucketKey: bucketOut };
}

async function fetchSeries({ query, tenantId, deviceId, channels, from, to, bucketSec, source }) {
  const bucketExpr = (col) => `to_timestamp(floor(extract(epoch FROM ${col}) / ${bucketSec}) * ${bucketSec})`;
  const sql = source === 'hourly'
    ? `SELECT ${bucketExpr('hour')} AS bucket, channel,
              MIN(min) AS min, MAX(max) AS max,
              SUM(avg * samples) / NULLIF(SUM(samples), 0) AS avg, SUM(samples)::int AS samples
         FROM telemetry_hourly
        WHERE tenant_id = $1 AND device_id = $2 AND hour >= $3 AND hour < $4 AND channel = ANY($5)
        GROUP BY bucket, channel ORDER BY bucket ASC, channel`
    : `SELECT ${bucketExpr('time')} AS bucket, channel,
              MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg, COUNT(*)::int AS samples
         FROM telemetry
        WHERE tenant_id = $1 AND device_id = $2 AND time >= $3 AND time < $4 AND channel = ANY($5)
        GROUP BY bucket, channel ORDER BY bucket ASC, channel`;
  const { rows } = await query(sql, [tenantId, deviceId, from, to, channels]);
  return rows;
}

function summarize(rows) {
  const acc = {};
  const bucketMap = new Map();
  for (const row of rows) {
    const t = new Date(row.bucket).toISOString();
    if (!bucketMap.has(t)) bucketMap.set(t, { time: t });
    const min = parseFloat(row.min), max = parseFloat(row.max), avg = parseFloat(row.avg), samples = row.samples;
    bucketMap.get(t)[row.channel] = { min, max, avg: Math.round(avg * 100) / 100, samples };
    if (!acc[row.channel]) acc[row.channel] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
    const a = acc[row.channel];
    a.min = Math.min(a.min, min); a.max = Math.max(a.max, max);
    a.sum += avg * samples; a.count += samples;
  }
  const summary = {};
  for (const [ch, a] of Object.entries(acc)) {
    summary[ch] = { min: a.min.toFixed(2), max: a.max.toFixed(2), avg: (a.sum / a.count).toFixed(2), samples: a.count };
  }
  return { buckets: [...bucketMap.values()], summary };
}

async function fetchAlarms({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT a.alarm_code, a.severity, a.value, a.limit_value, a.triggered_at, a.cleared_at, a.acknowledged_at, u.email AS ack_by
       FROM alarms a LEFT JOIN users u ON u.id = a.acknowledged_by
      WHERE a.tenant_id = $1 AND a.device_id = $2 AND a.triggered_at >= $3 AND a.triggered_at < $4
      ORDER BY a.triggered_at ASC LIMIT 200`,
    [tenantId, deviceId, from, to]
  );
  return rows;
}

async function fetchLastService({ query, deviceUuid }) {
  if (!deviceUuid) return null;
  const { rows } = await query(
    `SELECT service_date, technician, work_done FROM service_records WHERE device_id = $1 ORDER BY service_date DESC LIMIT 1`,
    [deviceUuid]
  );
  return rows[0] || null;
}

/** Collect everything the document needs for one device. */
async function collectDevice({ query, device, tenantId, channels, from, to, bucketSec, source }) {
  const rows = await fetchSeries({ query, tenantId, deviceId: device.mqtt_device_id, channels, from, to, bucketSec, source });
  if (rows.length > MAX_ROWS) {
    const err = new Error('Too many data points for PDF. Use a larger bucket or shorter time range.');
    err.code = 'too_much_data';
    throw err;
  }
  const { buckets, summary } = summarize(rows);
  const alarms = await fetchAlarms({ query, tenantId, deviceId: device.mqtt_device_id, from, to });
  const lastService = await fetchLastService({ query, deviceUuid: device.id });
  return { device, rows, buckets, summary, alarms, lastService };
}

/** Deterministic JSON of the data the PDF shows — what the SHA-256 covers. */
function canonicalData({ kind, tenant, site, devices, from, to, bucketKey, source, generatedAt }) {
  return JSON.stringify({
    kind, tenant: tenant.slug, site: site ? site.id : null,
    period: [from.toISOString(), to.toISOString()], bucket: bucketKey, source, generatedAt,
    devices: devices.map(d => ({
      id: d.device.mqtt_device_id,
      rows: d.rows.map(r => [new Date(r.bucket).toISOString(), r.channel, Number(r.min), Number(r.max), Number(Number(r.avg).toFixed(4)), r.samples]),
      alarms: d.alarms.map(a => [new Date(a.triggered_at).toISOString(), a.alarm_code, a.severity, a.cleared_at ? new Date(a.cleared_at).toISOString() : null]),
    })),
  });
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function newCode() { return generateClaimCode(12); }
function fmtCode(code) { return code.replace(/(.{4})(?=.)/g, '$1-'); }

function chLabel(S, ch) { return S.ch[ch] || ch; }

function deviceSection({ S, tz, d, bucketKey, single }) {
  const dev = d.device;
  const head = [
    { text: single ? S.device : `${S.device}: ${dev.name || dev.mqtt_device_id}`, style: 'sectionHeader' },
    {
      text: [
        { text: `${S.device}: `, bold: true }, `${dev.name || dev.mqtt_device_id}   `,
        { text: `${S.device_id}: `, bold: true }, `${dev.mqtt_device_id}   `,
        { text: `${S.serial}: `, bold: true }, `${dev.serial_number || '—'}   `,
        { text: `${S.model}: `, bold: true }, `${dev.model || '—'}`,
      ],
      margin: [0, 0, 0, 8],
    },
  ];
  const summaryTable = {
    table: {
      headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [
        [S.channel, S.min, S.max, S.avg, S.samples].map(t => ({ text: t, bold: true })),
        ...Object.entries(d.summary).map(([ch, s]) => [chLabel(S, ch), s.min, s.max, s.avg, String(s.samples)]),
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 5, 0, 12],
  };
  const alarmsBlock = d.alarms.length
    ? {
        table: {
          headerRows: 1, widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto'],
          body: [
            [S.time, S.code, S.severity, S.value, S.cleared, S.ack].map(t => ({ text: t, bold: true })),
            ...d.alarms.map(a => [
              localFmt(a.triggered_at, tz), a.alarm_code, a.severity || 'warning',
              a.value != null ? String(a.value) : '-',
              a.cleared_at ? localFmt(a.cleared_at, tz) : S.active,
              a.acknowledged_at ? `${localFmt(a.acknowledged_at, tz)} ${a.ack_by || ''}`.trim() : '-',
            ]),
          ],
        },
        layout: 'lightHorizontalLines', fontSize: 8, margin: [0, 5, 0, 12],
      }
    : { text: S.no_alarms, italics: true, margin: [0, 5, 0, 12] };
  const chCols = Object.keys(d.summary);
  const logTable = {
    table: {
      headerRows: 1, widths: ['auto', ...chCols.map(() => '*')],
      body: [
        [{ text: S.time, bold: true }, ...chCols.map(ch => ({ text: `${chLabel(S, ch)} °C`, bold: true }))],
        ...d.buckets.map(b => [localFmt(b.time, tz), ...chCols.map(ch => (b[ch] ? b[ch].avg.toFixed(2) : '-'))]),
      ],
    },
    layout: 'lightHorizontalLines', fontSize: 8, margin: [0, 5, 0, 12],
  };
  const service = d.lastService
    ? `${localFmt(d.lastService.service_date, tz, false)} — ${d.lastService.technician}: ${d.lastService.work_done}`
    : S.no_service;
  return [
    ...head,
    { text: S.summary, style: 'subHeader' }, summaryTable,
    { text: S.alarms, style: 'subHeader' }, alarmsBlock,
    { text: `${S.log} (${bucketKey})`, style: 'subHeader' }, logTable,
    { text: `${S.sensors_note} ${service}`, fontSize: 8, color: '#555555', margin: [0, 0, 0, 14] },
  ];
}

/**
 * @returns {{ docDefinition: object }}
 */
function buildDocument({ kind, lang, tz, tenant, site, devices, from, to, bucketKey, source, generatedBy, generatedAt, code, hash, verifyUrl }) {
  const S = strings(lang);
  const title = kind === 'site' ? S.site_title : S.title;
  const orgName = tenant.legal_name || tenant.name;
  const address = site ? [site.address_line, site.city, site.region, site.country].filter(Boolean).join(', ') : null;

  const meta = {
    columns: [
      {
        width: '*',
        text: [
          { text: `${S.organisation}: `, bold: true }, `${orgName}\n`,
          ...(tenant.tax_id ? [{ text: `${S.tax_id}: `, bold: true }, `${tenant.tax_id}\n`] : []),
          ...(site ? [{ text: `${S.site}: `, bold: true }, `${site.name}\n`, { text: `${S.address}: `, bold: true }, `${address || '—'}\n`] : []),
          { text: `${S.timezone}: `, bold: true }, tz,
        ],
      },
      {
        width: 'auto', alignment: 'right',
        text: [
          { text: `${S.period}: `, bold: true }, `${localFmt(from, tz)} — ${localFmt(to, tz)}\n`,
          { text: `${S.bucket}: `, bold: true }, `${bucketKey}\n`,
          { text: `${S.source}: `, bold: true }, `${source === 'hourly' ? S.source_hourly : S.source_raw}\n`,
          { text: `${S.generated}: `, bold: true }, `${localFmt(generatedAt, tz)} ${S.by} ${generatedBy}`,
        ],
      },
    ],
    margin: [0, 0, 0, 14],
  };

  const signBlock = {
    table: {
      widths: ['*', '*', '*', 'auto'],
      body: [
        [S.responsible, S.position, S.signature, S.date].map(t => ({ text: t, bold: true, fontSize: 8 })),
        [{ text: ' ', margin: [0, 14] }, ' ', ' ', '____.____.______'],
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 6, 0, 10],
  };

  const verifyBlock = {
    text: [
      { text: `${S.verify}: `, bold: true },
      `${S.verify_text} ${verifyUrl}\n`,
      { text: `${fmtCode(code)}   SHA-256 ${hash}`, fontSize: 7, color: '#555555' },
    ],
    fontSize: 8, margin: [0, 4, 0, 0],
  };

  return {
    docDefinition: {
      info: { title: `${title} — ${orgName}`, author: 'ModESP Cloud', subject: `${orgName} · ${localFmt(from, tz, false)} – ${localFmt(to, tz, false)}`, creator: 'ModESP Cloud', keywords: `HACCP, ${code}` },
      defaultStyle: { font: 'Roboto', fontSize: 9 },
      pageSize: 'A4', pageMargins: [40, 46, 40, 64],
      header: { text: `${orgName} — ${title}`, alignment: 'center', margin: [0, 16, 0, 0], fontSize: 9, bold: true, color: '#555555' },
      footer: (currentPage, pageCount) => ({
        columns: [
          { text: `${fmtCode(code)} · SHA-256 ${hash.slice(0, 16)}…`, fontSize: 7, color: '#777777' },
          { text: `${S.page} ${currentPage} ${S.of} ${pageCount}`, alignment: 'right', fontSize: 7, color: '#777777' },
        ],
        margin: [40, 18, 40, 0],
      }),
      content: [
        { text: title, style: 'title' },
        meta,
        ...devices.flatMap(d => deviceSection({ S, tz, d, bucketKey, single: kind === 'device' })),
        { text: S.responsible, style: 'sectionHeader' },
        signBlock,
        verifyBlock,
      ],
      styles: {
        title: { fontSize: 16, bold: true, margin: [0, 0, 0, 10] },
        sectionHeader: { fontSize: 12, bold: true, margin: [0, 10, 0, 5], color: '#333333' },
        subHeader: { fontSize: 10, bold: true, margin: [0, 6, 0, 2], color: '#444444' },
      },
    },
  };
}

async function render(docDefinition) {
  const pdf = pdfmake.createPdf(docDefinition);
  const buffer = await pdf.getBuffer();
  return Buffer.from(buffer);
}

async function registerExport({ query, code, kind, tenantId, deviceId, siteId, from, to, bucketKey, source, lang, hash, generatedBy }) {
  await query(
    `INSERT INTO report_exports (code, kind, tenant_id, device_id, site_id, period_from, period_to, bucket, source, lang, sha256, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [code, kind, tenantId, deviceId || null, siteId || null, from, to, bucketKey, source, lang, hash, generatedBy || null]
  );
}

function verifyUrlFor(code) {
  const base = (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/+$/, '');
  return `${base}/api/public/report/${code}`;
}

/**
 * Generate a report. `devices` are device rows (id, mqtt_device_id, name, serial_number, model).
 * @returns {Promise<{ buffer: Buffer, code: string, hash: string, source: string, bucketKey: string, empty: boolean }>}
 */
async function generate({ query, kind, tenant, site, devices, channels, from, to, bucketKey, lang, rawRetentionDays, generatedBy, now = new Date() }) {
  const plan = planSource({ from, to, rawRetentionDays, bucketKey, now });
  const collected = [];
  for (const device of devices) {
    collected.push(await collectDevice({ query, device, tenantId: tenant.id, channels, from, to, bucketSec: plan.bucketSec, source: plan.source }));
  }
  const withData = collected.filter(d => d.rows.length > 0);
  if (withData.length === 0) return { empty: true, source: plan.source, bucketKey: plan.bucketKey };

  const tz = (site && site.timezone) || tenant.timezone || 'Europe/Kyiv';
  const generatedAt = now.toISOString();
  const code = newCode();
  const hash = sha256(canonicalData({ kind, tenant, site, devices: withData, from, to, bucketKey: plan.bucketKey, source: plan.source, generatedAt }));
  const { docDefinition } = buildDocument({
    kind, lang, tz, tenant, site, devices: withData, from, to, bucketKey: plan.bucketKey, source: plan.source,
    generatedBy, generatedAt, code, hash, verifyUrl: verifyUrlFor(code),
  });
  const buffer = await render(docDefinition);
  await registerExport({
    query, code, kind, tenantId: tenant.id, deviceId: kind === 'device' ? devices[0].mqtt_device_id : null,
    siteId: site ? site.id : null, from, to, bucketKey: plan.bucketKey, source: plan.source, lang, hash, generatedBy,
  });
  return { buffer, code, hash, source: plan.source, bucketKey: plan.bucketKey, empty: false };
}

module.exports = {
  generate, strings, pickLang, planSource, fmtCode, localFmt, canonicalData, sha256,
  BUCKETS, RAW_MAX_DAYS, HOURLY_MAX_DAYS, HOURLY_RETENTION_DAYS,
};
