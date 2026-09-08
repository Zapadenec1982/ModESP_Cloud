'use strict';

/**
 * Alarm and energy period reports (plan epic 2.7).
 *
 * Two more site documents beside the HACCP temperature log, built for the
 * scheduled reports and sharing its conventions: localised (uk/en/pl/de),
 * headed with the organisation and the site, local time, a verification code
 * and the SHA-256 of the data in the footer, registered in report_exports.
 *
 *  alarms — every alarm of the site's devices raised in the period: totals by
 *           severity, per device, time to acknowledge, then the log. A period
 *           without alarms is still a document — that is what an inspector
 *           wants to see.
 *  energy — kWh per device from the `energy` telemetry channel (the hourly
 *           archive once raw retention has passed), compressor run hours
 *           from events, and the cost at the organisation's tariff.
 */

const haccp = require('./haccp-report');
const { ALARM_NAMES } = require('./email').__strings;

const STRINGS = {
  uk: {
    alarms_title: 'Звіт про аварії точки', energy_title: 'Звіт про енергоспоживання точки',
    organisation: 'Організація', tax_id: 'Код ЄДРПОУ/ІПН', serviced_by: 'Обслуговує', site: 'Точка', address: 'Адреса', timezone: 'Часовий пояс',
    period: 'Період', generated: 'Сформовано', by: 'ким', source: 'Джерело даних', source_raw: 'первинні вимірювання', source_hourly: 'погодинний архів',
    summary: 'Підсумок', total_alarms: 'Аварій за період', critical: 'Критичних', warning: 'Попереджень', info: 'Інформаційних',
    devices_affected: 'Обладнання з аваріями', unacknowledged: 'Не підтверджено', mtta: 'Середній час до підтвердження', still_active: 'Досі активних',
    by_device: 'За обладнанням', device: 'Обладнання', count: 'Аварій', longest: 'Найдовша', last_alarm: 'Остання',
    log: 'Журнал аварій', time: 'Час', alarm: 'Аварія', severity: 'Важливість', value: 'Значення', duration: 'Тривалість', ack_by: 'Підтвердив(-ла)',
    no_alarms: 'Аварій за період не зафіксовано.', active: 'активна', none: '—',
    total_kwh: 'Спожито, кВт·год', total_cost: 'Вартість', rate: 'Тариф', compressor_hours: 'Робота компресора, год',
    per_device: 'За обладнанням', kwh: 'кВт·год', cost: 'Вартість', samples: 'Вимірювань', duty: 'Компресор, % часу',
    energy_note: 'Споживання береться з каналу «energy» контролера (лічильник або оцінка за профілем обладнання); вартість — за тарифом організації в налаштуваннях.',
    responsible: 'Відповідальна особа', position: 'Посада', signature: 'Підпис', date: 'Дата',
    verify: 'Перевірка автентичності', verify_text: 'Код перевірки та SHA-256 даних звіту зберігаються платформою. Перевірити:',
    page: 'Сторінка', of: 'з', h: 'год', m: 'хв',
    sev: { critical: 'Критично', warning: 'Попередження', info: 'Інформація' },
  },
  en: {
    alarms_title: 'Site alarm report', energy_title: 'Site energy report',
    organisation: 'Organisation', tax_id: 'Tax ID', serviced_by: 'Serviced by', site: 'Site', address: 'Address', timezone: 'Time zone',
    period: 'Period', generated: 'Generated', by: 'by', source: 'Data source', source_raw: 'raw measurements', source_hourly: 'hourly archive',
    summary: 'Summary', total_alarms: 'Alarms in the period', critical: 'Critical', warning: 'Warnings', info: 'Informational',
    devices_affected: 'Equipment with alarms', unacknowledged: 'Unacknowledged', mtta: 'Mean time to acknowledge', still_active: 'Still active',
    by_device: 'By equipment', device: 'Equipment', count: 'Alarms', longest: 'Longest', last_alarm: 'Last',
    log: 'Alarm log', time: 'Time', alarm: 'Alarm', severity: 'Severity', value: 'Value', duration: 'Duration', ack_by: 'Acknowledged by',
    no_alarms: 'No alarms during this period.', active: 'active', none: '—',
    total_kwh: 'Consumed, kWh', total_cost: 'Cost', rate: 'Tariff', compressor_hours: 'Compressor run time, h',
    per_device: 'By equipment', kwh: 'kWh', cost: 'Cost', samples: 'Samples', duty: 'Compressor, % of time',
    energy_note: 'Consumption comes from the controller\'s "energy" channel (a meter or an estimate from the equipment profile); the cost uses the organisation\'s tariff from Settings.',
    responsible: 'Responsible person', position: 'Position', signature: 'Signature', date: 'Date',
    verify: 'Authenticity check', verify_text: 'The verification code and the SHA-256 of the report data are stored by the platform. Verify at:',
    page: 'Page', of: 'of', h: 'h', m: 'min',
    sev: { critical: 'Critical', warning: 'Warning', info: 'Info' },
  },
  pl: {
    alarms_title: 'Raport alarmów lokalizacji', energy_title: 'Raport zużycia energii lokalizacji',
    organisation: 'Organizacja', tax_id: 'NIP', serviced_by: 'Obsługuje', site: 'Lokalizacja', address: 'Adres', timezone: 'Strefa czasowa',
    period: 'Okres', generated: 'Wygenerowano', by: 'przez', source: 'Źródło danych', source_raw: 'pomiary surowe', source_hourly: 'archiwum godzinowe',
    summary: 'Podsumowanie', total_alarms: 'Alarmów w okresie', critical: 'Krytycznych', warning: 'Ostrzeżeń', info: 'Informacyjnych',
    devices_affected: 'Urządzenia z alarmami', unacknowledged: 'Niepotwierdzone', mtta: 'Średni czas do potwierdzenia', still_active: 'Nadal aktywne',
    by_device: 'Według urządzeń', device: 'Urządzenie', count: 'Alarmów', longest: 'Najdłuższy', last_alarm: 'Ostatni',
    log: 'Dziennik alarmów', time: 'Czas', alarm: 'Alarm', severity: 'Ważność', value: 'Wartość', duration: 'Czas trwania', ack_by: 'Potwierdził(a)',
    no_alarms: 'Brak alarmów w tym okresie.', active: 'aktywny', none: '—',
    total_kwh: 'Zużyto, kWh', total_cost: 'Koszt', rate: 'Taryfa', compressor_hours: 'Praca sprężarki, h',
    per_device: 'Według urządzeń', kwh: 'kWh', cost: 'Koszt', samples: 'Pomiary', duty: 'Sprężarka, % czasu',
    energy_note: 'Zużycie pochodzi z kanału „energy” sterownika (licznik lub szacunek z profilu urządzenia); koszt według taryfy organizacji w ustawieniach.',
    responsible: 'Osoba odpowiedzialna', position: 'Stanowisko', signature: 'Podpis', date: 'Data',
    verify: 'Weryfikacja autentyczności', verify_text: 'Kod weryfikacyjny i SHA-256 danych raportu są przechowywane przez platformę. Sprawdź:',
    page: 'Strona', of: 'z', h: 'godz.', m: 'min',
    sev: { critical: 'Krytyczny', warning: 'Ostrzeżenie', info: 'Informacja' },
  },
  de: {
    alarms_title: 'Alarmbericht des Standorts', energy_title: 'Energiebericht des Standorts',
    organisation: 'Organisation', tax_id: 'Steuernummer', serviced_by: 'Betreut von', site: 'Standort', address: 'Adresse', timezone: 'Zeitzone',
    period: 'Zeitraum', generated: 'Erstellt', by: 'von', source: 'Datenquelle', source_raw: 'Rohmessungen', source_hourly: 'Stundenarchiv',
    summary: 'Zusammenfassung', total_alarms: 'Alarme im Zeitraum', critical: 'Kritisch', warning: 'Warnungen', info: 'Hinweise',
    devices_affected: 'Anlagen mit Alarmen', unacknowledged: 'Unbestätigt', mtta: 'Mittlere Zeit bis zur Bestätigung', still_active: 'Noch aktiv',
    by_device: 'Nach Anlage', device: 'Anlage', count: 'Alarme', longest: 'Längster', last_alarm: 'Letzter',
    log: 'Alarmprotokoll', time: 'Zeit', alarm: 'Alarm', severity: 'Schwere', value: 'Wert', duration: 'Dauer', ack_by: 'Bestätigt von',
    no_alarms: 'Keine Alarme in diesem Zeitraum.', active: 'aktiv', none: '—',
    total_kwh: 'Verbrauch, kWh', total_cost: 'Kosten', rate: 'Tarif', compressor_hours: 'Verdichterlaufzeit, h',
    per_device: 'Nach Anlage', kwh: 'kWh', cost: 'Kosten', samples: 'Messungen', duty: 'Verdichter, % der Zeit',
    energy_note: 'Der Verbrauch stammt aus dem Kanal „energy“ des Controllers (Zähler oder Schätzung aus dem Anlagenprofil); die Kosten nach dem Tarif der Organisation in den Einstellungen.',
    responsible: 'Verantwortliche Person', position: 'Position', signature: 'Unterschrift', date: 'Datum',
    verify: 'Echtheitsprüfung', verify_text: 'Prüfcode und SHA-256 der Berichtsdaten werden von der Plattform gespeichert. Prüfen unter:',
    page: 'Seite', of: 'von', h: 'Std.', m: 'Min.',
    sev: { critical: 'Kritisch', warning: 'Warnung', info: 'Info' },
  },
};

const TYPES = ['alarms', 'energy'];

function strings(lang) { return STRINGS[lang] || STRINGS.uk; }

function alarmName(lang, code) {
  const names = ALARM_NAMES[lang] || ALARM_NAMES.uk || {};
  return names[code] || names[`protection.${code}`] || code;
}

function fmtDuration(ms, S) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return S.none;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} ${S.m}`;
  const h = Math.floor(min / 60);
  return `${h} ${S.h} ${min % 60} ${S.m}`;
}

function num(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

// ── Data ─────────────────────────────────────────────────

async function activeDeviceCount({ query, tenantId, siteId }) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM devices WHERE tenant_id = $1 AND site_id = $2 AND status = 'active'`, [tenantId, siteId]);
  return rows[0].n;
}

async function fetchSiteAlarms({ query, tenantId, siteId, from, to }) {
  const { rows } = await query(
    `SELECT a.device_id, COALESCE(d.name, a.device_id) AS device_name, a.alarm_code, a.severity, a.value, a.limit_value,
            a.triggered_at, a.cleared_at, a.acknowledged_at, u.email AS ack_by
       FROM alarms a
       JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
       LEFT JOIN users u ON u.id = a.acknowledged_by
      WHERE a.tenant_id = $1 AND d.site_id = $2 AND a.triggered_at >= $3 AND a.triggered_at < $4
      ORDER BY a.triggered_at ASC LIMIT 2000`,
    [tenantId, siteId, from, to]);
  return rows;
}

async function fetchSiteEnergy({ query, tenantId, siteId, from, to, source }) {
  const { rows: devices } = await query(
    `SELECT id, mqtt_device_id, name FROM devices WHERE tenant_id = $1 AND site_id = $2 AND status = 'active' ORDER BY name, mqtt_device_id LIMIT 50`,
    [tenantId, siteId]);
  const out = [];
  for (const d of devices) {
    const energy = source === 'hourly'
      ? await query(
        `SELECT COALESCE(SUM(avg * samples), 0) AS kwh, COALESCE(SUM(samples), 0)::int AS samples
           FROM telemetry_hourly WHERE tenant_id = $1 AND device_id = $2 AND channel = 'energy' AND hour >= $3 AND hour < $4`,
        [tenantId, d.mqtt_device_id, from, to])
      : await query(
        `SELECT COALESCE(SUM(value), 0) AS kwh, COUNT(*)::int AS samples
           FROM telemetry WHERE tenant_id = $1 AND device_id = $2 AND channel = 'energy' AND time >= $3 AND time < $4`,
        [tenantId, d.mqtt_device_id, from, to]);
    const comp = await query(
      `WITH t AS (
         SELECT time, event_type, LEAD(time) OVER (ORDER BY time) AS next_time
           FROM events
          WHERE tenant_id = $1 AND device_id = $2 AND event_type IN ('compressor_on', 'compressor_off') AND time >= $3 AND time < $4)
       SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(next_time, $4::timestamptz) - time)) / 3600), 0) AS hours
         FROM t WHERE event_type = 'compressor_on'`,
      [tenantId, d.mqtt_device_id, from, to]);
    out.push({
      mqtt_device_id: d.mqtt_device_id, name: d.name || d.mqtt_device_id,
      kwh: Number(energy.rows[0].kwh), samples: energy.rows[0].samples, compressor_hours: Number(comp.rows[0].hours),
    });
  }
  return out;
}

// ── Document ─────────────────────────────────────────────

function shell({ S, tz, tenant, site, from, to, title, source, generatedBy, generatedAt, code, hash, verifyUrl, keywords, content, sign }) {
  const orgName = tenant.legal_name || tenant.name;
  const address = [site.address_line, site.city, site.region, site.country].filter(Boolean).join(', ');
  const meta = {
    columns: [
      {
        width: '*',
        text: [
          { text: `${S.organisation}: `, bold: true }, `${orgName}\n`,
          ...(tenant.tax_id ? [{ text: `${S.tax_id}: `, bold: true }, `${tenant.tax_id}\n`] : []),
          ...(tenant.brand_name ? [{ text: `${S.serviced_by}: `, bold: true }, `${tenant.brand_name}${tenant.brand_url ? ' · ' + tenant.brand_url : ''}\n`] : []),
          { text: `${S.site}: `, bold: true }, `${site.name}\n`,
          { text: `${S.address}: `, bold: true }, `${address || '—'}\n`,
          { text: `${S.timezone}: `, bold: true }, tz,
        ],
      },
      {
        width: 'auto', alignment: 'right',
        text: [
          { text: `${S.period}: `, bold: true }, `${haccp.localFmt(from, tz)} — ${haccp.localFmt(to, tz)}\n`,
          ...(source ? [{ text: `${S.source}: `, bold: true }, `${source === 'hourly' ? S.source_hourly : S.source_raw}\n`] : []),
          { text: `${S.generated}: `, bold: true }, `${haccp.localFmt(generatedAt, tz)} ${S.by} ${generatedBy}`,
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
      { text: `${haccp.fmtCode(code)}   SHA-256 ${hash}`, fontSize: 7, color: '#555555' },
    ],
    fontSize: 8, margin: [0, 4, 0, 0],
  };
  return {
    info: { title: `${title} — ${orgName}`, author: 'ModESP Cloud', subject: `${orgName} · ${site.name} · ${haccp.localFmt(from, tz, false)} – ${haccp.localFmt(to, tz, false)}`, creator: 'ModESP Cloud', keywords: `${keywords}, ${code}` },
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    pageSize: 'A4', pageMargins: [40, 46, 40, 64],
    header: { text: `${orgName} — ${title}`, alignment: 'center', margin: [0, 16, 0, 0], fontSize: 9, bold: true, color: '#555555' },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `${tenant.brand_name ? tenant.brand_name + ' · ' : ''}${haccp.fmtCode(code)} · SHA-256 ${hash.slice(0, 16)}…`, fontSize: 7, color: '#777777' },
        { text: `${S.page} ${currentPage} ${S.of} ${pageCount}`, alignment: 'right', fontSize: 7, color: '#777777' },
      ],
      margin: [40, 18, 40, 0],
    }),
    content: [
      { text: title, style: 'title' },
      meta,
      ...content,
      ...(sign ? [{ text: S.responsible, style: 'sectionHeader' }, signBlock] : []),
      verifyBlock,
    ],
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 10] },
      sectionHeader: { fontSize: 12, bold: true, margin: [0, 10, 0, 5], color: '#333333' },
      subHeader: { fontSize: 10, bold: true, margin: [0, 6, 0, 2], color: '#444444' },
      th: { bold: true, fontSize: 8, fillColor: '#f2f2f2' },
      td: { fontSize: 8 },
    },
  };
}

function kv(pairs) {
  return {
    table: { widths: ['auto', '*'], body: pairs.map(([k, v]) => [{ text: k, bold: true, fontSize: 9 }, { text: String(v), fontSize: 9 }]) },
    layout: 'noBorders', margin: [0, 0, 0, 6],
  };
}

function table(headers, rows, widths) {
  return {
    table: { headerRows: 1, widths, body: [headers.map(h => ({ text: h, style: 'th' })), ...rows.map(r => r.map(c => ({ text: String(c), style: 'td' })))] },
    layout: 'lightHorizontalLines', margin: [0, 0, 0, 8],
  };
}

function alarmsContent({ S, lang, tz, rows }) {
  const bySev = { critical: 0, warning: 0, info: 0 };
  const perDevice = new Map();
  let ackMs = 0, acked = 0, unacked = 0, active = 0;
  for (const a of rows) {
    if (a.severity in bySev) bySev[a.severity]++;
    const durMs = a.cleared_at ? new Date(a.cleared_at) - new Date(a.triggered_at) : null;
    if (!a.cleared_at) active++;
    if (a.acknowledged_at) { acked++; ackMs += new Date(a.acknowledged_at) - new Date(a.triggered_at); } else unacked++;
    const d = perDevice.get(a.device_id) || { name: a.device_name, count: 0, critical: 0, longestMs: 0, last: null };
    d.count++;
    if (a.severity === 'critical') d.critical++;
    if (durMs !== null && durMs > d.longestMs) d.longestMs = durMs;
    d.last = a.triggered_at;
    perDevice.set(a.device_id, d);
  }
  const summary = kv([
    [S.total_alarms, rows.length],
    [S.critical, bySev.critical], [S.warning, bySev.warning], [S.info, bySev.info],
    [S.devices_affected, perDevice.size],
    [S.unacknowledged, unacked],
    [S.mtta, acked ? fmtDuration(ackMs / acked, S) : S.none],
    [S.still_active, active],
  ]);
  if (rows.length === 0) {
    return [{ text: S.summary, style: 'sectionHeader' }, summary, { text: S.no_alarms, italics: true, margin: [0, 4, 0, 8] }];
  }
  const byDevice = table(
    [S.device, S.count, S.critical, S.longest, S.last_alarm],
    [...perDevice.values()].sort((a, b) => b.count - a.count).map(d => [d.name, d.count, d.critical, d.longestMs ? fmtDuration(d.longestMs, S) : S.none, haccp.localFmt(d.last, tz)]),
    ['*', 'auto', 'auto', 'auto', 'auto']);
  const log = table(
    [S.time, S.device, S.alarm, S.severity, S.value, S.duration, S.ack_by],
    rows.map(a => [
      haccp.localFmt(a.triggered_at, tz), a.device_name, alarmName(lang, a.alarm_code), S.sev[a.severity] || a.severity,
      a.value !== null && a.value !== undefined ? `${num(a.value)}${a.limit_value !== null && a.limit_value !== undefined ? ' / ' + num(a.limit_value) : ''}` : S.none,
      a.cleared_at ? fmtDuration(new Date(a.cleared_at) - new Date(a.triggered_at), S) : S.active,
      a.ack_by || S.none,
    ]),
    ['auto', '*', '*', 'auto', 'auto', 'auto', '*']);
  return [
    { text: S.summary, style: 'sectionHeader' }, summary,
    { text: S.by_device, style: 'sectionHeader' }, byDevice,
    { text: S.log, style: 'sectionHeader' }, log,
  ];
}

function energyContent({ S, tenant, rows, from, to }) {
  const rate = tenant.electricity_rate !== null && tenant.electricity_rate !== undefined ? Number(tenant.electricity_rate) : null;
  const currency = tenant.electricity_currency || 'UAH';
  const hours = Math.max(1, (new Date(to) - new Date(from)) / 3600000);
  const totalKwh = rows.reduce((s, r) => s + r.kwh, 0);
  const totalHours = rows.reduce((s, r) => s + r.compressor_hours, 0);
  const cost = (kwh) => (rate === null ? S.none : `${num(kwh * rate, 2)} ${currency}`);
  const summary = kv([
    [S.total_kwh, num(totalKwh)],
    [S.total_cost, cost(totalKwh)],
    [S.rate, rate === null ? S.none : `${num(rate, 2)} ${currency}/${S.kwh}`],
    [S.compressor_hours, num(totalHours)],
  ]);
  const perDevice = table(
    [S.device, S.kwh, S.cost, S.compressor_hours, S.duty, S.samples],
    rows.map(r => [r.name, num(r.kwh), cost(r.kwh), num(r.compressor_hours), `${num(100 * r.compressor_hours / hours, 0)} %`, r.samples]),
    ['*', 'auto', 'auto', 'auto', 'auto', 'auto']);
  return [
    { text: S.summary, style: 'sectionHeader' }, summary,
    { text: S.per_device, style: 'sectionHeader' }, perDevice,
    { text: S.energy_note, fontSize: 8, color: '#555555', margin: [0, 4, 0, 8] },
  ];
}

/**
 * Generate an alarm or energy report for one site.
 * @returns {Promise<{ buffer: Buffer, code: string, hash: string, source: string, empty: boolean }>}
 */
async function generate({ query, type, tenant, site, from, to, lang, rawRetentionDays, generatedBy, scheduleId = null, now = new Date() }) {
  if (!TYPES.includes(type)) throw new Error(`Unknown report type: ${type}`);
  const S = strings(lang);
  const tz = site.timezone || tenant.timezone || 'Europe/Kyiv';
  const generatedAt = now.toISOString();
  const tenantId = tenant.id;
  let content, source, data, title;

  if (type === 'alarms') {
    if ((await activeDeviceCount({ query, tenantId, siteId: site.id })) === 0) return { empty: true, source: 'raw' };
    const rows = await fetchSiteAlarms({ query, tenantId, siteId: site.id, from, to });
    source = 'raw';
    data = rows;
    title = S.alarms_title;
    content = alarmsContent({ S, lang, tz, rows });
  } else {
    const plan = haccp.planSource({ from, to, rawRetentionDays, bucketKey: '1h', now });
    source = plan.source;
    const rows = await fetchSiteEnergy({ query, tenantId, siteId: site.id, from, to, source });
    const withData = rows.filter(r => r.samples > 0 || r.compressor_hours > 0);
    if (withData.length === 0) return { empty: true, source };
    data = withData;
    title = S.energy_title;
    content = energyContent({ S, tenant, rows: withData, from, to });
  }

  const code = haccp.newCode();
  const hash = haccp.sha256(JSON.stringify({ type, tenant: tenantId, site: site.id, from, to, source, generatedAt, data }));
  const doc = shell({
    S, tz, tenant, site, from, to, title, source: type === 'energy' ? source : null, generatedBy, generatedAt, code, hash,
    verifyUrl: haccp.verifyUrlFor(code), keywords: type === 'alarms' ? 'alarms' : 'energy', content, sign: type === 'alarms',
  });
  const buffer = await haccp.render(doc);
  await haccp.registerExport({
    query, code, kind: 'site', tenantId, deviceId: null, siteId: site.id, from, to, bucketKey: '1h', source, lang, hash, generatedBy,
    reportType: type, scheduleId,
  });
  return { buffer, code, hash, source, empty: false };
}

module.exports = { generate, strings, alarmName, fmtDuration, STRINGS, TYPES };
