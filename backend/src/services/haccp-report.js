'use strict';

/**
 * HACCP temperature-control log for inspectors (journal form 2026-09, part 2).
 *
 * One document for one device or for every device of a site, in the shape of
 * the regulatory "temperature control log of refrigeration equipment", written
 * for a store manager or a food-safety inspector: it must not raise a question
 * it does not answer itself. Only the air temperature in the product zone is
 * shown — evaporator, condenser and other engineering channels belong to the
 * service report, not here.
 *
 * Header: the business, the site, the equipment with what it stores and its
 * critical limit ("not above −18 °C, allowed deviation 3 °C"), the excursion
 * rule, the measurement method (interval average of the raw measurements;
 * summary min/max over all raw measurements), how long raw data is kept and
 * where the report can be verified.
 *
 * Three classes of events replace the old alarm list:
 *   product excursions — air past the limit (tolerance included) for longer
 *     than haccp_excursion_min (site → organisation → 30 min); defrost
 *     intervals are excluded and marked in the log; each excursion lists
 *     start, end, extreme value and the corrective action / responsible
 *     person from a work order when there is one, blank otherwise;
 *   recording gaps — stretches without raw measurements longer than one
 *     measurement interval (a lost connection that is later back-filled from
 *     the device buffer leaves no gap, because the rows are there);
 *   technical events (connectivity, probes, relays, compressor) — not in
 *     this report at all.
 *
 * Verification: a code and the SHA-256 of the report data in the footer, a QR
 * code with the verification URL next to them.
 *
 * Critical limits: devices.haccp_min/haccp_max (+ haccp_tolerance), else the
 * device's own protection.low_limit/high_limit, else "not set" — said out
 * loud rather than left blank.
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
    period: 'Період', frequency: 'Періодичність фіксації', every: 'кожні', generated: 'Сформовано', by: 'ким',
    source: 'Джерело даних', source_raw: 'первинні вимірювання приладу', source_hourly: 'погодинний архів первинних вимірювань',
    method_title: 'Метод', method_raw: 'У таблиці — середнє за інтервал по первинних вимірюваннях (кожні {0}). Мін/макс у підсумку — по всіх первинних вимірюваннях за період.',
    method_hourly: 'Період старший за термін зберігання первинних вимірювань: у таблиці — середнє за інтервал з погодинного архіву (мін/макс/середнє за кожну годину), мін/макс у підсумку — по всіх годинах періоду.',
    retention_title: 'Зберігання даних', retention_text: 'Первинні вимірювання зберігаються на платформі {0} днів, погодинний архів — 3 роки. Цей звіт доступний за кодом перевірки: {1}',
    device: 'Обладнання', device_id: 'Ідентифікатор', serial: 'Серійний номер', model: 'Модель', product: 'Продукція / призначення',
    limit: 'Критична межа', limit_max: 'не вище {0} °C', limit_min: 'не нижче {0} °C', limit_range: 'від {0} до {1} °C', tolerance: 'допустиме відхилення {0} °C',
    limit_none: 'не задано', limit_none_hint: 'оператор має задати межі в картці обладнання', limits_org: 'за програмою HACCP підприємства', limits_controller: 'за налаштуваннями приладу',
    excursion_rule: 'Відхиленням вважається температура повітря за межею довше ніж {0} хв; інтервали відтайки не враховуються.',
    summary: 'Підсумок: температура повітря в зоні продукту', min: 'Мін °C', max: 'Макс °C', avg: 'Сер. °C', samples: 'Вимірювань',
    stats: 'Відхилень продукту: {0} · Розривів запису: {1}',
    journal: 'Журнал контролю', col_time: 'Час', col_air: 'Повітря °C', col_limit: 'Межа', col_deviation: 'Відхилення', col_note: 'Примітка',
    yes: 'Так', no: 'Ні', nd: 'н/д', note_defrost: 'відтайка', note_door: 'двері > {0} хв', note_gap: 'розрив', day_deviations: 'відхилень: {0}',
    excursions_title: 'Відхилення продукту', excursions_none: 'Відхилень за період не зафіксовано.',
    col_start: 'Початок', col_end: 'Кінець', col_duration: 'Тривалість', col_peak: 'Крайнє значення', col_action: 'Коригувальна дія', col_responsible: 'Відповідальний',
    gaps_title: 'Розриви запису', gaps_none: 'Розривів запису за період не зафіксовано.', gap_row: 'дані відсутні з {0} по {1}', col_from: 'З', col_to: 'По',
    min_short: 'хв', h_short: 'год', d_short: 'дн',
    wo: { new: 'новий', assigned: 'призначено', in_progress: 'у роботі', done: 'виконано', cancelled: 'скасовано' },
    responsible: 'Відповідальна особа', verified_by: 'Перевірив (відповідальний за HACCP)', full_name: 'ПІБ', position: 'Посада', signature: 'Підпис', date: 'Дата',
    sensors_note: 'Примітка про повірку: температура вимірюється датчиком приладу ModESP; періодичність повірки/калібрування визначає підприємство згідно з власною програмою HACCP. Остання сервісна відмітка щодо обладнання:',
    no_service: 'записів обслуговування за період зберігання немає',
    verify: 'Перевірка автентичності', verify_text: 'Код перевірки та SHA-256 даних звіту зберігаються платформою. Перевірити:',
    page: 'Сторінка', of: 'з', no_data: 'Дані за період відсутні',
  },
  en: {
    title: 'Refrigeration Equipment Temperature Control Log (HACCP)', site_title: 'Refrigeration Equipment Temperature Control Log (HACCP) — site',
    organisation: 'Business', tax_id: 'Tax ID', serviced_by: 'Serviced by', site: 'Site (unit)', address: 'Address', timezone: 'Time zone',
    period: 'Period', frequency: 'Recording frequency', every: 'every', generated: 'Generated', by: 'by',
    source: 'Data source', source_raw: 'raw measurements of the device', source_hourly: 'hourly archive of raw measurements',
    method_title: 'Method', method_raw: 'The table shows the interval average of the raw measurements (every {0}). Min/max in the summary are over all raw measurements of the period.',
    method_hourly: 'The period is older than the raw-measurement retention: the table shows the interval average from the hourly archive (min/max/avg per hour); min/max in the summary are over all hours of the period.',
    retention_title: 'Data retention', retention_text: 'Raw measurements are kept on the platform for {0} days, the hourly archive for 3 years. This report is available by its verification code: {1}',
    device: 'Equipment', device_id: 'Identifier', serial: 'Serial number', model: 'Model', product: 'Product / purpose',
    limit: 'Critical limit', limit_max: 'not above {0} °C', limit_min: 'not below {0} °C', limit_range: 'from {0} to {1} °C', tolerance: 'allowed deviation {0} °C',
    limit_none: 'not set', limit_none_hint: 'the operator must set the limits on the equipment card', limits_org: "per the business's HACCP plan", limits_controller: "per the device's settings",
    excursion_rule: 'An excursion is the air temperature past the limit for longer than {0} min; defrost intervals are not counted.',
    summary: 'Summary: air temperature in the product zone', min: 'Min °C', max: 'Max °C', avg: 'Avg °C', samples: 'Samples',
    stats: 'Product excursions: {0} · Recording gaps: {1}',
    journal: 'Control log', col_time: 'Time', col_air: 'Air °C', col_limit: 'Limit', col_deviation: 'Excursion', col_note: 'Note',
    yes: 'Yes', no: 'No', nd: 'n/a', note_defrost: 'defrost', note_door: 'door > {0} min', note_gap: 'gap', day_deviations: 'excursions: {0}',
    excursions_title: 'Product excursions', excursions_none: 'No excursions recorded during the period.',
    col_start: 'Start', col_end: 'End', col_duration: 'Duration', col_peak: 'Extreme value', col_action: 'Corrective action', col_responsible: 'Responsible',
    gaps_title: 'Recording gaps', gaps_none: 'No recording gaps during the period.', gap_row: 'no data from {0} to {1}', col_from: 'From', col_to: 'To',
    min_short: 'min', h_short: 'h', d_short: 'd',
    wo: { new: 'new', assigned: 'assigned', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' },
    responsible: 'Responsible person', verified_by: 'Verified by (HACCP team leader)', full_name: 'Full name', position: 'Position', signature: 'Signature', date: 'Date',
    sensors_note: 'Calibration note: the temperature is measured by the ModESP device sensor; the verification/calibration interval is set by the business in its HACCP plan. Last service record for this equipment:',
    no_service: 'no service records within the retention period',
    verify: 'Authenticity check', verify_text: 'The verification code and the SHA-256 of the report data are stored by the platform. Verify at:',
    page: 'Page', of: 'of', no_data: 'No data for the period',
  },
  pl: {
    title: 'Dziennik kontroli temperatury urządzeń chłodniczych (HACCP)', site_title: 'Dziennik kontroli temperatury urządzeń chłodniczych lokalizacji (HACCP)',
    organisation: 'Przedsiębiorstwo', tax_id: 'NIP', serviced_by: 'Obsługuje', site: 'Lokalizacja (dział)', address: 'Adres', timezone: 'Strefa czasowa',
    period: 'Okres', frequency: 'Częstotliwość zapisu', every: 'co', generated: 'Wygenerowano', by: 'przez',
    source: 'Źródło danych', source_raw: 'pomiary surowe urządzenia', source_hourly: 'archiwum godzinowe pomiarów surowych',
    method_title: 'Metoda', method_raw: 'W tabeli — średnia z interwału z pomiarów surowych (co {0}). Min/maks w podsumowaniu — ze wszystkich pomiarów surowych w okresie.',
    method_hourly: 'Okres jest starszy niż czas przechowywania pomiarów surowych: w tabeli — średnia z interwału z archiwum godzinowego (min/maks/średnia na godzinę), min/maks w podsumowaniu — ze wszystkich godzin okresu.',
    retention_title: 'Przechowywanie danych', retention_text: 'Pomiary surowe są przechowywane na platformie przez {0} dni, archiwum godzinowe — 3 lata. Ten raport jest dostępny po kodzie weryfikacyjnym: {1}',
    device: 'Urządzenie', device_id: 'Identyfikator', serial: 'Numer seryjny', model: 'Model', product: 'Produkt / przeznaczenie',
    limit: 'Limit krytyczny', limit_max: 'nie wyżej niż {0} °C', limit_min: 'nie niżej niż {0} °C', limit_range: 'od {0} do {1} °C', tolerance: 'dopuszczalne odchylenie {0} °C',
    limit_none: 'nie ustawiono', limit_none_hint: 'operator musi ustawić limity w karcie urządzenia', limits_org: 'wg planu HACCP przedsiębiorstwa', limits_controller: 'wg ustawień urządzenia',
    excursion_rule: 'Odchyleniem jest temperatura powietrza poza limitem dłużej niż {0} min; interwały odszraniania nie są liczone.',
    summary: 'Podsumowanie: temperatura powietrza w strefie produktu', min: 'Min °C', max: 'Maks °C', avg: 'Śr. °C', samples: 'Pomiary',
    stats: 'Odchylenia produktu: {0} · Przerwy w zapisie: {1}',
    journal: 'Dziennik kontroli', col_time: 'Czas', col_air: 'Powietrze °C', col_limit: 'Limit', col_deviation: 'Odchylenie', col_note: 'Uwaga',
    yes: 'Tak', no: 'Nie', nd: 'b/d', note_defrost: 'odszranianie', note_door: 'drzwi > {0} min', note_gap: 'przerwa', day_deviations: 'odchyleń: {0}',
    excursions_title: 'Odchylenia produktu', excursions_none: 'W okresie nie odnotowano odchyleń.',
    col_start: 'Początek', col_end: 'Koniec', col_duration: 'Czas trwania', col_peak: 'Wartość skrajna', col_action: 'Działanie korygujące', col_responsible: 'Odpowiedzialny',
    gaps_title: 'Przerwy w zapisie', gaps_none: 'W okresie nie odnotowano przerw w zapisie.', gap_row: 'brak danych od {0} do {1}', col_from: 'Od', col_to: 'Do',
    min_short: 'min', h_short: 'h', d_short: 'dn',
    wo: { new: 'nowe', assigned: 'przydzielone', in_progress: 'w toku', done: 'wykonane', cancelled: 'anulowane' },
    responsible: 'Osoba odpowiedzialna', verified_by: 'Sprawdził (odpowiedzialny za HACCP)', full_name: 'Imię i nazwisko', position: 'Stanowisko', signature: 'Podpis', date: 'Data',
    sensors_note: 'Uwaga o wzorcowaniu: temperaturę mierzy czujnik urządzenia ModESP; częstotliwość sprawdzania/kalibracji ustala przedsiębiorstwo w swoim planie HACCP. Ostatni wpis serwisowy dla urządzenia:',
    no_service: 'brak wpisów serwisowych w okresie przechowywania',
    verify: 'Weryfikacja autentyczności', verify_text: 'Kod weryfikacyjny i SHA-256 danych raportu są przechowywane przez platformę. Sprawdź:',
    page: 'Strona', of: 'z', no_data: 'Brak danych za okres',
  },
  de: {
    title: 'Temperaturkontrollprotokoll für Kühlanlagen (HACCP)', site_title: 'Temperaturkontrollprotokoll für Kühlanlagen des Standorts (HACCP)',
    organisation: 'Betrieb', tax_id: 'Steuernummer', serviced_by: 'Betreut von', site: 'Standort (Bereich)', address: 'Adresse', timezone: 'Zeitzone',
    period: 'Zeitraum', frequency: 'Aufzeichnungsintervall', every: 'alle', generated: 'Erstellt', by: 'von',
    source: 'Datenquelle', source_raw: 'Rohmessungen des Geräts', source_hourly: 'Stundenarchiv der Rohmessungen',
    method_title: 'Methode', method_raw: 'Die Tabelle zeigt den Intervallmittelwert der Rohmessungen (alle {0}). Min/Max in der Zusammenfassung gelten über alle Rohmessungen des Zeitraums.',
    method_hourly: 'Der Zeitraum liegt außerhalb der Aufbewahrung der Rohmessungen: die Tabelle zeigt den Intervallmittelwert aus dem Stundenarchiv (Min/Max/Mittel je Stunde), Min/Max in der Zusammenfassung gelten über alle Stunden des Zeitraums.',
    retention_title: 'Datenaufbewahrung', retention_text: 'Rohmessungen werden auf der Plattform {0} Tage aufbewahrt, das Stundenarchiv 3 Jahre. Dieser Bericht ist über seinen Prüfcode abrufbar: {1}',
    device: 'Anlage', device_id: 'Kennung', serial: 'Seriennummer', model: 'Modell', product: 'Produkt / Zweck',
    limit: 'Kritischer Grenzwert', limit_max: 'nicht über {0} °C', limit_min: 'nicht unter {0} °C', limit_range: 'von {0} bis {1} °C', tolerance: 'zulässige Abweichung {0} °C',
    limit_none: 'nicht festgelegt', limit_none_hint: 'der Betreiber muss die Grenzwerte in der Anlagenkarte festlegen', limits_org: 'laut HACCP-Konzept des Betriebs', limits_controller: 'laut Geräteeinstellungen',
    excursion_rule: 'Eine Abweichung liegt vor, wenn die Lufttemperatur länger als {0} Min. außerhalb des Grenzwerts liegt; Abtauintervalle zählen nicht.',
    summary: 'Zusammenfassung: Lufttemperatur im Produktbereich', min: 'Min °C', max: 'Max °C', avg: 'Mittel °C', samples: 'Messungen',
    stats: 'Produktabweichungen: {0} · Aufzeichnungslücken: {1}',
    journal: 'Kontrollprotokoll', col_time: 'Zeit', col_air: 'Luft °C', col_limit: 'Grenze', col_deviation: 'Abweichung', col_note: 'Bemerkung',
    yes: 'Ja', no: 'Nein', nd: 'k. A.', note_defrost: 'Abtauung', note_door: 'Tür > {0} Min.', note_gap: 'Lücke', day_deviations: 'Abweichungen: {0}',
    excursions_title: 'Produktabweichungen', excursions_none: 'Im Zeitraum wurden keine Abweichungen festgestellt.',
    col_start: 'Beginn', col_end: 'Ende', col_duration: 'Dauer', col_peak: 'Extremwert', col_action: 'Korrekturmaßnahme', col_responsible: 'Verantwortlich',
    gaps_title: 'Aufzeichnungslücken', gaps_none: 'Im Zeitraum wurden keine Aufzeichnungslücken festgestellt.', gap_row: 'keine Daten von {0} bis {1}', col_from: 'Von', col_to: 'Bis',
    min_short: 'Min.', h_short: 'Std.', d_short: 'Tg.',
    wo: { new: 'neu', assigned: 'zugewiesen', in_progress: 'in Arbeit', done: 'erledigt', cancelled: 'storniert' },
    responsible: 'Verantwortliche Person', verified_by: 'Geprüft von (HACCP-Verantwortlicher)', full_name: 'Name', position: 'Position', signature: 'Unterschrift', date: 'Datum',
    sensors_note: 'Hinweis zur Kalibrierung: Die Temperatur wird vom Sensor des ModESP-Geräts gemessen; das Prüf-/Kalibrierintervall legt der Betrieb in seinem HACCP-Konzept fest. Letzter Serviceeintrag für diese Anlage:',
    no_service: 'keine Serviceeinträge im Aufbewahrungszeitraum',
    verify: 'Echtheitsprüfung', verify_text: 'Prüfcode und SHA-256 der Berichtsdaten werden von der Plattform gespeichert. Prüfen unter:',
    page: 'Seite', of: 'von', no_data: 'Keine Daten für den Zeitraum',
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

function tpl(str, ...args) { return String(str).replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined ? '' : String(args[i]))); }

const HACCP_CHANNEL = 'air';
const DEFAULT_EXCURSION_MIN = 30;
const DEFAULT_DOOR_DELAY_MS = 600000;
const RAW_LIMIT = 200000;

const fmt1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (Math.round(v * 10) / 10).toFixed(1));

function fmtDuration(minutes, S) {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 1440) { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return `${d} ${S.d_short}${h ? ' ' + h + ' ' + S.h_short : ''}`; }
  if (m >= 60) { const h = Math.floor(m / 60), r = m % 60; return `${h} ${S.h_short}${r ? ' ' + r + ' ' + S.min_short : ''}`; }
  return `${m} ${S.min_short}`;
}

function fmtStep(sec, S) {
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} ${S.min_short}`;
  return `${sec} s`;
}

// ── Critical limit wording ─────────────────────────────────

function toleranceOf(device) { const t = num(device.haccp_tolerance); return t === null || t < 0 ? 0 : t; }

/** "not above −18 °C, allowed deviation 3 °C" — the sentence in the header. */
function limitSentence(S, limits, tolerance) {
  if (limits.min === null && limits.max === null) return `${S.limit_none} (${S.limit_none_hint})`;
  let text;
  if (limits.min !== null && limits.max !== null) text = tpl(S.limit_range, limits.min, limits.max);
  else if (limits.max !== null) text = tpl(S.limit_max, limits.max);
  else text = tpl(S.limit_min, limits.min);
  if (tolerance > 0) text += `, ${tpl(S.tolerance, tolerance)}`;
  text += ` (${limits.source === 'org' ? S.limits_org : S.limits_controller})`;
  return text;
}

/** The short form for the log column: "≤ −18 (+3)". */
function limitShort(limits, tolerance) {
  if (limits.min === null && limits.max === null) return '—';
  const tol = tolerance > 0 ? ` (±${tolerance})` : '';
  if (limits.min !== null && limits.max !== null) return `${limits.min}…${limits.max}${tol}`;
  if (limits.max !== null) return `≤ ${limits.max}${tolerance > 0 ? ` (+${tolerance})` : ''}`;
  return `≥ ${limits.min}${tolerance > 0 ? ` (−${tolerance})` : ''}`;
}

// ── Raw measurements: the source of excursions and gaps ────

async function fetchRaw({ query, tenantId, deviceId, from, to, source }) {
  if (source === 'hourly') {
    const { rows } = await query(
      `SELECT hour, channel, min, max, avg, samples FROM telemetry_hourly
        WHERE tenant_id = $1 AND device_id = $2 AND hour >= $3 AND hour < $4 AND channel = ANY($5) ORDER BY hour ASC`,
      [tenantId, deviceId, from, to, [HACCP_CHANNEL, 'defrost']]);
    const air = [], defrost = [];
    for (const r of rows) {
      const t = new Date(r.hour).getTime();
      if (r.channel === HACCP_CHANNEL) air.push({ t, min: Number(r.min), max: Number(r.max), avg: Number(r.avg), samples: r.samples });
      else defrost.push({ t, v: Number(r.avg) });
    }
    return { air, defrost, hourly: true };
  }
  const { rows } = await query(
    `SELECT time, channel, value FROM telemetry
      WHERE tenant_id = $1 AND device_id = $2 AND time >= $3 AND time < $4 AND channel = ANY($5)
      ORDER BY time ASC LIMIT ${RAW_LIMIT}`,
    [tenantId, deviceId, from, to, [HACCP_CHANNEL, 'defrost']]);
  const air = [], defrost = [];
  for (const r of rows) {
    const t = new Date(r.time).getTime();
    if (r.channel === HACCP_CHANNEL) air.push({ t, v: Number(r.value) });
    else defrost.push({ t, v: Number(r.value) });
  }
  return { air, defrost, hourly: false };
}

/** The measurement interval, ms: the median distance between raw samples, else the plan's sampling step. */
function stepOf(points, fallbackSec) {
  const deltas = [];
  for (let i = 1; i < points.length; i++) { const d = points[i].t - points[i - 1].t; if (d > 0) deltas.push(d); }
  if (deltas.length === 0) return Math.max(1, fallbackSec || 60) * 1000;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

/** [start, end) intervals during which the device was defrosting. */
function defrostIntervals(points, stepMs, hourly) {
  const out = [];
  if (hourly) {
    for (const p of points) {
      if (!(p.v > 0)) continue;
      const a = p.t, b = p.t + 3600e3;
      if (out.length && out[out.length - 1][1] >= a) out[out.length - 1][1] = b; else out.push([a, b]);
    }
    return out;
  }
  let open = null;
  for (const p of points) {
    const on = p.v >= 0.5;
    if (on && open === null) open = p.t;
    else if (!on && open !== null) { out.push([open, p.t]); open = null; }
  }
  if (open !== null) out.push([open, (points[points.length - 1].t) + stepMs]);
  return out;
}

const overlaps = (a0, a1, intervals) => intervals.some(([b0, b1]) => b0 < a1 && b1 > a0);
const inside = (t, intervals) => intervals.some(([b0, b1]) => t >= b0 && t < b1);

/**
 * Product excursions: the air temperature past the limit (tolerance included)
 * for at least excursionMin minutes; samples taken during defrost do not count
 * and a data gap ends a run.
 */
function detectExcursions({ points, limits, tolerance, excursionMin, defrost, stepMs, hourly }) {
  const hi = limits.max === null ? null : limits.max + tolerance;
  const lo = limits.min === null ? null : limits.min - tolerance;
  if (hi === null && lo === null) return [];
  const out = [];
  let run = null, prev = null;
  const close = () => {
    if (!run) return;
    const minutes = (run.end - run.start) / 60000;
    if (minutes >= excursionMin) out.push({ start: run.start, end: run.end, minutes: Math.round(minutes), peak: run.peak, kind: run.kind });
    run = null;
  };
  for (const p of points) {
    const spanEnd = hourly ? p.t + 3600e3 : p.t + stepMs;
    const above = hourly ? p.max : p.v, below = hourly ? p.min : p.v;
    let kind = null;
    if (hi !== null && above > hi) kind = 'above';
    else if (lo !== null && below < lo) kind = 'below';
    if (kind && inside(p.t, defrost)) kind = null;
    if (run && prev && p.t - prev.t > 2 * stepMs) close();
    if (kind) {
      const val = kind === 'above' ? above : below;
      if (run && run.kind === kind) { run.end = spanEnd; run.peak = kind === 'above' ? Math.max(run.peak, val) : Math.min(run.peak, val); }
      else { close(); run = { start: p.t, end: spanEnd, kind, peak: val }; }
    } else {
      close();
    }
    prev = p;
  }
  close();
  return out;
}

/** Recording gaps: stretches without raw measurements longer than one measurement interval. */
function detectGaps({ points, from, to, stepMs, hourly }) {
  const out = [];
  const push = (a, b) => { if (b > a) out.push({ from: a, to: b, minutes: Math.round((b - a) / 60000) }); };
  if (hourly) {
    const H = 3600e3;
    const present = new Set(points.map(p => p.t));
    const start = Math.floor(from.getTime() / H) * H;
    let gapStart = null;
    for (let t = start; t < to.getTime(); t += H) {
      if (present.has(t)) { if (gapStart !== null) { push(Math.max(gapStart, from.getTime()), t); gapStart = null; } }
      else if (gapStart === null) gapStart = t;
    }
    if (gapStart !== null) push(Math.max(gapStart, from.getTime()), to.getTime());
    return out;
  }
  const threshold = 2 * stepMs;
  if (points.length === 0) { push(from.getTime(), to.getTime()); return out; }
  if (points[0].t - from.getTime() > threshold) push(from.getTime(), points[0].t);
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > threshold) push(points[i - 1].t + stepMs, points[i].t);
  }
  const last = points[points.length - 1].t;
  if (to.getTime() - last > threshold) push(last + stepMs, to.getTime());
  return out;
}

async function fetchDoorIntervals({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT triggered_at, cleared_at FROM alarms
      WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = 'door_alarm'
        AND triggered_at < $4 AND (cleared_at IS NULL OR cleared_at > $3)
      ORDER BY triggered_at LIMIT 500`,
    [tenantId, deviceId, from, to]);
  return rows.map(r => [new Date(r.triggered_at).getTime(), r.cleared_at ? new Date(r.cleared_at).getTime() : to.getTime()]);
}

/** Work orders of the device around the period: the corrective action and who did it. */
async function fetchWorkOrders({ query, deviceUuid, from, to }) {
  if (!deviceUuid) return [];
  const { rows } = await query(
    `SELECT w.id, w.title, w.status, w.closed_reason, w.created_at, w.closed_at, u.email AS assignee, sr.technician
       FROM work_orders w
       LEFT JOIN users u ON u.id = w.assigned_to
       LEFT JOIN service_records sr ON sr.id = w.service_record_id
      WHERE w.device_id = $1 AND w.created_at >= $2 AND w.created_at < $3
      ORDER BY w.created_at ASC LIMIT 200`,
    [deviceUuid, new Date(from.getTime() - 3600e3), new Date(to.getTime() + 86400e3)]);
  return rows.map(r => ({ ...r, created: new Date(r.created_at).getTime() }));
}

function actionFor(S, excursion, workOrders) {
  const wo = workOrders.find(w => w.created >= excursion.start - 3600e3 && w.created <= excursion.end + 86400e3);
  if (!wo) return { action: '', responsible: '' };
  const status = wo.status && wo.status !== 'done' ? ` (${S.wo[wo.status] || wo.status})` : '';
  return { action: `${wo.closed_reason || wo.title || ''}${status}`.trim(), responsible: wo.assignee || wo.technician || '' };
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
async function collectDevice({ query, device, tenantId, from, to, bucketSec, source, excursionMin, samplingSec }) {
  const rows = await fetchSeries({ query, tenantId, deviceId: device.mqtt_device_id, channels: [HACCP_CHANNEL], from, to, bucketSec, source });
  if (rows.length > MAX_ROWS) {
    const err = new Error('Too many data points for PDF. Use a larger bucket or shorter time range.');
    err.code = 'too_much_data';
    throw err;
  }
  const { buckets, summary } = summarize(rows);
  const raw = await fetchRaw({ query, tenantId, deviceId: device.mqtt_device_id, from, to, source });
  const stepMs = raw.hourly ? 3600e3 : stepOf(raw.air, samplingSec);
  const limits = limitsFor(device);
  const tolerance = toleranceOf(device);
  const defrost = defrostIntervals(raw.defrost, stepMs, raw.hourly);
  const excursions = detectExcursions({ points: raw.air, limits, tolerance, excursionMin, defrost, stepMs, hourly: raw.hourly });
  const gaps = rows.length ? detectGaps({ points: raw.air, from, to, stepMs, hourly: raw.hourly }) : [];
  const doors = await fetchDoorIntervals({ query, tenantId, deviceId: device.mqtt_device_id, from, to });
  const workOrders = excursions.length ? await fetchWorkOrders({ query, deviceUuid: device.id, from, to }) : [];
  const lastService = await fetchLastService({ query, deviceUuid: device.id });
  return { device, rows, buckets, summary: summary[HACCP_CHANNEL] || null, stepSec: Math.round(stepMs / 1000), hourly: raw.hourly,
           limits, tolerance, excursionMin, defrost, excursions, gaps, doors, workOrders, lastService };
}

/** Deterministic JSON of the data the PDF shows — what the SHA-256 covers. */
function canonicalData({ kind, tenant, site, devices, from, to, bucketKey, source, generatedAt }) {
  return JSON.stringify({
    kind, tenant: tenant.slug, site: site ? site.id : null,
    period: [from.toISOString(), to.toISOString()], bucket: bucketKey, source, generatedAt,
    devices: devices.map(d => ({
      id: d.device.mqtt_device_id,
      limits: [d.limits.min, d.limits.max, d.tolerance, d.excursionMin, d.limits.source],
      rows: d.rows.map(r => [new Date(r.bucket).toISOString(), r.channel, Number(r.min), Number(r.max), Number(Number(r.avg).toFixed(4)), r.samples]),
      excursions: d.excursions.map(e => [new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.kind, Number(e.peak.toFixed(2))]),
      gaps: d.gaps.map(g => [new Date(g.from).toISOString(), new Date(g.to).toISOString()]),
    })),
  });
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function newCode() { return generateClaimCode(12); }
function fmtCode(code) { return code.replace(/(.{4})(?=.)/g, '$1-'); }

const RED = '#b91c1c', RED_BG = '#fde8e8', GREY = '#6b7280', GREY_BG = '#f3f4f6', DAY_BG = '#e5e7eb';

// ── The control log rows ───────────────────────────────────

function buildRows({ d, from, to, bucketSec, tz, S, doorMin }) {
  const byTime = new Map(d.buckets.map(b => [b.time, b]));
  const stepMs = bucketSec * 1000;
  const start = Math.floor(from.getTime() / stepMs) * stepMs;
  const excursions = d.excursions.map(e => [e.start, e.end]);
  const gaps = d.gaps.map(g => [g.from, g.to]);
  const days = new Map();
  for (let t = start; t < to.getTime(); t += stepMs) {
    const b = byTime.get(new Date(t).toISOString());
    const v = b && b[HACCP_CHANNEL] ? b[HACCP_CHANNEL].avg : null;
    const { day, time } = localParts(t, tz);
    const deviation = overlaps(t, t + stepMs, excursions);
    const notes = [];
    if (overlaps(t, t + stepMs, d.defrost)) notes.push(S.note_defrost);
    if (overlaps(t, t + stepMs, d.doors)) notes.push(tpl(S.note_door, doorMin));
    const gap = v === null || overlaps(t, t + stepMs, gaps);
    if (gap) notes.push(S.note_gap);
    if (!days.has(day)) days.set(day, { day, rows: [], deviations: 0 });
    const row = { clock: time, value: v, deviation, gap, notes };
    days.get(day).rows.push(row);
    if (deviation) days.get(day).deviations++;
  }
  return [...days.values()];
}

// ── Document sections ──────────────────────────────────────

function deviceSection({ S, tz, d, bucketKey, bucketSec, from, to, single, doorMin }) {
  const dev = d.device;
  const hasLimits = d.limits.min !== null || d.limits.max !== null;
  const limitCol = limitShort(d.limits, d.tolerance);
  const head = [
    { text: single ? S.device : `${S.device}: ${dev.name || dev.mqtt_device_id}`, style: 'sectionHeader' },
    {
      table: {
        widths: ['auto', '*', 'auto', '*'],
        body: [
          [{ text: `${S.device}:`, bold: true }, `${dev.name || dev.mqtt_device_id}`, { text: `${S.device_id}:`, bold: true }, `${dev.mqtt_device_id}`],
          [{ text: `${S.serial}:`, bold: true }, `${dev.serial_number || '—'}`, { text: `${S.model}:`, bold: true }, `${dev.model || '—'}`],
          [{ text: `${S.product}:`, bold: true }, `${dev.haccp_product || '—'}`, { text: `${S.limit}:`, bold: true }, { text: limitSentence(S, d.limits, d.tolerance), bold: hasLimits, color: hasLimits ? undefined : RED }],
        ],
      },
      layout: 'noBorders', fontSize: 8.5, margin: [0, 0, 0, 2],
    },
    { text: tpl(S.excursion_rule, d.excursionMin), fontSize: 8, color: '#555555', margin: [0, 0, 0, 8] },
  ];

  const sm = d.summary;
  const summaryTable = {
    table: {
      headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [
        ['', S.min, S.max, S.avg, S.samples].map(t => ({ text: t, bold: true })),
        [`${S.col_air}`, sm ? fmt1(Number(sm.min)) : '—', sm ? fmt1(Number(sm.max)) : '—', sm ? fmt1(Number(sm.avg)) : '—', sm ? String(sm.samples) : '0'],
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 5, 0, 4],
  };
  const exMin = d.excursions.reduce((a, e) => a + e.minutes, 0);
  const gapMin = d.gaps.reduce((a, g) => a + g.minutes, 0);
  const statsLine = {
    text: tpl(S.stats,
      `${d.excursions.length}${exMin ? ' (' + fmtDuration(exMin, S) + ')' : ''}`,
      `${d.gaps.length}${gapMin ? ' (' + fmtDuration(gapMin, S) + ')' : ''}`),
    fontSize: 9, bold: d.excursions.length > 0, color: d.excursions.length ? RED : undefined, margin: [0, 0, 0, 10],
  };

  // ── the log ──
  const days = buildRows({ d, from, to, bucketSec, tz, S, doorMin });
  const cols = [S.col_time, S.col_air, S.col_limit, S.col_deviation, S.col_note];
  const body = [cols.map(t => ({ text: t, bold: true, fontSize: 8 }))];
  for (const day of days) {
    body.push([{ text: `${localFmt(day.day + 'T12:00:00Z', 'UTC', false)}${day.deviations ? '   ' + tpl(S.day_deviations, day.deviations) : ''}`, colSpan: 5, bold: true, fillColor: DAY_BG, fontSize: 8.5 }, {}, {}, {}, {}]);
    for (const r of day.rows) {
      const fill = r.deviation ? RED_BG : (r.gap ? GREY_BG : undefined);
      const cell = (text, extra = {}) => ({ text, fillColor: fill, ...extra });
      body.push([
        cell(r.clock, r.gap && !r.deviation ? { color: GREY } : {}),
        cell(fmt1(r.value), r.deviation ? { bold: true, color: RED } : (r.gap ? { color: GREY } : {})),
        cell(limitCol, { color: GREY }),
        cell(!hasLimits ? S.nd : (r.deviation ? S.yes : S.no), r.deviation ? { bold: true, color: RED } : {}),
        cell(r.notes.join(', '), { color: r.deviation ? undefined : GREY, italics: r.gap }),
      ]);
    }
  }
  const logTable = {
    table: { headerRows: 1, widths: ['auto', 'auto', 'auto', 'auto', '*'], body, dontBreakRows: true },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3),
      vLineWidth: () => 0, hLineColor: () => '#9ca3af', paddingTop: () => 2, paddingBottom: () => 2,
    },
    fontSize: 8, margin: [0, 5, 0, 10],
  };

  // ── product excursions ──
  const excursionsBlock = d.excursions.length
    ? {
        table: {
          headerRows: 1, widths: ['auto', 'auto', 'auto', 'auto', '*', '*'],
          body: [
            [S.col_start, S.col_end, S.col_duration, S.col_peak, S.col_action, S.col_responsible].map(t => ({ text: t, bold: true })),
            ...d.excursions.map(e => {
              const a = actionFor(S, e, d.workOrders);
              return [localFmt(e.start, tz), localFmt(e.end, tz), fmtDuration(e.minutes, S), { text: `${fmt1(e.peak)} °C`, bold: true, color: RED },
                      a.action || { text: ' ', margin: [0, 8] }, a.responsible || ' '];
            }),
          ],
        },
        layout: 'lightHorizontalLines', fontSize: 8, margin: [0, 5, 0, 10],
      }
    : { text: S.excursions_none, italics: true, margin: [0, 5, 0, 10] };

  // ── recording gaps ──
  const gapsBlock = d.gaps.length
    ? {
        table: {
          headerRows: 0, widths: ['*', 'auto'],
          body: d.gaps.map(g => [tpl(S.gap_row, localFmt(g.from, tz), localFmt(g.to, tz)), { text: fmtDuration(g.minutes, S), alignment: 'right' }]),
        },
        layout: 'lightHorizontalLines', fontSize: 8, margin: [0, 5, 0, 10],
      }
    : { text: S.gaps_none, italics: true, margin: [0, 5, 0, 10] };

  const service = d.lastService
    ? `${localFmt(d.lastService.service_date, tz, false)} — ${d.lastService.technician}: ${d.lastService.work_done}`
    : S.no_service;
  return [
    ...head,
    { text: S.summary, style: 'subHeader' }, summaryTable, statsLine,
    { text: `${S.journal} (${S.every} ${bucketKey})`, style: 'subHeader' }, logTable,
    { text: S.excursions_title, style: 'subHeader' }, excursionsBlock,
    { text: S.gaps_title, style: 'subHeader' }, gapsBlock,
    { text: `${S.sensors_note} ${service}`, fontSize: 7.5, color: '#555555', margin: [0, 0, 0, 14] },
  ];
}

/**
 * @returns {{ docDefinition: object }}
 */
function buildDocument({ kind, lang, tz, tenant, site, devices, from, to, bucketKey, bucketSec, source, generatedBy, generatedAt, code, hash, verifyUrl, rawRetentionDays, doorMin }) {
  const S = strings(lang);
  const title = kind === 'site' ? S.site_title : S.title;
  const orgName = tenant.legal_name || tenant.name;
  const address = site ? [site.address_line, site.city, site.region, site.country].filter(Boolean).join(', ') : null;
  const stepSec = devices[0] ? devices[0].stepSec : 60;

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
    margin: [0, 0, 0, 8],
  };
  const method = {
    text: [
      { text: `${S.method_title}: `, bold: true }, source === 'hourly' ? S.method_hourly : tpl(S.method_raw, fmtStep(stepSec, S)), '\n',
      { text: `${S.retention_title}: `, bold: true }, tpl(S.retention_text, rawRetentionDays, verifyUrl),
    ],
    fontSize: 8, color: '#444444', margin: [0, 0, 0, 12],
  };

  const signTable = () => ({
    table: {
      widths: ['*', '*', '*', 'auto'],
      body: [
        [S.full_name, S.position, S.signature, S.date].map(t => ({ text: t, bold: true, fontSize: 8 })),
        [{ text: ' ', margin: [0, 14] }, ' ', ' ', '____.____.______'],
      ],
    },
    layout: 'lightHorizontalLines', margin: [0, 6, 0, 10],
  });

  // The QR code and the code/hash travel together: never split across a page break
  const verifyBlock = {
    unbreakable: true,
    columns: [
      {
        width: '*',
        text: [
          { text: `${S.verify}: `, bold: true },
          `${S.verify_text} ${verifyUrl}\n`,
          { text: `${fmtCode(code)}   SHA-256 ${hash}`, fontSize: 7, color: '#555555' },
        ],
        fontSize: 8, margin: [0, 6, 8, 0],
      },
      { width: 64, qr: verifyUrl, fit: 64, alignment: 'right' },
    ],
    margin: [0, 4, 0, 0],
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
        method,
        ...devices.flatMap(d => deviceSection({ S, tz, d, bucketKey, bucketSec, from, to, single: kind === 'device', doorMin })),
        { text: S.responsible, style: 'sectionHeader' },
        signTable(),
        { text: S.verified_by, style: 'sectionHeader' },
        signTable(),
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
 * haccp_min, haccp_max, haccp_tolerance, haccp_product, last_state); `tenant` may carry
 * haccp_excursion_min, door_alarm_delay_ms and sampling_sec, `site` haccp_excursion_min.
 * `channels` is accepted for compatibility: the inspector's log shows the air channel only.
 * @returns {Promise<{ buffer: Buffer, code: string, hash: string, source: string, bucketKey: string, empty: boolean }>}
 */
async function generate({ query, kind, tenant, site, devices, from, to, bucketKey, lang, rawRetentionDays, generatedBy, scheduleId = null, now = new Date() }) {
  const plan = planSource({ from, to, rawRetentionDays, bucketKey, now });
  const excursionMin = num(site && site.haccp_excursion_min) ?? num(tenant.haccp_excursion_min) ?? DEFAULT_EXCURSION_MIN;
  const doorMin = Math.max(1, Math.round((num(tenant.door_alarm_delay_ms) ?? DEFAULT_DOOR_DELAY_MS) / 60000));
  const samplingSec = num(tenant.sampling_sec) ?? 60;
  const collected = [];
  for (const device of devices) {
    collected.push(await collectDevice({ query, device, tenantId: tenant.id, from, to, bucketSec: plan.bucketSec, source: plan.source, excursionMin, samplingSec }));
  }
  const withData = collected.filter(d => d.rows.length > 0);
  if (withData.length === 0) return { empty: true, source: plan.source, bucketKey: plan.bucketKey };

  const tz = (site && site.timezone) || tenant.timezone || 'Europe/Kyiv';
  const generatedAt = now.toISOString();
  const code = newCode();
  const hash = sha256(canonicalData({ kind, tenant, site, devices: withData, from, to, bucketKey: plan.bucketKey, source: plan.source, generatedAt }));
  const { docDefinition } = buildDocument({
    kind, lang, tz, tenant, site, devices: withData, from, to, bucketKey: plan.bucketKey, bucketSec: plan.bucketSec, source: plan.source,
    generatedBy, generatedAt, code, hash, verifyUrl: verifyUrlFor(code), rawRetentionDays: rawRetentionDays || 90, doorMin,
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
  __test: { limitsFor, toleranceOf, limitSentence, limitShort, stepOf, defrostIntervals, detectExcursions, detectGaps, actionFor,
            buildRows, collectDevice, buildDocument, localParts, fmtDuration, tpl },
};
