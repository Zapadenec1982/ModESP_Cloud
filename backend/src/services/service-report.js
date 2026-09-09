'use strict';

/**
 * Service report (engineering counterpart of the HACCP log).
 *
 * The HACCP log answers the inspector; this one answers the technician, from
 * the same data set: the controller's settings snapshot, every temperature
 * channel (air, evaporator, condenser, setpoint) with a chart, compressor duty
 * and starts, defrost cycles, door and offline periods, recording gaps and
 * HACCP excursions, the full alarm list with names in the report language,
 * connectivity events, maintenance hints, work orders and service records,
 * and an engineering log per interval. Same verification: a code, the
 * SHA-256 of the data and a QR code with the verification URL.
 */

const haccp = require('./haccp-report');
const { fetchSeries, summarize, stepOf, defrostIntervals, detectExcursions, detectGaps, limitsFor, toleranceOf, limitSentence,
        localParts, fmtDuration, tpl, num, fmt1, DEFAULT_EXCURSION_MIN, DEFAULT_DOOR_DELAY_MS, MAX_ROWS } = haccp.helpers;
const { localFmt, planSource, render, registerExport, verifyUrlFor, newCode, fmtCode, sha256 } = haccp;

const CHANNELS = ['air', 'evap', 'cond', 'setpoint', 'comp', 'defrost'];
const TEMP_CHANNELS = ['air', 'evap', 'cond', 'setpoint'];
const RAW_LIMIT = 300000;

const STRINGS = {
  uk: {
    title: 'Сервісний звіт обладнання', site_title: 'Сервісний звіт точки',
    organisation: 'Організація', tax_id: 'Код ЄДРПОУ/ІПН', serviced_by: 'Обслуговує', site: 'Точка', address: 'Адреса', timezone: 'Часовий пояс',
    period: 'Період', bucket: 'Інтервал', generated: 'Сформовано', by: 'ким', source: 'Джерело даних', source_raw: 'первинні вимірювання приладу', source_hourly: 'погодинний архів',
    not_haccp: 'Технічний документ для сервісу; для інспектора призначений журнал контролю температури (HACCP).',
    device: 'Обладнання', device_id: 'Ідентифікатор', serial: 'Серійний номер', model: 'Модель', firmware: 'Прошивка', last_seen: 'Останні дані', product: 'Продукція',
    settings: 'Налаштування приладу (останній стан)', no_settings: 'стан приладу ще не отримано',
    keys: { 'thermostat.setpoint': 'Уставка', 'thermostat.differential': 'Гістерезис', 'protection.high_limit': 'Межа тривоги, верхня', 'protection.low_limit': 'Межа тривоги, нижня', 'protection.high_alarm_delay': 'Затримка тривоги, верхня', 'protection.low_alarm_delay': 'Затримка тривоги, нижня', 'protection.door_delay': 'Затримка тривоги дверей', 'thermostat.min_off_time': 'Мін. пауза компресора', 'thermostat.min_on_time': 'Мін. робота компресора', 'thermostat.night_setback': 'Нічний зсув', 'defrost.interval': 'Інтервал відтайки', 'defrost.max_duration': 'Макс. тривалість відтайки', 'defrost.termination': 'Завершення відтайки', 'protection.max_starts_hour': 'Макс. пусків за годину', 'protection.max_continuous_run': 'Макс. безперервна робота', 'protection.pulldown_min_drop': 'Мін. падіння при охолодженні', 'protection.max_rise_rate': 'Макс. швидкість росту' },
    haccp_limit: 'Критична межа HACCP', excursion_rule: 'відхилення — довше ніж {0} хв за межею, відтайка не враховується',
    summary: 'Температури за період', channel: 'Канал', min: 'Мін °C', max: 'Макс °C', avg: 'Сер. °C', samples: 'Вимірювань',
    ch: { air: 'Повітря', evap: 'Випарник', cond: 'Конденсатор', setpoint: 'Уставка', comp: 'Компресор', defrost: 'Відтайка' },
    delta_t: 'ΔT повітря − випарник (сер.)', cond_max: 'Конденсатор, макс.',
    chart: 'Графік', chart_legend: 'синя — повітря, зелена — випарник, сіра пунктирна — уставка, червона — межа HACCP',
    operation: 'Робота обладнання', comp_duty: 'Компресор: частка часу', comp_starts: 'Пусків компресора', comp_longest: 'Найдовша робота без зупинки', comp_per_hour: 'пусків/год',
    defrost_cycles: 'Циклів відтайки', defrost_total: 'Загальна тривалість відтайки', defrost_avg: 'Середня тривалість відтайки',
    door_events: 'Тривог дверей', door_total: 'Двері відчинені (сумарно, за тривогами)',
    offline_periods: 'Періодів офлайн', offline_total: 'Офлайн сумарно', gaps: 'Розривів запису', gaps_total: 'Розриви сумарно',
    excursions: 'Відхилень HACCP', excursions_total: 'Відхилення сумарно', none: 'немає', nd: 'н/д',
    alarms: 'Тривоги за період', no_alarms: 'Тривог за період не зафіксовано.',
    time: 'Час', event: 'Подія', severity: 'Важливість', value: 'Значення', limit: 'межа', cleared: 'Знято', active: 'Активна', ack: 'Підтверджено', note: 'нотатка', work_order: 'Наряд',
    sev: { critical: 'критична', warning: 'попередження', info: 'інформація' },
    connectivity: 'Звʼязок із хмарою', no_offline: 'Втрат звʼязку за період не зафіксовано.', col_from: 'З', col_to: 'По', col_duration: 'Тривалість', still_offline: 'досі офлайн',
    hints: 'Рекомендації з обслуговування', no_hints: 'Рекомендацій за період немає.', hint_names: { alarm_repeat: 'Аварія повторюється' },
    col_rule: 'Правило', col_opened: 'Відкрито', col_closed: 'Закрито', col_status: 'Стан', open: 'відкрита', closed: 'закрита',
    work: 'Наряди й сервісні записи', no_work: 'Нарядів і сервісних записів за період немає.', col_kind: 'Тип', col_what: 'Що зроблено / назва', col_who: 'Хто', service_record: 'Сервісний запис', parts: 'запчастини', duration: 'тривалість',
    wo: { new: 'новий', assigned: 'призначено', in_progress: 'у роботі', done: 'виконано', cancelled: 'скасовано' },
    log: 'Інженерний журнал', col_time: 'Час', col_comp: 'Компр. %', col_defrost: 'Відтайка', col_note: 'Примітка', note_offline: 'офлайн', note_gap: 'розрив', note_door: 'двері', yes: 'так',
    min_short: 'хв', h_short: 'год', d_short: 'дн', s_short: 'с', pct: '%',
    verify: 'Перевірка автентичності', verify_text: 'Код перевірки та SHA-256 даних звіту зберігаються платформою. Перевірити:',
    page: 'Сторінка', of: 'з', no_data: 'Дані за період відсутні',
  },
  en: {
    title: 'Equipment Service Report', site_title: 'Site Service Report',
    organisation: 'Organisation', tax_id: 'Tax ID', serviced_by: 'Serviced by', site: 'Site', address: 'Address', timezone: 'Time zone',
    period: 'Period', bucket: 'Interval', generated: 'Generated', by: 'by', source: 'Data source', source_raw: 'raw measurements of the device', source_hourly: 'hourly archive',
    not_haccp: 'A technical document for service; the inspector gets the HACCP temperature control log instead.',
    device: 'Equipment', device_id: 'Identifier', serial: 'Serial number', model: 'Model', firmware: 'Firmware', last_seen: 'Last data', product: 'Product',
    settings: 'Controller settings (last state)', no_settings: 'no state received from the device yet',
    keys: { 'thermostat.setpoint': 'Setpoint', 'thermostat.differential': 'Differential', 'protection.high_limit': 'Alarm limit, high', 'protection.low_limit': 'Alarm limit, low', 'protection.high_alarm_delay': 'Alarm delay, high', 'protection.low_alarm_delay': 'Alarm delay, low', 'protection.door_delay': 'Door alarm delay', 'thermostat.min_off_time': 'Min compressor off time', 'thermostat.min_on_time': 'Min compressor on time', 'thermostat.night_setback': 'Night setback', 'defrost.interval': 'Defrost interval', 'defrost.max_duration': 'Max defrost duration', 'defrost.termination': 'Defrost termination', 'protection.max_starts_hour': 'Max starts per hour', 'protection.max_continuous_run': 'Max continuous run', 'protection.pulldown_min_drop': 'Min pull-down drop', 'protection.max_rise_rate': 'Max rise rate' },
    haccp_limit: 'HACCP critical limit', excursion_rule: 'excursion — longer than {0} min past the limit, defrost excluded',
    summary: 'Temperatures over the period', channel: 'Channel', min: 'Min °C', max: 'Max °C', avg: 'Avg °C', samples: 'Samples',
    ch: { air: 'Air', evap: 'Evaporator', cond: 'Condenser', setpoint: 'Setpoint', comp: 'Compressor', defrost: 'Defrost' },
    delta_t: 'ΔT air − evaporator (avg)', cond_max: 'Condenser, max',
    chart: 'Chart', chart_legend: 'blue — air, green — evaporator, grey dashed — setpoint, red — HACCP limit',
    operation: 'Equipment operation', comp_duty: 'Compressor: share of time', comp_starts: 'Compressor starts', comp_longest: 'Longest uninterrupted run', comp_per_hour: 'starts/h',
    defrost_cycles: 'Defrost cycles', defrost_total: 'Total defrost time', defrost_avg: 'Average defrost duration',
    door_events: 'Door alarms', door_total: 'Door open (total, by alarms)',
    offline_periods: 'Offline periods', offline_total: 'Offline total', gaps: 'Recording gaps', gaps_total: 'Gaps total',
    excursions: 'HACCP excursions', excursions_total: 'Excursions total', none: 'none', nd: 'n/a',
    alarms: 'Alarms during the period', no_alarms: 'No alarms during the period.',
    time: 'Time', event: 'Event', severity: 'Severity', value: 'Value', limit: 'limit', cleared: 'Cleared', active: 'Active', ack: 'Acknowledged', note: 'note', work_order: 'Work order',
    sev: { critical: 'critical', warning: 'warning', info: 'info' },
    connectivity: 'Cloud connectivity', no_offline: 'No connectivity losses during the period.', col_from: 'From', col_to: 'To', col_duration: 'Duration', still_offline: 'still offline',
    hints: 'Maintenance hints', no_hints: 'No hints during the period.', hint_names: { alarm_repeat: 'Recurring alarm' },
    col_rule: 'Rule', col_opened: 'Opened', col_closed: 'Closed', col_status: 'State', open: 'open', closed: 'closed',
    work: 'Work orders and service records', no_work: 'No work orders or service records during the period.', col_kind: 'Kind', col_what: 'Work done / title', col_who: 'Who', service_record: 'Service record', parts: 'parts', duration: 'duration',
    wo: { new: 'new', assigned: 'assigned', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' },
    log: 'Engineering log', col_time: 'Time', col_comp: 'Comp. %', col_defrost: 'Defrost', col_note: 'Note', note_offline: 'offline', note_gap: 'gap', note_door: 'door', yes: 'yes',
    min_short: 'min', h_short: 'h', d_short: 'd', s_short: 's', pct: '%',
    verify: 'Authenticity check', verify_text: 'The verification code and the SHA-256 of the report data are stored by the platform. Verify at:',
    page: 'Page', of: 'of', no_data: 'No data for the period',
  },
  pl: {
    title: 'Raport serwisowy urządzenia', site_title: 'Raport serwisowy lokalizacji',
    organisation: 'Organizacja', tax_id: 'NIP', serviced_by: 'Obsługuje', site: 'Lokalizacja', address: 'Adres', timezone: 'Strefa czasowa',
    period: 'Okres', bucket: 'Interwał', generated: 'Wygenerowano', by: 'przez', source: 'Źródło danych', source_raw: 'pomiary surowe urządzenia', source_hourly: 'archiwum godzinowe',
    not_haccp: 'Dokument techniczny dla serwisu; dla inspektora przeznaczony jest dziennik kontroli temperatury (HACCP).',
    device: 'Urządzenie', device_id: 'Identyfikator', serial: 'Numer seryjny', model: 'Model', firmware: 'Firmware', last_seen: 'Ostatnie dane', product: 'Produkt',
    settings: 'Ustawienia sterownika (ostatni stan)', no_settings: 'stan urządzenia nie został jeszcze odebrany',
    keys: { 'thermostat.setpoint': 'Nastawa', 'thermostat.differential': 'Histereza', 'protection.high_limit': 'Limit alarmu, górny', 'protection.low_limit': 'Limit alarmu, dolny', 'protection.high_alarm_delay': 'Opóźnienie alarmu, górne', 'protection.low_alarm_delay': 'Opóźnienie alarmu, dolne', 'protection.door_delay': 'Opóźnienie alarmu drzwi', 'thermostat.min_off_time': 'Min. przerwa sprężarki', 'thermostat.min_on_time': 'Min. praca sprężarki', 'thermostat.night_setback': 'Nocne przesunięcie', 'defrost.interval': 'Interwał odszraniania', 'defrost.max_duration': 'Maks. czas odszraniania', 'defrost.termination': 'Zakończenie odszraniania', 'protection.max_starts_hour': 'Maks. startów na godzinę', 'protection.max_continuous_run': 'Maks. praca ciągła', 'protection.pulldown_min_drop': 'Min. spadek przy schładzaniu', 'protection.max_rise_rate': 'Maks. tempo wzrostu' },
    haccp_limit: 'Limit krytyczny HACCP', excursion_rule: 'odchylenie — dłużej niż {0} min poza limitem, odszranianie wyłączone',
    summary: 'Temperatury w okresie', channel: 'Kanał', min: 'Min °C', max: 'Maks °C', avg: 'Śr. °C', samples: 'Pomiary',
    ch: { air: 'Powietrze', evap: 'Parownik', cond: 'Skraplacz', setpoint: 'Nastawa', comp: 'Sprężarka', defrost: 'Odszranianie' },
    delta_t: 'ΔT powietrze − parownik (śr.)', cond_max: 'Skraplacz, maks.',
    chart: 'Wykres', chart_legend: 'niebieska — powietrze, zielona — parownik, szara przerywana — nastawa, czerwona — limit HACCP',
    operation: 'Praca urządzenia', comp_duty: 'Sprężarka: udział czasu', comp_starts: 'Startów sprężarki', comp_longest: 'Najdłuższa praca bez przerwy', comp_per_hour: 'startów/h',
    defrost_cycles: 'Cykli odszraniania', defrost_total: 'Łączny czas odszraniania', defrost_avg: 'Średni czas odszraniania',
    door_events: 'Alarmów drzwi', door_total: 'Drzwi otwarte (łącznie, wg alarmów)',
    offline_periods: 'Okresów offline', offline_total: 'Offline łącznie', gaps: 'Przerw w zapisie', gaps_total: 'Przerwy łącznie',
    excursions: 'Odchyleń HACCP', excursions_total: 'Odchylenia łącznie', none: 'brak', nd: 'b/d',
    alarms: 'Alarmy w okresie', no_alarms: 'Brak alarmów w okresie.',
    time: 'Czas', event: 'Zdarzenie', severity: 'Ważność', value: 'Wartość', limit: 'limit', cleared: 'Zakończony', active: 'Aktywny', ack: 'Potwierdzony', note: 'uwaga', work_order: 'Zlecenie',
    sev: { critical: 'krytyczny', warning: 'ostrzeżenie', info: 'informacja' },
    connectivity: 'Łączność z chmurą', no_offline: 'Brak utrat łączności w okresie.', col_from: 'Od', col_to: 'Do', col_duration: 'Czas trwania', still_offline: 'nadal offline',
    hints: 'Wskazówki serwisowe', no_hints: 'Brak wskazówek w okresie.', hint_names: { alarm_repeat: 'Alarm się powtarza' },
    col_rule: 'Reguła', col_opened: 'Otwarto', col_closed: 'Zamknięto', col_status: 'Stan', open: 'otwarta', closed: 'zamknięta',
    work: 'Zlecenia i wpisy serwisowe', no_work: 'Brak zleceń i wpisów serwisowych w okresie.', col_kind: 'Rodzaj', col_what: 'Wykonano / tytuł', col_who: 'Kto', service_record: 'Wpis serwisowy', parts: 'części', duration: 'czas',
    wo: { new: 'nowe', assigned: 'przydzielone', in_progress: 'w toku', done: 'wykonane', cancelled: 'anulowane' },
    log: 'Dziennik inżynierski', col_time: 'Czas', col_comp: 'Spręż. %', col_defrost: 'Odszr.', col_note: 'Uwaga', note_offline: 'offline', note_gap: 'przerwa', note_door: 'drzwi', yes: 'tak',
    min_short: 'min', h_short: 'h', d_short: 'dn', s_short: 's', pct: '%',
    verify: 'Weryfikacja autentyczności', verify_text: 'Kod weryfikacyjny i SHA-256 danych raportu są przechowywane przez platformę. Sprawdź:',
    page: 'Strona', of: 'z', no_data: 'Brak danych za okres',
  },
  de: {
    title: 'Servicebericht der Anlage', site_title: 'Servicebericht des Standorts',
    organisation: 'Organisation', tax_id: 'Steuernummer', serviced_by: 'Betreut von', site: 'Standort', address: 'Adresse', timezone: 'Zeitzone',
    period: 'Zeitraum', bucket: 'Intervall', generated: 'Erstellt', by: 'von', source: 'Datenquelle', source_raw: 'Rohmessungen des Geräts', source_hourly: 'Stundenarchiv',
    not_haccp: 'Technisches Dokument für den Service; der Prüfer erhält das HACCP-Temperaturkontrollprotokoll.',
    device: 'Anlage', device_id: 'Kennung', serial: 'Seriennummer', model: 'Modell', firmware: 'Firmware', last_seen: 'Letzte Daten', product: 'Produkt',
    settings: 'Reglereinstellungen (letzter Zustand)', no_settings: 'noch kein Zustand vom Gerät empfangen',
    keys: { 'thermostat.setpoint': 'Sollwert', 'thermostat.differential': 'Hysterese', 'protection.high_limit': 'Alarmgrenze, oben', 'protection.low_limit': 'Alarmgrenze, unten', 'protection.high_alarm_delay': 'Alarmverzögerung, oben', 'protection.low_alarm_delay': 'Alarmverzögerung, unten', 'protection.door_delay': 'Türalarm-Verzögerung', 'thermostat.min_off_time': 'Min. Verdichterpause', 'thermostat.min_on_time': 'Min. Verdichterlaufzeit', 'thermostat.night_setback': 'Nachtabsenkung', 'defrost.interval': 'Abtauintervall', 'defrost.max_duration': 'Max. Abtaudauer', 'defrost.termination': 'Abtauende', 'protection.max_starts_hour': 'Max. Starts pro Stunde', 'protection.max_continuous_run': 'Max. Dauerlauf', 'protection.pulldown_min_drop': 'Min. Abkühlung beim Anlauf', 'protection.max_rise_rate': 'Max. Anstiegsrate' },
    haccp_limit: 'Kritischer HACCP-Grenzwert', excursion_rule: 'Abweichung — länger als {0} Min. außerhalb des Grenzwerts, Abtauung ausgenommen',
    summary: 'Temperaturen im Zeitraum', channel: 'Kanal', min: 'Min °C', max: 'Max °C', avg: 'Mittel °C', samples: 'Messungen',
    ch: { air: 'Luft', evap: 'Verdampfer', cond: 'Verflüssiger', setpoint: 'Sollwert', comp: 'Verdichter', defrost: 'Abtauung' },
    delta_t: 'ΔT Luft − Verdampfer (Mittel)', cond_max: 'Verflüssiger, max.',
    chart: 'Diagramm', chart_legend: 'blau — Luft, grün — Verdampfer, grau gestrichelt — Sollwert, rot — HACCP-Grenzwert',
    operation: 'Betrieb der Anlage', comp_duty: 'Verdichter: Zeitanteil', comp_starts: 'Verdichterstarts', comp_longest: 'Längster Lauf ohne Pause', comp_per_hour: 'Starts/h',
    defrost_cycles: 'Abtauzyklen', defrost_total: 'Abtauzeit gesamt', defrost_avg: 'Mittlere Abtaudauer',
    door_events: 'Türalarme', door_total: 'Tür offen (gesamt, laut Alarmen)',
    offline_periods: 'Offline-Zeiträume', offline_total: 'Offline gesamt', gaps: 'Aufzeichnungslücken', gaps_total: 'Lücken gesamt',
    excursions: 'HACCP-Abweichungen', excursions_total: 'Abweichungen gesamt', none: 'keine', nd: 'k. A.',
    alarms: 'Alarme im Zeitraum', no_alarms: 'Keine Alarme im Zeitraum.',
    time: 'Zeit', event: 'Ereignis', severity: 'Schwere', value: 'Wert', limit: 'Grenze', cleared: 'Beendet', active: 'Aktiv', ack: 'Bestätigt', note: 'Notiz', work_order: 'Auftrag',
    sev: { critical: 'kritisch', warning: 'Warnung', info: 'Info' },
    connectivity: 'Cloud-Verbindung', no_offline: 'Keine Verbindungsverluste im Zeitraum.', col_from: 'Von', col_to: 'Bis', col_duration: 'Dauer', still_offline: 'noch offline',
    hints: 'Wartungshinweise', no_hints: 'Keine Hinweise im Zeitraum.', hint_names: { alarm_repeat: 'Alarm wiederholt sich' },
    col_rule: 'Regel', col_opened: 'Eröffnet', col_closed: 'Geschlossen', col_status: 'Status', open: 'offen', closed: 'geschlossen',
    work: 'Aufträge und Serviceeinträge', no_work: 'Keine Aufträge und Serviceeinträge im Zeitraum.', col_kind: 'Art', col_what: 'Erledigt / Titel', col_who: 'Wer', service_record: 'Serviceeintrag', parts: 'Teile', duration: 'Dauer',
    wo: { new: 'neu', assigned: 'zugewiesen', in_progress: 'in Arbeit', done: 'erledigt', cancelled: 'storniert' },
    log: 'Technisches Protokoll', col_time: 'Zeit', col_comp: 'Verd. %', col_defrost: 'Abtau.', col_note: 'Bemerkung', note_offline: 'offline', note_gap: 'Lücke', note_door: 'Tür', yes: 'ja',
    min_short: 'Min.', h_short: 'Std.', d_short: 'Tg.', s_short: 's', pct: '%',
    verify: 'Echtheitsprüfung', verify_text: 'Prüfcode und SHA-256 der Berichtsdaten werden von der Plattform gespeichert. Prüfen unter:',
    page: 'Seite', of: 'von', no_data: 'Keine Daten für den Zeitraum',
  },
};

function strings(lang) { return STRINGS[lang] || STRINGS.uk; }

function alarmName(lang, code) {
  const names = require('./email').__strings.ALARM_NAMES;
  const dict = names[lang] || names.uk || {};
  return dict[code] || dict[`protection.${code}`] || code;
}

// ── Data ───────────────────────────────────────────────────

async function fetchRawChannels({ query, tenantId, deviceId, from, to, source, channels }) {
  if (source === 'hourly') {
    const { rows } = await query(
      `SELECT hour, channel, min, max, avg, samples FROM telemetry_hourly
        WHERE tenant_id = $1 AND device_id = $2 AND hour >= $3 AND hour < $4 AND channel = ANY($5) ORDER BY hour ASC`,
      [tenantId, deviceId, from, to, channels]);
    const out = Object.fromEntries(channels.map(c => [c, []]));
    for (const r of rows) out[r.channel].push({ t: new Date(r.hour).getTime(), v: Number(r.avg), min: Number(r.min), max: Number(r.max), avg: Number(r.avg), samples: r.samples });
    return { series: out, hourly: true };
  }
  const { rows } = await query(
    `SELECT time, channel, value FROM telemetry
      WHERE tenant_id = $1 AND device_id = $2 AND time >= $3 AND time < $4 AND channel = ANY($5)
      ORDER BY time ASC LIMIT ${RAW_LIMIT}`,
    [tenantId, deviceId, from, to, channels]);
  const out = Object.fromEntries(channels.map(c => [c, []]));
  for (const r of rows) out[r.channel].push({ t: new Date(r.time).getTime(), v: Number(r.value) });
  return { series: out, hourly: false };
}

/** Compressor: share of time on, number of starts, longest run — from the 0/1 channel. */
function compressorStats(points, stepMs, hourly) {
  if (points.length === 0) return { duty: null, starts: 0, longestMin: 0 };
  if (hourly) {
    const duty = points.reduce((a, p) => a + p.avg, 0) / points.length;
    return { duty: Math.round(duty * 1000) / 10, starts: null, longestMin: null };
  }
  let on = 0, starts = 0, run = 0, longest = 0, prev = null;
  for (const p of points) {
    const isOn = p.v >= 0.5;
    if (isOn) { on++; run++; longest = Math.max(longest, run); } else run = 0;
    if (isOn && prev !== null && !prev) starts++;
    prev = isOn;
  }
  return { duty: Math.round(on / points.length * 1000) / 10, starts, longestMin: Math.round(longest * stepMs / 60000) };
}

/** Offline periods from the device_offline / device_online events (a lost cloud connection, not a data gap). */
async function fetchOfflinePeriods({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT event_type, time FROM events
      WHERE tenant_id = $1 AND device_id = $2 AND event_type IN ('device_offline', 'device_online')
        AND time >= $3 AND time < $4 ORDER BY time ASC LIMIT 2000`,
    [tenantId, deviceId, new Date(from.getTime() - 86400e3), to]);
  const periods = [];
  let open = null;
  for (const r of rows) {
    const t = new Date(r.time).getTime();
    if (r.event_type === 'device_offline') { if (open === null) open = t; }
    else if (open !== null) { periods.push([open, t]); open = null; }
  }
  if (open !== null) periods.push([open, null]);
  const f = from.getTime(), tt = to.getTime();
  return periods
    .filter(([a, b]) => (b === null || b > f) && a < tt)
    .map(([a, b]) => ({ from: Math.max(a, f), to: b === null ? tt : Math.min(b, tt), open: b === null, minutes: Math.round(((b === null ? tt : Math.min(b, tt)) - Math.max(a, f)) / 60000) }));
}

async function fetchAlarms({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT a.id, a.alarm_code, a.severity, a.value, a.limit_value, a.triggered_at, a.cleared_at, a.acknowledged_at, a.ack_note, u.email AS ack_by,
            w.id AS wo_id, w.status AS wo_status
       FROM alarms a
       LEFT JOIN users u ON u.id = a.acknowledged_by
       LEFT JOIN LATERAL (SELECT id, status FROM work_orders WHERE alarm_id = a.id ORDER BY created_at DESC LIMIT 1) w ON true
      WHERE a.tenant_id = $1 AND a.device_id = $2 AND a.triggered_at >= $3 AND a.triggered_at < $4
      ORDER BY a.triggered_at ASC LIMIT 300`,
    [tenantId, deviceId, from, to]);
  return rows;
}

async function fetchHints({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT h.id, h.rule_key, h.alarm_code, h.severity, h.value::float AS value, h.threshold::float AS threshold, h.window_hours,
            h.opened_at, h.last_seen_at, h.closed_at, h.closed_reason, h.acknowledged_at, h.ack_note, ack.email AS ack_by,
            wo.id AS wo_id, wo.status AS wo_status
       FROM maintenance_hints h
       LEFT JOIN users ack ON ack.id = h.acknowledged_by
       LEFT JOIN LATERAL (SELECT id, status FROM work_orders WHERE hint_id = h.id ORDER BY created_at DESC LIMIT 1) wo ON true
      WHERE h.tenant_id = $1 AND h.device_id = $2 AND (h.closed_at IS NULL OR h.closed_at >= $3) AND h.opened_at < $4
      ORDER BY h.opened_at ASC LIMIT 100`,
    [tenantId, deviceId, from, to]);
  return rows;
}

async function fetchWork({ query, deviceUuid, from, to }) {
  if (!deviceUuid) return { orders: [], records: [] };
  const [{ rows: orders }, { rows: records }] = await Promise.all([
    query(
      `SELECT w.id, w.title, w.status, w.priority, w.closed_reason, w.created_at, w.closed_at, u.email AS assignee
         FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to
        WHERE w.device_id = $1 AND w.created_at >= $2 AND w.created_at < $3 ORDER BY w.created_at ASC LIMIT 100`,
      [deviceUuid, from, to]),
    query(
      `SELECT id, service_date, technician, reason, work_done, duration_min, parts, work_order_id
         FROM service_records WHERE device_id = $1 AND service_date >= $2::date AND service_date <= $3::date ORDER BY service_date ASC LIMIT 100`,
      [deviceUuid, from, to]),
  ]);
  return { orders, records };
}

async function fetchDoorIntervals({ query, tenantId, deviceId, from, to }) {
  const { rows } = await query(
    `SELECT triggered_at, cleared_at FROM alarms WHERE tenant_id = $1 AND device_id = $2 AND alarm_code = 'door_alarm'
        AND triggered_at < $4 AND (cleared_at IS NULL OR cleared_at > $3) ORDER BY triggered_at LIMIT 500`,
    [tenantId, deviceId, from, to]);
  return rows.map(r => [new Date(r.triggered_at).getTime(), r.cleared_at ? new Date(r.cleared_at).getTime() : to.getTime()]);
}

async function collectDevice({ query, device, tenantId, from, to, bucketSec, source, excursionMin, samplingSec }) {
  const rows = await fetchSeries({ query, tenantId, deviceId: device.mqtt_device_id, channels: CHANNELS, from, to, bucketSec, source });
  if (rows.length > MAX_ROWS) {
    const err = new Error('Too many data points for PDF. Use a larger bucket or shorter time range.');
    err.code = 'too_much_data';
    throw err;
  }
  const { buckets, summary } = summarize(rows);
  const raw = await fetchRawChannels({ query, tenantId, deviceId: device.mqtt_device_id, from, to, source, channels: ['air', 'comp', 'defrost'] });
  const stepMs = raw.hourly ? 3600e3 : stepOf(raw.series.air, samplingSec);
  const limits = limitsFor(device);
  const tolerance = toleranceOf(device);
  const defrost = defrostIntervals(raw.series.defrost, stepMs, raw.hourly);
  const airPts = raw.series.air;
  const excursions = detectExcursions({ points: airPts, limits, tolerance, excursionMin, defrost, stepMs, hourly: raw.hourly });
  const gaps = rows.length ? detectGaps({ points: airPts, from, to, stepMs, hourly: raw.hourly }) : [];
  const comp = compressorStats(raw.series.comp, stepMs, raw.hourly);
  const [offline, alarms, hints, work, doors] = await Promise.all([
    fetchOfflinePeriods({ query, tenantId, deviceId: device.mqtt_device_id, from, to }),
    fetchAlarms({ query, tenantId, deviceId: device.mqtt_device_id, from, to }),
    fetchHints({ query, tenantId, deviceId: device.mqtt_device_id, from, to }),
    fetchWork({ query, deviceUuid: device.id, from, to }),
    fetchDoorIntervals({ query, tenantId, deviceId: device.mqtt_device_id, from, to }),
  ]);
  return { device, rows, buckets, summary, stepSec: Math.round(stepMs / 1000), hourly: raw.hourly, limits, tolerance, excursionMin,
           defrost, excursions, gaps, comp, offline, alarms, hints, work, doors };
}

function canonicalData({ kind, tenant, site, devices, from, to, bucketKey, source, generatedAt }) {
  return JSON.stringify({
    type: 'service', kind, tenant: tenant.slug, site: site ? site.id : null,
    period: [from.toISOString(), to.toISOString()], bucket: bucketKey, source, generatedAt,
    devices: devices.map(d => ({
      id: d.device.mqtt_device_id,
      rows: d.rows.map(r => [new Date(r.bucket).toISOString(), r.channel, Number(r.min), Number(r.max), Number(Number(r.avg).toFixed(4)), r.samples]),
      alarms: d.alarms.map(a => [new Date(a.triggered_at).toISOString(), a.alarm_code, a.severity, a.cleared_at ? new Date(a.cleared_at).toISOString() : null]),
      offline: d.offline.map(o => [new Date(o.from).toISOString(), new Date(o.to).toISOString()]),
      comp: [d.comp.duty, d.comp.starts, d.comp.longestMin],
    })),
  });
}

// ── Chart (inline SVG) ─────────────────────────────────────

const CHART = { w: 515, h: 170, left: 34, right: 6, top: 8, bottom: 22 };

function chartSvg({ buckets, from, to, tz, limits, tolerance }) {
  const series = { air: [], evap: [], setpoint: [] };
  for (const b of buckets) {
    const t = new Date(b.time).getTime();
    for (const ch of Object.keys(series)) if (b[ch]) series[ch].push([t, b[ch].avg]);
  }
  if (series.air.length < 2) return null;
  const values = [].concat(...Object.values(series).map(s => s.map(p => p[1])));
  if (limits.max !== null) values.push(limits.max + tolerance);
  if (limits.min !== null) values.push(limits.min - tolerance);
  let lo = Math.floor(Math.min(...values) - 1), hi = Math.ceil(Math.max(...values) + 1);
  if (hi - lo < 4) { hi = lo + 4; }
  const { w, h, left, right, top, bottom } = CHART;
  const pw = w - left - right, ph = h - top - bottom;
  const t0 = from.getTime(), t1 = to.getTime();
  const x = (t) => left + (t - t0) / (t1 - t0) * pw;
  const y = (v) => top + (hi - v) / (hi - lo) * ph;
  const path = (pts) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  svg += `<rect x="${left}" y="${top}" width="${pw}" height="${ph}" fill="#fafafa" stroke="#d1d5db" stroke-width="0.5"/>`;
  // horizontal grid: 4 lines
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4;
    const yy = y(v);
    svg += `<line x1="${left}" y1="${yy.toFixed(1)}" x2="${left + pw}" y2="${yy.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/>`;
    svg += `<text x="${left - 3}" y="${(yy + 3).toFixed(1)}" font-size="7" text-anchor="end" fill="#6b7280">${v.toFixed(0)}</text>`;
  }
  // time ticks on round local hours: the smallest step that gives at most 8 ticks
  const H = 3600e3;
  const stepH = [1, 2, 3, 6, 12, 24, 48, 168].find(h => (t1 - t0) / (h * H) <= 8) || 168;
  const offset = (t) => { const { day, time } = localParts(t, tz); return Date.parse(`${day}T${time}:00Z`) - t; };
  const off0 = offset(t0);
  let tick = Math.ceil((t0 + off0) / (stepH * H)) * stepH * H - off0;
  for (let n = 0; tick <= t1 && n < 12; tick += stepH * H, n++) {
    const t = tick - (offset(tick) - off0);   // DST change inside the period: keep the local hour round
    if (t < t0 || t > t1) continue;
    const xx = x(t);
    const { day, time } = localParts(t, tz);
    const anchor = xx < left + 20 ? 'start' : xx > left + pw - 20 ? 'end' : 'middle';
    svg += `<line x1="${xx.toFixed(1)}" y1="${top + ph}" x2="${xx.toFixed(1)}" y2="${top + ph + 3}" stroke="#9ca3af" stroke-width="0.5"/>`;
    svg += `<text x="${xx.toFixed(1)}" y="${top + ph + 11}" font-size="6.5" text-anchor="${anchor}" fill="#6b7280">${esc(time === '00:00' ? day.slice(5) : time)}</text>`;
  }
  if (limits.max !== null) {
    const yy = y(limits.max + tolerance);
    svg += `<line x1="${left}" y1="${yy.toFixed(1)}" x2="${left + pw}" y2="${yy.toFixed(1)}" stroke="#dc2626" stroke-width="0.8" stroke-dasharray="3,2"/>`;
  }
  if (limits.min !== null) {
    const yy = y(limits.min - tolerance);
    svg += `<line x1="${left}" y1="${yy.toFixed(1)}" x2="${left + pw}" y2="${yy.toFixed(1)}" stroke="#dc2626" stroke-width="0.8" stroke-dasharray="3,2"/>`;
  }
  if (series.setpoint.length > 1) svg += `<path d="${path(series.setpoint)}" fill="none" stroke="#6b7280" stroke-width="0.8" stroke-dasharray="2,2"/>`;
  if (series.evap.length > 1) svg += `<path d="${path(series.evap)}" fill="none" stroke="#16a34a" stroke-width="0.9"/>`;
  svg += `<path d="${path(series.air)}" fill="none" stroke="#2563eb" stroke-width="1.2"/>`;
  svg += '</svg>';
  return svg;
}

// ── Document ───────────────────────────────────────────────

const GREY = '#6b7280', RED = '#b91c1c', RED_BG = '#fde8e8', GREY_BG = '#f3f4f6', DAY_BG = '#e5e7eb';
const overlaps = (a0, a1, intervals) => intervals.some(([b0, b1]) => b0 < a1 && b1 > a0);
const fmtState = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : (v === null || v === undefined ? '—' : String(v)));

/** Unit of a controller parameter (mirrors paramUnit() in the WebUI). */
function unitOf(key) {
  if (/temp|setpoint|limit|differential|night_setback|end_temp|pulldown_min_drop|max_rise_rate/.test(key)) return '°C';
  if (/duration|delay|drip_time|stabilize|equalize|rate_duration|min_off_time|min_on_time|min_compressor_run|max_continuous_run|pulldown_timeout/.test(key)) return 'min';
  if (/interval.*sample|sample_interval/.test(key)) return 's';
  if (/interval|hours|retention/.test(key)) return 'h';
  if (/max_starts_hour/.test(key)) return '/h';
  return '';
}

/** [label, value with unit] for every known controller parameter present in last_state. */
function settingsRows(S, state) {
  const out = [];
  for (const key of Object.keys(S.keys)) {
    if (!state || state[key] === undefined) continue;
    const v = state[key];
    const unit = typeof v === 'number' ? unitOf(key) : '';
    out.push([S.keys[key], `${fmtState(v)}${unit ? ' ' + unit : ''}`]);
  }
  return out;
}

function deviceSection({ S, lang, tz, d, bucketKey, bucketSec, from, to, single, doorMin }) {
  const dev = d.device;
  const state = dev.last_state && typeof dev.last_state === 'object' ? dev.last_state : null;
  const totalMin = (to.getTime() - from.getTime()) / 60000;
  const hasLimits = d.limits.min !== null || d.limits.max !== null;

  const head = [
    { text: single ? S.device : `${S.device}: ${dev.name || dev.mqtt_device_id}`, style: 'sectionHeader' },
    {
      table: {
        widths: [72, '*', 96, '*'],
        body: [
          [{ text: `${S.device}:`, bold: true }, `${dev.name || dev.mqtt_device_id}`, { text: `${S.device_id}:`, bold: true }, `${dev.mqtt_device_id}`],
          [{ text: `${S.serial}:`, bold: true }, `${dev.serial_number || '—'}`, { text: `${S.model}:`, bold: true }, `${dev.model || '—'}`],
          [{ text: `${S.firmware}:`, bold: true }, `${dev.firmware_version || '—'}${dev.proto_version ? ' · v' + dev.proto_version : ''}`, { text: `${S.last_seen}:`, bold: true }, `${dev.last_seen ? localFmt(dev.last_seen, tz) : '—'}`],
          [{ text: `${S.product}:`, bold: true }, `${dev.haccp_product || '—'}`, { text: `${S.haccp_limit}:`, bold: true },
           { text: hasLimits ? `${limitSentence(haccp.strings(lang), d.limits, d.tolerance)}; ${tpl(S.excursion_rule, d.excursionMin)}` : S.nd }],
        ],
      },
      layout: 'noBorders', fontSize: 8.5, margin: [0, 0, 0, 8],
    },
  ];

  const sRows = settingsRows(S, state);
  const settingsBlock = sRows.length
    ? {
        columns: [0, 1].map(col => ({
          width: '*',
          table: { widths: ['*', 'auto'], body: sRows.filter((_, i) => i % 2 === col).map(([k, v]) => [{ text: k, color: GREY }, { text: v, bold: true, alignment: 'right' }]) },
          layout: 'lightHorizontalLines', fontSize: 8,
        })),
        columnGap: 16, margin: [0, 2, 0, 10],
      }
    : { text: S.no_settings, italics: true, fontSize: 8, margin: [0, 2, 0, 10] };

  const present = TEMP_CHANNELS.filter(c => d.summary[c]);
  const summaryTable = {
    table: {
      headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [
        [S.channel, S.min, S.max, S.avg, S.samples].map(t => ({ text: t, bold: true })),
        ...present.map(c => [S.ch[c] || c, fmt1(Number(d.summary[c].min)), fmt1(Number(d.summary[c].max)), fmt1(Number(d.summary[c].avg)), String(d.summary[c].samples)]),
      ],
    },
    layout: 'lightHorizontalLines', fontSize: 8.5, margin: [0, 4, 0, 4],
  };
  const derived = [];
  if (d.summary.air && d.summary.evap) derived.push(`${S.delta_t}: ${fmt1(Number(d.summary.air.avg) - Number(d.summary.evap.avg))} °C`);
  if (d.summary.cond) derived.push(`${S.cond_max}: ${fmt1(Number(d.summary.cond.max))} °C`);
  const derivedLine = derived.length ? { text: derived.join('   ·   '), fontSize: 8, color: GREY, margin: [0, 0, 0, 8] } : { text: '', margin: [0, 0, 0, 4] };

  const svg = chartSvg({ buckets: d.buckets, from, to, tz, limits: d.limits, tolerance: d.tolerance });
  const chartBlock = svg ? [{ svg, width: CHART.w, margin: [0, 2, 0, 2] }, { text: S.chart_legend, fontSize: 7, color: GREY, margin: [0, 0, 0, 10] }] : [];

  // ── operation stats ──
  const dur = (m) => (m ? fmtDuration(m, S) : S.none);
  const defrostMin = d.defrost.reduce((a, [x0, x1]) => a + (x1 - x0) / 60000, 0);
  const doorMinTotal = d.doors.reduce((a, [x0, x1]) => a + (Math.min(x1, to.getTime()) - Math.max(x0, from.getTime())) / 60000, 0);
  const offlineMin = d.offline.reduce((a, o) => a + o.minutes, 0);
  const gapMin = d.gaps.reduce((a, g) => a + g.minutes, 0);
  const exMin = d.excursions.reduce((a, e) => a + e.minutes, 0);
  const hours = totalMin / 60;
  const stat = (k, v) => [{ text: k, color: GREY }, { text: v, bold: true, alignment: 'right' }];
  const opRows = [
    stat(S.comp_duty, d.comp.duty === null ? S.nd : `${d.comp.duty} ${S.pct}`),
    stat(S.comp_starts, d.comp.starts === null ? S.nd : `${d.comp.starts} (${(d.comp.starts / Math.max(hours, 1)).toFixed(1)} ${S.comp_per_hour})`),
    stat(S.comp_longest, d.comp.longestMin === null ? S.nd : dur(d.comp.longestMin)),
    stat(S.defrost_cycles, String(d.defrost.length)),
    stat(S.defrost_total, dur(Math.round(defrostMin))),
    stat(S.defrost_avg, d.defrost.length ? dur(Math.round(defrostMin / d.defrost.length)) : S.none),
    stat(S.door_events, String(d.doors.length)),
    stat(S.door_total, dur(Math.round(doorMinTotal))),
    stat(S.offline_periods, String(d.offline.length)),
    stat(S.offline_total, dur(offlineMin)),
    stat(S.gaps, String(d.gaps.length)),
    stat(S.gaps_total, dur(gapMin)),
    stat(S.excursions, hasLimits ? String(d.excursions.length) : S.nd),
    stat(S.excursions_total, hasLimits ? dur(exMin) : S.nd),
  ];
  const opBlock = {
    columns: [0, 1].map(col => ({
      width: '*',
      table: { widths: ['*', 'auto'], body: opRows.filter((_, i) => i % 2 === col) },
      layout: 'lightHorizontalLines', fontSize: 8,
    })),
    columnGap: 16, margin: [0, 2, 0, 10],
  };

  // ── alarms ──
  const alarmsBlock = d.alarms.length
    ? {
        table: {
          headerRows: 1, widths: ['auto', '*', 'auto', 'auto', '*'],
          body: [
            [S.time, S.event, S.value, S.cleared, S.ack].map(t => ({ text: t, bold: true })),
            ...d.alarms.map(a => [
              localFmt(a.triggered_at, tz),
              { text: [alarmName(lang, a.alarm_code), { text: ` · ${S.sev[a.severity] || a.severity || ''}`, color: a.severity === 'critical' ? RED : GREY }] },
              a.value !== null && a.value !== undefined ? `${Number(a.value)}${a.limit_value !== null && a.limit_value !== undefined ? ` (${S.limit} ${Number(a.limit_value)})` : ''}` : '—',
              a.cleared_at ? localFmt(a.cleared_at, tz) : { text: S.active, color: RED },
              `${a.acknowledged_at ? `${localFmt(a.acknowledged_at, tz)} ${a.ack_by || ''}` : '—'}${a.ack_note ? ` · ${S.note}: «${a.ack_note}»` : ''}${a.wo_id ? ` · ${S.work_order} #${a.wo_id} (${S.wo[a.wo_status] || a.wo_status})` : ''}`,
            ]),
          ],
        },
        layout: 'lightHorizontalLines', fontSize: 7.5, margin: [0, 4, 0, 10],
      }
    : { text: S.no_alarms, italics: true, margin: [0, 4, 0, 10] };

  // ── connectivity ──
  const offlineBlock = d.offline.length
    ? {
        table: {
          headerRows: 1, widths: ['auto', 'auto', '*'],
          body: [[S.col_from, S.col_to, S.col_duration].map(t => ({ text: t, bold: true })),
            ...d.offline.map(o => [localFmt(o.from, tz), o.open ? { text: S.still_offline, color: RED } : localFmt(o.to, tz), fmtDuration(o.minutes, S)])],
        },
        layout: 'lightHorizontalLines', fontSize: 8, margin: [0, 4, 0, 10],
      }
    : { text: S.no_offline, italics: true, margin: [0, 4, 0, 10] };

  // ── hints ──
  const hintsBlock = d.hints.length
    ? {
        table: {
          headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', '*'],
          body: [[S.col_rule, S.severity, S.col_opened, S.col_status, S.ack].map(t => ({ text: t, bold: true })),
            ...d.hints.map(h => [
              `${S.hint_names[h.rule_key] || h.rule_key}${h.alarm_code ? ' — ' + alarmName(lang, h.alarm_code) : ''}${h.value != null ? ` (${h.value}/${h.threshold ?? '—'}, ${h.window_hours ?? '—'} ${S.h_short})` : ''}`,
              S.sev[h.severity] || h.severity || '—',
              localFmt(h.opened_at, tz),
              h.closed_at ? `${S.closed} ${localFmt(h.closed_at, tz)}${h.closed_reason ? ' · ' + h.closed_reason : ''}` : { text: S.open, color: RED },
              `${h.acknowledged_at ? `${localFmt(h.acknowledged_at, tz)} ${h.ack_by || ''}` : '—'}${h.ack_note ? ` · «${h.ack_note}»` : ''}${h.wo_id ? ` · ${S.work_order} #${h.wo_id} (${S.wo[h.wo_status] || h.wo_status})` : ''}`,
            ])],
        },
        layout: 'lightHorizontalLines', fontSize: 7.5, margin: [0, 4, 0, 10],
      }
    : { text: S.no_hints, italics: true, margin: [0, 4, 0, 10] };

  // ── work orders & service records ──
  const workRows = [
    ...d.work.orders.map(w => [localFmt(w.created_at, tz), `${S.work_order} #${w.id}`, `${w.title || ''}${w.closed_reason ? ' — ' + w.closed_reason : ''}`, `${S.wo[w.status] || w.status}${w.closed_at ? ' · ' + localFmt(w.closed_at, tz) : ''}`, w.assignee || '—']),
    ...d.work.records.map(r => [localFmt(r.service_date, tz, false), S.service_record, `${r.reason ? r.reason + ': ' : ''}${r.work_done || ''}${r.duration_min ? ` (${S.duration} ${fmtDuration(r.duration_min, S)})` : ''}${Array.isArray(r.parts) && r.parts.length ? ` · ${S.parts}: ${r.parts.map(p => p.name || p).join(', ')}` : ''}`, r.work_order_id ? `${S.work_order} #${r.work_order_id}` : '—', r.technician || '—']),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const workBlock = workRows.length
    ? {
        table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', 'auto'], body: [[S.time, S.col_kind, S.col_what, S.col_status, S.col_who].map(t => ({ text: t, bold: true })), ...workRows] },
        layout: 'lightHorizontalLines', fontSize: 7.5, margin: [0, 4, 0, 10],
      }
    : { text: S.no_work, italics: true, margin: [0, 4, 0, 10] };

  // ── engineering log ──
  const byTime = new Map(d.buckets.map(b => [b.time, b]));
  const stepMs = bucketSec * 1000;
  const start = Math.floor(from.getTime() / stepMs) * stepMs;
  const offlineIv = d.offline.map(o => [o.from, o.to]);
  const gapIv = d.gaps.map(g => [g.from, g.to]);
  const exIv = d.excursions.map(e => [e.start, e.end]);
  const cols = [S.col_time, `${S.ch.air} °C`, `${S.ch.evap} °C`, `${S.ch.cond} °C`, `${S.ch.setpoint} °C`, S.col_comp, S.col_defrost, S.col_note];
  const body = [cols.map(t => ({ text: t, bold: true, fontSize: 7.5 }))];
  const days = new Map();
  for (let t = start; t < to.getTime(); t += stepMs) {
    const b = byTime.get(new Date(t).toISOString());
    const { day, time } = localParts(t, tz);
    const v = (ch) => (b && b[ch] ? fmt1(b[ch].avg) : '—');
    const notes = [];
    if (overlaps(t, t + stepMs, offlineIv)) notes.push(S.note_offline);
    if (!b || overlaps(t, t + stepMs, gapIv)) notes.push(S.note_gap);
    if (overlaps(t, t + stepMs, d.doors)) notes.push(S.note_door);
    const dev = overlaps(t, t + stepMs, exIv);
    if (!days.has(day)) { days.set(day, true); body.push([{ text: localFmt(day + 'T12:00:00Z', 'UTC', false), colSpan: 8, bold: true, fillColor: DAY_BG, fontSize: 8 }, {}, {}, {}, {}, {}, {}, {}]); }
    const fill = dev ? RED_BG : (!b ? GREY_BG : undefined);
    const cell = (text, extra = {}) => ({ text, fillColor: fill, ...extra });
    body.push([
      cell(time), cell(v('air'), dev ? { bold: true, color: RED } : {}), cell(v('evap'), { color: GREY }), cell(v('cond'), { color: GREY }), cell(v('setpoint'), { color: GREY }),
      cell(b && b.comp ? String(Math.round(b.comp.avg * 100)) : '—', { color: GREY }),
      cell(b && b.defrost && b.defrost.avg > 0 ? S.yes : '', { color: GREY }),
      cell(notes.join(', '), { color: GREY, italics: true }),
    ]);
  }
  const logTable = {
    table: { headerRows: 1, widths: ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', '*'], body, dontBreakRows: true },
    layout: { hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3), vLineWidth: () => 0, hLineColor: () => '#9ca3af', paddingTop: () => 2, paddingBottom: () => 2 },
    fontSize: 7.5, margin: [0, 4, 0, 10],
  };

  return [
    ...head,
    { text: S.settings, style: 'subHeader' }, settingsBlock,
    { text: S.summary, style: 'subHeader' }, summaryTable, derivedLine,
    ...(svg ? [{ text: S.chart, style: 'subHeader' }] : []), ...chartBlock,
    { text: S.operation, style: 'subHeader' }, opBlock,
    { text: S.alarms, style: 'subHeader' }, alarmsBlock,
    { text: S.connectivity, style: 'subHeader' }, offlineBlock,
    { text: S.hints, style: 'subHeader' }, hintsBlock,
    { text: S.work, style: 'subHeader' }, workBlock,
    { text: `${S.log} (${bucketKey})`, style: 'subHeader' }, logTable,
  ];
}

function buildDocument({ kind, lang, tz, tenant, site, devices, from, to, bucketKey, bucketSec, source, generatedBy, generatedAt, code, hash, verifyUrl, doorMin }) {
  const S = strings(lang);
  const title = kind === 'site' ? S.site_title : S.title;
  const orgName = tenant.legal_name || tenant.name;
  const address = site ? [site.address_line, site.city, site.region, site.country].filter(Boolean).join(', ') : null;
  const meta = {
    columns: [
      { width: '*', text: [
        { text: `${S.organisation}: `, bold: true }, `${orgName}\n`,
        ...(tenant.brand_name ? [{ text: `${S.serviced_by}: `, bold: true }, `${tenant.brand_name}${tenant.brand_url ? ' · ' + tenant.brand_url : ''}\n`] : []),
        ...(site ? [{ text: `${S.site}: `, bold: true }, `${site.name}\n`, { text: `${S.address}: `, bold: true }, `${address || '—'}\n`] : []),
        { text: `${S.timezone}: `, bold: true }, tz,
      ] },
      { width: 'auto', alignment: 'right', text: [
        { text: `${S.period}: `, bold: true }, `${localFmt(from, tz)} — ${localFmt(to, tz)}\n`,
        { text: `${S.bucket}: `, bold: true }, `${bucketKey}\n`,
        { text: `${S.source}: `, bold: true }, `${source === 'hourly' ? S.source_hourly : S.source_raw}\n`,
        { text: `${S.generated}: `, bold: true }, `${localFmt(generatedAt, tz)} ${S.by} ${generatedBy}`,
      ] },
    ],
    margin: [0, 0, 0, 6],
  };
  const verifyBlock = {
    unbreakable: true,
    columns: [
      { width: '*', text: [{ text: `${S.verify}: `, bold: true }, `${S.verify_text} ${verifyUrl}\n`, { text: `${fmtCode(code)}   SHA-256 ${hash}`, fontSize: 7, color: '#555555' }], fontSize: 8, margin: [0, 6, 8, 0] },
      { width: 64, qr: verifyUrl, fit: 64, alignment: 'right' },
    ],
    margin: [0, 8, 0, 0],
  };
  return {
    docDefinition: {
      info: { title: `${title} — ${orgName}`, author: 'ModESP Cloud', subject: `${orgName} · ${localFmt(from, tz, false)} – ${localFmt(to, tz, false)}`, creator: 'ModESP Cloud', keywords: `service, ${code}` },
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
        { text: S.not_haccp, fontSize: 8, color: GREY, italics: true, margin: [0, 0, 0, 10] },
        ...devices.flatMap(d => deviceSection({ S, lang, tz, d, bucketKey, bucketSec, from, to, single: kind === 'device', doorMin })),
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

/**
 * Generate a service report; same contract as haccp.generate().
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
    kind, lang: STRINGS[lang] ? lang : 'uk', tz, tenant, site, devices: withData, from, to, bucketKey: plan.bucketKey, bucketSec: plan.bucketSec, source: plan.source,
    generatedBy, generatedAt, code, hash, verifyUrl: verifyUrlFor(code), doorMin,
  });
  const buffer = await render(docDefinition);
  await registerExport({
    query, code, kind, tenantId: tenant.id, deviceId: kind === 'device' ? devices[0].mqtt_device_id : null,
    siteId: site ? site.id : null, from, to, bucketKey: plan.bucketKey, source: plan.source, lang, hash, generatedBy, reportType: 'service', scheduleId,
  });
  return { buffer, code, hash, source: plan.source, bucketKey: plan.bucketKey, empty: false };
}

module.exports = {
  generate, strings, STRINGS,
  __test: { collectDevice, buildDocument, compressorStats, fetchOfflinePeriods, chartSvg, settingsRows, unitOf },
};
