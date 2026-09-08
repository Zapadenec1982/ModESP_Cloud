'use strict';

/**
 * HACCP temperature-control journal (plan epic 1.9; journal form 2026-09).
 *
 * Builds the pdfmake document for one device or for every device of a site
 * in the shape of the regulatory "temperature control log of refrigeration
 * equipment": localised (uk/en/pl/de), headed with the business's legal name,
 * the site, the equipment, what it stores and its critical limits; a control
 * log grouped by local day where every interval carries the temperature, its
 * min/max, a deviation flag against the limits and the corrective action taken
 * (from alarm acknowledgements, work orders and service records), intervals
 * without measurements printed as explicit gaps, a signature line per day,
 * an events-and-corrective-actions table with alarm names in the report
 * language, the responsible-person and verified-by blocks, and a footer with
 * the SHA-256 of the report data plus a verification code that
 * GET /api/public/report/:code confirms.
 *
 * Critical limits: devices.haccp_min/haccp_max (the business's HACCP plan),
 * else the controller's protection.low_limit/high_limit from its last state,
 * else none — then the journal says so instead of flagging nothing silently.
 *
 * Data comes from raw telemetry for recent periods and from telemetry_hourly
 * (the three-year archive) once the raw retention of the organisation's plan
 * has passed.
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
    title: 'Журнал контролю температурного режиму холодильного обладнання (HACCP)', site_title: 'Журнал контролю температурного режиму холодильного обладнання точки (HACCP)',
    organisation: 'Підприємство', tax_id: 'Код ЄДРПОУ/ІПН', serviced_by: 'Обслуговує', site: 'Точка (підрозділ)', address: 'Адреса', timezone: 'Часовий пояс',
    device: 'Обладнання', device_id: 'Ідентифікатор', serial: 'Серійний номер', model: 'Модель',
    product: 'Продукція / призначення', limits: 'Критичні межі', limits_org: 'за програмою HACCP підприємства', limits_controller: 'за налаштуваннями тривог контролера',
    limits_none: 'не задано', frequency: 'Періодичність фіксації', every: 'кожні',
    period: 'Період', bucket: 'Інтервал', generated: 'Сформовано', by: 'ким',
    source: 'Джерело даних', source_raw: 'первинні вимірювання контролера', source_hourly: 'погодинний архів (мін/макс/середнє за годину)',
    summary: 'Підсумок', channel: 'Канал', min: 'Мін °C', max: 'Макс °C', avg: 'Сер. °C', samples: 'Вимірювань',
    deviations: 'Відхилень', gaps: 'Прогалин у даних', intervals: 'інтервалів', h: 'год', longest: 'найдовше', worst: 'крайнє значення', none_recorded: 'не зафіксовано',
    journal: 'Журнал контролю', col_time: 'Час', col_temp: 'Темп. °C', col_min: 'мін', col_max: 'макс', col_deviation: 'Відхилення', col_actions: 'Коригувальні дії / примітка',
    yes: 'Так', no: 'Ні', nd: 'н/д', above: 'вище', below: 'нижче', peak: 'пік поза межами', gap: 'дані відсутні', gap_offline: 'дані відсутні — контролер офлайн',
    day_sign: 'Відповідальна особа за день (ПІБ, підпис):',
    corrective: 'Події та коригувальні дії за період', no_corrective: 'Тривог і коригувальних дій за період не зафіксовано.',
    time: 'Час', event: 'Подія', severity: 'Важливість', value: 'Значення', limit: 'межа', cleared: 'Знято', active: 'Активна', ack: 'Підтверджено', note: 'нотатка',
    work_order: 'Наряд', service: 'Сервісний запис', wo: { new: 'новий', assigned: 'призначено', in_progress: 'у роботі', done: 'виконано', cancelled: 'скасовано' },
    sev: { critical: 'критична', warning: 'попередження', info: 'інформація' },
    responsible: 'Відповідальна особа', verified_by: 'Перевірив (відповідальний за HACCP)', full_name: 'ПІБ', position: 'Посада', signature: 'Підпис', date: 'Дата',
    sensors_note: 'Примітка про датчики: температура вимірюється датчиками контролера ModESP; періодичність повірки/калібрування визначає підприємство згідно з власною програмою HACCP. Остання сервісна відмітка щодо обладнання:',
    no_service: 'записів обслуговування за період зберігання немає',
    deviation_note: 'Відхилення визначається за середнім значенням інтервалу поза критичними межами; «мін»/«макс» показують короткочасні піки (розморожування, завантаження товару, відчинені двері).',
    gaps_note: 'Інтервали без вимірювань позначено «дані відсутні»: контролер не передавав дані (звʼязок, живлення). Такі інтервали не підтверджують дотримання режиму і потребують ручної відмітки.',
    no_limits_note: 'Критичні межі для цього обладнання не задані, тому відхилення не визначалися. Задайте межі в картці обладнання (поля HACCP) або на контролері.',
    verify: 'Перевірка автентичності', verify_text: 'Код перевірки та SHA-256 даних звіту зберігаються платформою. Перевірити:',
    page: 'Сторінка', of: 'з', no_data: 'Дані за період відсутні',
    ch: { air: 'Повітря', evap: 'Випарник', cond: 'Конденсатор', setpoint: 'Уставка', comp: 'Компресор', defrost: 'Розморожування', energy: 'Енергія' },
  },
  en: {
    title: 'Refrigeration Equipment Temperature Control Log (HACCP)', site_title: 'Refrigeration Equipment Temperature Control Log (HACCP) — site',
    organisation: 'Business', tax_id: 'Tax ID', serviced_by: 'Serviced by', site: 'Site (unit)', address: 'Address', timezone: 'Time zone',
    device: 'Equipment', device_id: 'Identifier', serial: 'Serial number', model: 'Model',
    product: 'Product / purpose', limits: 'Critical limits', limits_org: "per the business's HACCP plan", limits_controller: "per the controller's alarm settings",
    limits_none: 'not set', frequency: 'Recording frequency', every: 'every',
    period: 'Period', bucket: 'Interval', generated: 'Generated', by: 'by',
    source: 'Data source', source_raw: 'raw controller measurements', source_hourly: 'hourly archive (min/max/avg per hour)',
    summary: 'Summary', channel: 'Channel', min: 'Min °C', max: 'Max °C', avg: 'Avg °C', samples: 'Samples',
    deviations: 'Deviations', gaps: 'Data gaps', intervals: 'intervals', h: 'h', longest: 'longest', worst: 'extreme value', none_recorded: 'none recorded',
    journal: 'Control log', col_time: 'Time', col_temp: 'Temp °C', col_min: 'min', col_max: 'max', col_deviation: 'Deviation', col_actions: 'Corrective action / note',
    yes: 'Yes', no: 'No', nd: 'n/a', above: 'above', below: 'below', peak: 'peak outside limits', gap: 'no data', gap_offline: 'no data — controller offline',
    day_sign: 'Responsible person for the day (name, signature):',
    corrective: 'Events and corrective actions during the period', no_corrective: 'No alarms or corrective actions during this period.',
    time: 'Time', event: 'Event', severity: 'Severity', value: 'Value', limit: 'limit', cleared: 'Cleared', active: 'Active', ack: 'Acknowledged', note: 'note',
    work_order: 'Work order', service: 'Service record', wo: { new: 'new', assigned: 'assigned', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' },
    sev: { critical: 'critical', warning: 'warning', info: 'info' },
    responsible: 'Responsible person', verified_by: 'Verified by (HACCP team leader)', full_name: 'Full name', position: 'Position', signature: 'Signature', date: 'Date',
    sensors_note: 'Sensor note: temperatures are measured by the ModESP controller sensors; the verification/calibration interval is set by the business in its HACCP plan. Last service record for this equipment:',
    no_service: 'no service records within the retention period',
    deviation_note: 'A deviation is an interval whose average is outside the critical limits; "min"/"max" show short peaks (defrost, loading, open door).',
    gaps_note: 'Intervals without measurements are marked "no data": the controller sent nothing (connectivity, power). They do not confirm compliance and need a manual entry.',
    no_limits_note: 'No critical limits are set for this equipment, so deviations were not evaluated. Set them on the equipment card (HACCP fields) or on the controller.',
    verify: 'Authenticity check', verify_text: 'The verification code and the SHA-256 of the report data are stored by the platform. Verify at:',
    page: 'Page', of: 'of', no_data: 'No data for the period',
    ch: { air: 'Air', evap: 'Evaporator', cond: 'Condenser', setpoint: 'Setpoint', comp: 'Compressor', defrost: 'Defrost', energy: 'Energy' },
  },
  pl: {
    title: 'Dziennik kontroli temperatury urządzeń chłodniczych (HACCP)', site_title: 'Dziennik kontroli temperatury urządzeń chłodniczych lokalizacji (HACCP)',
    organisation: 'Przedsiębiorstwo', tax_id: 'NIP', serviced_by: 'Obsługuje', site: 'Lokalizacja (dział)', address: 'Adres', timezone: 'Strefa czasowa',
    device: 'Urządzenie', device_id: 'Identyfikator', serial: 'Numer seryjny', model: 'Model',
    product: 'Produkt / przeznaczenie', limits: 'Limity krytyczne', limits_org: 'wg planu HACCP przedsiębiorstwa', limits_controller: 'wg ustawień alarmów sterownika',
    limits_none: 'nie ustawiono', frequency: 'Częstotliwość zapisu', every: 'co',
    period: 'Okres', bucket: 'Interwał', generated: 'Wygenerowano', by: 'przez',
    source: 'Źródło danych', source_raw: 'pomiary surowe sterownika', source_hourly: 'archiwum godzinowe (min/maks/śr. na godzinę)',
    summary: 'Podsumowanie', channel: 'Kanał', min: 'Min °C', max: 'Maks °C', avg: 'Śr. °C', samples: 'Pomiary',
    deviations: 'Odchylenia', gaps: 'Luki w danych', intervals: 'interwałów', h: 'h', longest: 'najdłużej', worst: 'wartość skrajna', none_recorded: 'nie odnotowano',
    journal: 'Dziennik kontroli', col_time: 'Czas', col_temp: 'Temp. °C', col_min: 'min', col_max: 'maks', col_deviation: 'Odchylenie', col_actions: 'Działanie korygujące / uwaga',
    yes: 'Tak', no: 'Nie', nd: 'b/d', above: 'powyżej', below: 'poniżej', peak: 'pik poza limitami', gap: 'brak danych', gap_offline: 'brak danych — sterownik offline',
    day_sign: 'Osoba odpowiedzialna za dzień (imię i nazwisko, podpis):',
    corrective: 'Zdarzenia i działania korygujące w okresie', no_corrective: 'Brak alarmów i działań korygujących w tym okresie.',
    time: 'Czas', event: 'Zdarzenie', severity: 'Ważność', value: 'Wartość', limit: 'limit', cleared: 'Zakończony', active: 'Aktywny', ack: 'Potwierdzony', note: 'uwaga',
    work_order: 'Zlecenie', service: 'Wpis serwisowy', wo: { new: 'nowe', assigned: 'przydzielone', in_progress: 'w toku', done: 'wykonane', cancelled: 'anulowane' },
    sev: { critical: 'krytyczny', warning: 'ostrzeżenie', info: 'informacja' },
    responsible: 'Osoba odpowiedzialna', verified_by: 'Sprawdził (odpowiedzialny za HACCP)', full_name: 'Imię i nazwisko', position: 'Stanowisko', signature: 'Podpis', date: 'Data',
    sensors_note: 'Uwaga o czujnikach: temperatury mierzą czujniki sterownika ModESP; częstotliwość sprawdzania/kalibracji ustala przedsiębiorstwo w swoim planie HACCP. Ostatni wpis serwisowy dla urządzenia:',
    no_service: 'brak wpisów serwisowych w okresie przechowywania',
    deviation_note: 'Odchylenie to interwał, którego średnia leży poza limitami krytycznymi; „min”/„maks” pokazują krótkie piki (odszranianie, załadunek, otwarte drzwi).',
    gaps_note: 'Interwały bez pomiarów oznaczono „brak danych”: sterownik nic nie przesłał (łączność, zasilanie). Nie potwierdzają one zgodności i wymagają ręcznego wpisu.',
    no_limits_note: 'Dla tego urządzenia nie ustawiono limitów krytycznych, więc odchyleń nie oceniano. Ustaw je w karcie urządzenia (pola HACCP) lub na sterowniku.',
    verify: 'Weryfikacja autentyczności', verify_text: 'Kod weryfikacyjny i SHA-256 danych raportu są przechowywane przez platformę. Sprawdź:',
    page: 'Strona', of: 'z', no_data: 'Brak danych za okres',
    ch: { air: 'Powietrze', evap: 'Parownik', cond: 'Skraplacz', setpoint: 'Nastawa', comp: 'Sprężarka', defrost: 'Odszranianie', energy: 'Energia' },
  },
  de: {
    title: 'Temperaturkontrollprotokoll für Kühlanlagen (HACCP)', site_title: 'Temperaturkontrollprotokoll für Kühlanlagen des Standorts (HACCP)',
    organisation: 'Betrieb', tax_id: 'Steuernummer', serviced_by: 'Betreut von', site: 'Standort (Bereich)', address: 'Adresse', timezone: 'Zeitzone',
    device: 'Anlage', device_id: 'Kennung', serial: 'Seriennummer', model: 'Modell',
    product: 'Produkt / Zweck', limits: 'Kritische Grenzwerte', limits_org: 'laut HACCP-Konzept des Betriebs', limits_controller: 'laut Alarmeinstellungen des Reglers',
    limits_none: 'nicht festgelegt', frequency: 'Aufzeichnungsintervall', every: 'alle',
    period: 'Zeitraum', bucket: 'Intervall', generated: 'Erstellt', by: 'von',
    source: 'Datenquelle', source_raw: 'Rohmessungen des Reglers', source_hourly: 'Stundenarchiv (Min/Max/Mittel je Stunde)',
    summary: 'Zusammenfassung', channel: 'Kanal', min: 'Min °C', max: 'Max °C', avg: 'Mittel °C', samples: 'Messungen',
    deviations: 'Abweichungen', gaps: 'Datenlücken', intervals: 'Intervalle', h: 'h', longest: 'längste', worst: 'Extremwert', none_recorded: 'keine',
    journal: 'Kontrollprotokoll', col_time: 'Zeit', col_temp: 'Temp. °C', col_min: 'min', col_max: 'max', col_deviation: 'Abweichung', col_actions: 'Korrekturmaßnahme / Bemerkung',
    yes: 'Ja', no: 'Nein', nd: 'k. A.', above: 'über', below: 'unter', peak: 'Spitze außerhalb', gap: 'keine Daten', gap_offline: 'keine Daten — Regler offline',
    day_sign: 'Verantwortliche Person des Tages (Name, Unterschrift):',
    corrective: 'Ereignisse und Korrekturmaßnahmen im Zeitraum', no_corrective: 'Keine Alarme und Korrekturmaßnahmen in diesem Zeitraum.',
    time: 'Zeit', event: 'Ereignis', severity: 'Schwere', value: 'Wert', limit: 'Grenze', cleared: 'Beendet', active: 'Aktiv', ack: 'Bestätigt', note: 'Notiz',
    work_order: 'Auftrag', service: 'Serviceeintrag', wo: { new: 'neu', assigned: 'zugewiesen', in_progress: 'in Arbeit', done: 'erledigt', cancelled: 'storniert' },
    sev: { critical: 'kritisch', warning: 'Warnung', info: 'Info' },
    responsible: 'Verantwortliche Person', verified_by: 'Geprüft von (HACCP-Verantwortlicher)', full_name: 'Name', position: 'Position', signature: 'Unterschrift', date: 'Datum',
    sensors_note: 'Hinweis zu Sensoren: Die Temperaturen werden von den Sensoren des ModESP-Reglers gemessen; das Prüf-/Kalibrierintervall legt der Betrieb in seinem HACCP-Konzept fest. Letzter Serviceeintrag für diese Anlage:',
    no_service: 'keine Serviceeinträge im Aufbewahrungszeitraum',
    deviation_note: 'Eine Abweichung ist ein Intervall, dessen Mittelwert außerhalb der kritischen Grenzwerte liegt; „min“/„max“ zeigen kurze Spitzen (Abtauung, Beladung, offene Tür).',
    gaps_note: 'Intervalle ohne Messungen sind mit „keine Daten“ markiert: der Regler hat nichts gesendet (Verbindung, Strom). Sie belegen keine Einhaltung und brauchen einen manuellen Eintrag.',
    no_limits_note: 'Für diese Anlage sind keine kritischen Grenzwerte festgelegt, Abweichungen wurden daher nicht bewertet. Legen Sie sie in der Anlagenkarte (HACCP-Felder) oder am Regler fest.',
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

// ── Local calendar helpers ─────────────────────────────────

function localParts(date, tz) {
  const d = new Date(date);
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: tz || 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
  } catch {
    const iso = d.toISOString();
    return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

/** Alarm names in the report language (shared with e-mail / Telegram templates). */
function alarmName(lang, code) {
  const names = require('./email').__strings.ALARM_NAMES;
  const dict = names[lang] || names.uk || {};
  return dict[code] || dict[`protection.${code}`] || code;
}

// ── Critical limits ────────────────────────────────────────

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The critical limits of one piece of equipment: the business's own (HACCP
 * plan), else the controller's alarm limits, else none.
 * @returns {{ min: number|null, max: number|null, source: 'org'|'controller'|null }}
 */
function limitsFor(device) {
  const orgMin = num(device.haccp_min), orgMax = num(device.haccp_max);
  if (orgMin !== null || orgMax !== null) return { min: orgMin, max: orgMax, source: 'org' };
  const st = device.last_state && typeof device.last_state === 'object' ? device.last_state : {};
  const cMin = num(st['protection.low_limit']), cMax = num(st['protection.high_limit']);
  if (cMin !== null || cMax !== null) return { min: cMin, max: cMax, source: 'controller' };
  return { min: null, max: null, source: null };
}

/** 'above' | 'below' | null for one value against the limits. */
function deviationOf(value, limits) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (limits.max !== null && value > limits.max) return 'above';
  if (limits.min !== null && value < limits.min) return 'below';
  return null;
}

function fmtLimits(S, limits) {
  if (limits.min === null && limits.max === null) return S.limits_none;
  if (limits.min === null) return `≤ ${limits.max} °C`;
  if (limits.max === null) return `≥ ${limits.min} °C`;
  return `${limits.min}…${limits.max} °C`;
}

// ── Events: alarms with what was done about them ───────────

async function fetchEvents({ query, tenantId, deviceId, deviceUuid, from, to }) {
  const { rows: alarms } = await query(
    `SELECT a.id, a.alarm_code, a.severity, a.value, a.limit_value, a.triggered_at, a.cleared_at, a.acknowledged_at, a.ack_note,
            u.email AS ack_by,
            w.id AS wo_id, w.title AS wo_title, w.status AS wo_status, w.closed_at AS wo_closed_at, w.closed_reason AS wo_closed_reason,
            sr.service_date AS sr_date, sr.technician AS sr_technician, sr.work_done AS sr_work_done
       FROM alarms a
       LEFT JOIN users u ON u.id = a.acknowledged_by
       LEFT JOIN LATERAL (
         SELECT id, title, status, closed_at, closed_reason, service_record_id
           FROM work_orders WHERE alarm_id = a.id ORDER BY created_at DESC LIMIT 1) w ON true
       LEFT JOIN service_records sr ON sr.id = w.service_record_id
      WHERE a.tenant_id = $1 AND a.device_id = $2 AND a.triggered_at >= $3 AND a.triggered_at < $4
      ORDER BY a.triggered_at ASC LIMIT 200`,
    [tenantId, deviceId, from, to]
  );
  let services = [];
  if (deviceUuid) {
    ({ rows: services } = await query(
      `SELECT id, service_date, technician, reason, work_done, work_order_id
         FROM service_records WHERE device_id = $1 AND service_date >= $2::date AND service_date <= $3::date
        ORDER BY service_date ASC LIMIT 50`,
      [deviceUuid, from, to]));
  }
  return { alarms, services };
}

async function fetchLastService({ query, deviceUuid }) {
  if (!deviceUuid) return null;
  const { rows } = await query(
    `SELECT service_date, technician, work_done FROM service_records WHERE device_id = $1 ORDER BY service_date DESC LIMIT 1`,
    [deviceUuid]
  );
  return rows[0] || null;
}

// ── The journal grid ───────────────────────────────────────

/**
 * Every interval of the period, with or without data: the temperature of the
 * primary channel (air), its min/max, the other channels, the deviation flag
 * against the limits and what happened inside the interval.
 */
function buildJournal({ buckets, channels, from, to, bucketSec, limits, alarms, tz, S, lang }) {
  const primary = channels.includes('air') ? 'air' : channels[0];
  const others = channels.filter(c => c !== primary);
  const byTime = new Map(buckets.map(b => [b.time, b]));
  const stepMs = bucketSec * 1000;
  const start = Math.floor(from.getTime() / stepMs) * stepMs;
  const end = to.getTime();
  const hasLimits = limits.min !== null || limits.max !== null;

  const offline = alarms.filter(a => a.alarm_code === 'device_offline')
    .map(a => [new Date(a.triggered_at).getTime(), a.cleared_at ? new Date(a.cleared_at).getTime() : Infinity]);
  const overlapsOffline = (t0, t1) => offline.some(([a, b]) => a < t1 && b > t0);

  const days = new Map();
  const stats = { slots: 0, deviations: 0, gaps: 0, longestRun: 0, worst: null, peaks: 0 };
  let run = 0;

  for (let t = start; t < end; t += stepMs) {
    const iso = new Date(t).toISOString();
    const b = byTime.get(iso);
    const { day, time } = localParts(t, tz);
    const row = { time: iso, clock: time, gap: !b, values: {}, deviation: null, peak: false, offline: false, actions: [] };
    if (b) {
      for (const ch of channels) if (b[ch]) row.values[ch] = b[ch];
      const v = b[primary];
      if (v && hasLimits) {
        row.deviation = deviationOf(v.avg, limits);
        row.peak = !row.deviation && (deviationOf(v.max, limits) !== null || deviationOf(v.min, limits) !== null);
      }
    } else {
      row.offline = overlapsOffline(t, t + stepMs);
    }
    // Events inside the interval: an alarm raised, acknowledged or cleared here
    for (const a of alarms) {
      if (a.alarm_code === 'device_offline') continue;
      const tr = new Date(a.triggered_at).getTime();
      if (tr >= t && tr < t + stepMs) {
        let text = alarmName(lang, a.alarm_code);
        if (a.value !== null && a.value !== undefined) text += ` ${Number(a.value)}`;
        if (a.acknowledged_at) {
          text += ` · ${S.ack} ${localParts(a.acknowledged_at, tz).time}${a.ack_by ? ' ' + a.ack_by : ''}`;
          if (a.ack_note) text += ` «${a.ack_note}»`;
        }
        if (a.wo_id) text += ` · ${S.work_order} #${a.wo_id}${a.wo_status ? ' (' + (S.wo[a.wo_status] || a.wo_status) + ')' : ''}`;
        row.actions.push(text);
      }
    }
    stats.slots++;
    if (row.gap) { stats.gaps++; run = 0; }
    else if (row.deviation) {
      stats.deviations++; run++; stats.longestRun = Math.max(stats.longestRun, run);
      const v = b[primary].avg;
      if (stats.worst === null || (row.deviation === 'above' ? v > stats.worst : v < stats.worst)) stats.worst = v;
    } else { run = 0; if (row.peak) stats.peaks++; }
    if (!days.has(day)) days.set(day, { day, rows: [], deviations: 0, gaps: 0 });
    const d = days.get(day);
    d.rows.push(row);
    if (row.gap) d.gaps++; else if (row.deviation) d.deviations++;
  }
  return { primary, others, days: [...days.values()], stats, bucketSec, hasLimits };
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
  const { alarms, services } = await fetchEvents({ query, tenantId, deviceId: device.mqtt_device_id, deviceUuid: device.id, from, to });
  const lastService = await fetchLastService({ query, deviceUuid: device.id });
  const limits = limitsFor(device);
  return { device, rows, buckets, summary, alarms, services, lastService, limits };
}

/** Deterministic JSON of the data the PDF shows — what the SHA-256 covers. */
function canonicalData({ kind, tenant, site, devices, from, to, bucketKey, source, generatedAt }) {
  return JSON.stringify({
    kind, tenant: tenant.slug, site: site ? site.id : null,
    period: [from.toISOString(), to.toISOString()], bucket: bucketKey, source, generatedAt,
    devices: devices.map(d => ({
      id: d.device.mqtt_device_id,
      limits: d.limits ? [d.limits.min, d.limits.max, d.limits.source] : null,
      rows: d.rows.map(r => [new Date(r.bucket).toISOString(), r.channel, Number(r.min), Number(r.max), Number(Number(r.avg).toFixed(4)), r.samples]),
      alarms: d.alarms.map(a => [new Date(a.triggered_at).toISOString(), a.alarm_code, a.severity, a.cleared_at ? new Date(a.cleared_at).toISOString() : null]),
    })),
  });
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function newCode() { return generateClaimCode(12); }
function fmtCode(code) { return code.replace(/(.{4})(?=.)/g, '$1-'); }

function chLabel(S, ch) { return S.ch[ch] || ch; }
const fmt1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (Math.round(v * 10) / 10).toFixed(1));
const hoursOf = (slots, bucketSec) => Math.round(slots * bucketSec / 360) / 10;

const RED = '#b91c1c', RED_BG = '#fde8e8', GREY = '#6b7280', GREY_BG = '#f3f4f6', DAY_BG = '#e5e7eb';

// ── Document sections ──────────────────────────────────────

function deviceSection({ S, lang, tz, d, bucketKey, bucketSec, channels, from, to, single }) {
  const dev = d.device;
  const limits = d.limits;
  const journal = buildJournal({ buckets: d.buckets, channels: channels.filter(c => d.summary[c]), from, to, bucketSec, limits, alarms: d.alarms, tz, S, lang });
  const { primary, others, stats } = journal;

  const limitsText = `${fmtLimits(S, limits)}${limits.source ? ' (' + (limits.source === 'org' ? S.limits_org : S.limits_controller) + ')' : ''}`;
  const head = [
    { text: single ? S.device : `${S.device}: ${dev.name || dev.mqtt_device_id}`, style: 'sectionHeader' },
    {
      table: {
        widths: ['auto', '*', 'auto', '*'],
        body: [
          [{ text: `${S.device}:`, bold: true }, `${dev.name || dev.mqtt_device_id}`, { text: `${S.device_id}:`, bold: true }, `${dev.mqtt_device_id}`],
          [{ text: `${S.serial}:`, bold: true }, `${dev.serial_number || '—'}`, { text: `${S.model}:`, bold: true }, `${dev.model || '—'}`],
          [{ text: `${S.product}:`, bold: true }, `${dev.haccp_product || '—'}`, { text: `${S.limits}:`, bold: true }, { text: limitsText, bold: limits.source === 'org', color: limits.source ? undefined : RED }],
          [{ text: `${S.frequency}:`, bold: true }, `${S.every} ${bucketKey}`, { text: `${S.samples}:`, bold: true }, `${Object.values(d.summary).reduce((a, x) => Math.max(a, x.samples), 0)}`],
        ],
      },
      layout: 'noBorders', fontSize: 8.5, margin: [0, 0, 0, 8],
    },
  ];

  const summaryTable = {
    table: {
      headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [
        [S.channel, S.min, S.max, S.avg, S.samples].map(t => ({ text: t, bold: true })),
        ...Object.entries(d.summary).map(([ch, sm]) => [chLabel(S, ch), sm.min, sm.max, sm.avg, String(sm.samples)]),
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 5, 0, 6],
  };
  const devLine = journal.hasLimits
    ? (stats.deviations
        ? `${S.deviations}: ${stats.deviations} ${S.intervals} (${hoursOf(stats.deviations, bucketSec)} ${S.h}), ${S.longest} ${hoursOf(stats.longestRun, bucketSec)} ${S.h}, ${S.worst} ${fmt1(stats.worst)} °C`
        : `${S.deviations}: ${S.none_recorded}`)
    : `${S.deviations}: ${S.nd}`;
  const gapLine = `${S.gaps}: ${stats.gaps ? `${stats.gaps} ${S.intervals} (${hoursOf(stats.gaps, bucketSec)} ${S.h})` : S.none_recorded}`;
  const statsBlock = {
    columns: [
      { text: devLine, bold: stats.deviations > 0, color: stats.deviations ? RED : undefined },
      { text: gapLine, alignment: 'right', color: stats.gaps ? GREY : undefined },
    ],
    fontSize: 9, margin: [0, 0, 0, 10],
  };

  // ── the journal ──
  const cols = [S.col_time, `${chLabel(S, primary)} ${S.col_temp}`, S.col_min, S.col_max, ...others.map(ch => `${chLabel(S, ch)} °C`), S.col_deviation, S.col_actions];
  const nCols = cols.length;
  const widths = ['auto', 'auto', 'auto', 'auto', ...others.map(() => 'auto'), 'auto', '*'];
  const body = [cols.map(t => ({ text: t, bold: true, fontSize: 8 }))];
  const span = (text, opts = {}) => [{ text, colSpan: nCols, ...opts }, ...Array(nCols - 1).fill({})];

  for (const day of journal.days) {
    const dayNote = [day.deviations ? `${S.deviations}: ${day.deviations}` : '', day.gaps ? `${S.gaps}: ${day.gaps}` : ''].filter(Boolean).join(' · ');
    body.push(span(`${localFmt(day.day + 'T12:00:00Z', 'UTC', false)}${dayNote ? '   ' + dayNote : ''}`, { bold: true, fillColor: DAY_BG, fontSize: 8.5 }));
    for (const r of day.rows) {
      if (r.gap) {
        // colSpan placeholders must stay bare `{}` for pdfmake
        body.push([
          { text: r.clock, color: GREY, fillColor: GREY_BG },
          { text: r.offline ? S.gap_offline : S.gap, colSpan: nCols - 2, italics: true, color: GREY, fillColor: GREY_BG },
          ...Array(nCols - 3).fill({}),
          { text: r.actions.join('; ') || '', color: GREY, fillColor: GREY_BG },
        ]);
        continue;
      }
      const v = r.values[primary];
      const isDev = !!r.deviation;
      const devText = !journal.hasLimits ? S.nd
        : isDev ? `${S.yes} (${r.deviation === 'above' ? '>' : '<'} ${r.deviation === 'above' ? limits.max : limits.min} °C)`
        : r.peak ? `${S.no} (${S.peak})` : S.no;
      const cell = (text, extra = {}) => ({ text, ...(isDev ? { fillColor: RED_BG } : {}), ...extra });
      body.push([
        cell(r.clock),
        cell(v ? fmt1(v.avg) : '—', isDev ? { bold: true, color: RED } : {}),
        cell(v ? fmt1(v.min) : '—', { color: GREY }),
        cell(v ? fmt1(v.max) : '—', { color: GREY }),
        ...others.map(ch => cell(r.values[ch] ? fmt1(r.values[ch].avg) : '—', { color: GREY })),
        cell(devText, isDev ? { bold: true, color: RED } : (r.peak ? { color: GREY } : {})),
        cell(r.actions.join('; ')),
      ]);
    }
    body.push(span(`${S.day_sign} ______________________________ / ______________`, { fontSize: 8, margin: [0, 4, 0, 4] }));
  }
  const logTable = {
    table: { headerRows: 1, widths, body, dontBreakRows: true },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3),
      vLineWidth: () => 0,
      hLineColor: () => '#9ca3af',
      paddingTop: () => 2, paddingBottom: () => 2,
    },
    fontSize: 7.5, margin: [0, 5, 0, 10],
  };

  // ── events and corrective actions ──
  const eventRows = d.alarms.map(a => [
    localFmt(a.triggered_at, tz),
    { text: [alarmName(lang, a.alarm_code), a.severity ? { text: ` · ${S.sev[a.severity] || a.severity}`, color: GREY } : ''] },
    a.value !== null && a.value !== undefined ? `${Number(a.value)}${a.limit_value !== null && a.limit_value !== undefined ? ` (${S.limit} ${Number(a.limit_value)})` : ''}` : '—',
    a.cleared_at ? localFmt(a.cleared_at, tz) : { text: S.active, color: RED },
    a.acknowledged_at ? `${localFmt(a.acknowledged_at, tz)} ${a.ack_by || ''}${a.ack_note ? `\n${S.note}: «${a.ack_note}»` : ''}`.trim() : '—',
    a.wo_id
      ? `${S.work_order} #${a.wo_id}: ${a.wo_title || ''} (${S.wo[a.wo_status] || a.wo_status || ''})${a.wo_closed_reason ? ' — ' + a.wo_closed_reason : ''}${a.sr_work_done ? `\n${S.service} ${localFmt(a.sr_date, tz, false)}: ${a.sr_work_done}` : ''}`
      : '—',
  ]);
  const linked = new Set(d.alarms.map(a => a.wo_id).filter(Boolean));
  for (const sr of d.services) {
    if (sr.work_order_id && linked.has(sr.work_order_id)) continue;
    eventRows.push([localFmt(sr.service_date, tz, false), { text: S.service, italics: true }, '—', '—', sr.technician || '—', `${sr.reason ? sr.reason + ': ' : ''}${sr.work_done || ''}`]);
  }
  const eventsBlock = eventRows.length
    ? {
        table: {
          headerRows: 1, widths: ['auto', '*', 'auto', 'auto', '*', '*'],
          body: [[S.time, S.event, S.value, S.cleared, S.ack, `${S.work_order} / ${S.service}`].map(t => ({ text: t, bold: true })), ...eventRows],
        },
        layout: 'lightHorizontalLines', fontSize: 7.5, margin: [0, 5, 0, 10],
      }
    : { text: S.no_corrective, italics: true, margin: [0, 5, 0, 10] };

  const service = d.lastService
    ? `${localFmt(d.lastService.service_date, tz, false)} — ${d.lastService.technician}: ${d.lastService.work_done}`
    : S.no_service;
  const notes = [
    `${S.sensors_note} ${service}`,
    journal.hasLimits ? S.deviation_note : S.no_limits_note,
    ...(stats.gaps ? [S.gaps_note] : []),
  ];
  return [
    ...head,
    { text: S.summary, style: 'subHeader' }, summaryTable, statsBlock,
    { text: `${S.journal} (${S.every} ${bucketKey})`, style: 'subHeader' }, logTable,
    { text: S.corrective, style: 'subHeader' }, eventsBlock,
    { ul: notes, fontSize: 7.5, color: '#555555', margin: [0, 0, 0, 14] },
  ];
}

/**
 * @returns {{ docDefinition: object }}
 */
function buildDocument({ kind, lang, tz, tenant, site, devices, channels, from, to, bucketKey, bucketSec, source, generatedBy, generatedAt, code, hash, verifyUrl }) {
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
          ...(tenant.brand_name ? [{ text: `${S.serviced_by}: `, bold: true }, `${tenant.brand_name}${tenant.brand_url ? ' · ' + tenant.brand_url : ''}\n`] : []),
          ...(site ? [{ text: `${S.site}: `, bold: true }, `${site.name}\n`, { text: `${S.address}: `, bold: true }, `${address || '—'}\n`] : []),
          { text: `${S.timezone}: `, bold: true }, tz,
        ],
      },
      {
        width: 'auto', alignment: 'right',
        text: [
          { text: `${S.period}: `, bold: true }, `${localFmt(from, tz)} — ${localFmt(to, tz)}\n`,
          { text: `${S.frequency}: `, bold: true }, `${S.every} ${bucketKey}\n`,
          { text: `${S.source}: `, bold: true }, `${source === 'hourly' ? S.source_hourly : S.source_raw}\n`,
          { text: `${S.generated}: `, bold: true }, `${localFmt(generatedAt, tz)} ${S.by} ${generatedBy}`,
        ],
      },
    ],
    margin: [0, 0, 0, 14],
  };

  const signTable = (label) => ({
    table: {
      widths: ['*', '*', '*', 'auto'],
      body: [
        [S.full_name, S.position, S.signature, S.date].map(t => ({ text: t, bold: true, fontSize: 8 })),
        [{ text: ' ', margin: [0, 14] }, ' ', ' ', '____.____.______'],
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 6, 0, 10],
  });

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
      pageSize: 'A4', pageMargins: [36, 46, 36, 64],
      header: { text: `${orgName} — ${title}`, alignment: 'center', margin: [0, 16, 0, 0], fontSize: 8, bold: true, color: '#555555' },
      footer: (currentPage, pageCount) => ({
        columns: [
          { text: `${tenant.brand_name ? tenant.brand_name + ' · ' : ''}${fmtCode(code)} · SHA-256 ${hash.slice(0, 16)}…`, fontSize: 7, color: '#777777' },
          { text: `${S.page} ${currentPage} ${S.of} ${pageCount}`, alignment: 'right', fontSize: 7, color: '#777777' },
        ],
        margin: [36, 18, 36, 0],
      }),
      content: [
        { text: title, style: 'title' },
        meta,
        ...devices.flatMap(d => deviceSection({ S, lang, tz, d, bucketKey, bucketSec, channels, from, to, single: kind === 'device' })),
        { text: S.responsible, style: 'sectionHeader' },
        signTable(S.responsible),
        { text: S.verified_by, style: 'sectionHeader' },
        signTable(S.verified_by),
        verifyBlock,
      ],
      styles: {
        title: { fontSize: 15, bold: true, margin: [0, 0, 0, 10] },
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

async function registerExport({ query, code, kind, tenantId, deviceId, siteId, from, to, bucketKey, source, lang, hash, generatedBy, reportType = 'haccp', scheduleId = null }) {
  await query(
    `INSERT INTO report_exports (code, kind, tenant_id, device_id, site_id, period_from, period_to, bucket, source, lang, sha256, generated_by, report_type, schedule_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [code, kind, tenantId, deviceId || null, siteId || null, from, to, bucketKey, source, lang, hash, generatedBy || null, reportType, scheduleId]
  );
}

/** Keep a scheduled PDF in its archive row (plan epic 2.7). */
async function archivePdf({ query, code, buffer, fileName }) {
  await query('UPDATE report_exports SET pdf = $2, bytes = $3, file_name = $4 WHERE code = $1', [code, buffer, buffer.length, fileName]);
}

function verifyUrlFor(code) {
  // Site root, not the app URL: EMAIL_APP_URL points at the SPA (…/cloud) since the landing page took "/"
  const base = (process.env.PUBLIC_BASE_URL || (process.env.EMAIL_APP_URL || process.env.CORS_ORIGIN || 'https://modesp.com.ua').replace(/\/cloud\/?$/, '')).replace(/\/+$/, '');
  return `${base}/api/public/report/${code}`;
}

/**
 * Generate a report. `devices` are device rows (id, mqtt_device_id, name, serial_number, model,
 * haccp_min, haccp_max, haccp_product, last_state).
 * @returns {Promise<{ buffer: Buffer, code: string, hash: string, source: string, bucketKey: string, empty: boolean }>}
 */
async function generate({ query, kind, tenant, site, devices, channels, from, to, bucketKey, lang, rawRetentionDays, generatedBy, scheduleId = null, now = new Date() }) {
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
    kind, lang, tz, tenant, site, devices: withData, channels, from, to, bucketKey: plan.bucketKey, bucketSec: plan.bucketSec, source: plan.source,
    generatedBy, generatedAt, code, hash, verifyUrl: verifyUrlFor(code),
  });
  const buffer = await render(docDefinition);
  await registerExport({
    query, code, kind, tenantId: tenant.id, deviceId: kind === 'device' ? devices[0].mqtt_device_id : null,
    siteId: site ? site.id : null, from, to, bucketKey: plan.bucketKey, source: plan.source, lang, hash, generatedBy, scheduleId,
  });
  return { buffer, code, hash, source: plan.source, bucketKey: plan.bucketKey, empty: false };
}

module.exports = {
  generate, strings, pickLang, planSource, fmtCode, localFmt, canonicalData, sha256,
  // shared with services/period-reports.js (plan epic 2.7)
  render, registerExport, archivePdf, verifyUrlFor, newCode,
  BUCKETS, RAW_MAX_DAYS, HOURLY_MAX_DAYS, HOURLY_RETENTION_DAYS,
  // scripts/check-locales.js
  STRINGS,
  __test: { limitsFor, deviationOf, buildJournal, fmtLimits, localParts, alarmName, collectDevice, buildDocument },
};
