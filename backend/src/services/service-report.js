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
 *
 * It opens with a conclusion built from those facts alone — the warmest
 * interval and what coincided with it, the HACCP verdict or that none is
 * possible without a limit, the event counts, and whether anything is still
 * open — and says it was generated from the device data, not from a look at
 * the product. The summary table is over raw measurements while the chart and
 * the log are interval averages; the note under the table says so, so a raw
 * maximum above every plotted point is not read as a chart with holes.
 */

const haccp = require('./haccp-report');
const { fetchSeries, summarize, stepOf, defrostIntervals, detectExcursions, detectGaps, limitsFor, toleranceOf, limitSentence,
        localParts, fmtDuration, fmtStep, tpl, num, fmt1, edgeNotes, dayTable, DEFAULT_EXCURSION_MIN, DEFAULT_DOOR_DELAY_MS, MAX_ROWS } = haccp.helpers;
const { localFmt, planSource, render, registerExport, verifyUrlFor, newCode, fmtCode, sha256 } = haccp;
const { EVENT_RETENTION_DAYS } = require('../lib/platform-defaults');

const CHANNELS = ['air', 'evap', 'cond', 'setpoint', 'comp', 'defrost'];
const TEMP_CHANNELS = ['air', 'evap', 'cond', 'setpoint'];
const RAW_LIMIT = 300000;

const STRINGS = {
  uk: {
    title: 'Сервісний звіт обладнання', site_title: 'Сервісний звіт точки',
    organisation: 'Організація', tax_id: 'Код ЄДРПОУ/ІПН', serviced_by: 'Обслуговує', site: 'Точка', address: 'Адреса', timezone: 'Часовий пояс',
    period: 'Період', bucket: 'Інтервал', generated: 'Сформовано', by: 'ким', source: 'Джерело даних', source_raw: 'первинні вимірювання приладу', source_hourly: 'погодинний архів',
    not_haccp: 'Технічний документ для сервісу; для інспектора призначений журнал контролю температури (HACCP).',
    device: 'Обладнання', device_id: 'Ідентифікатор', serial: 'Серійний номер', model: 'Модель', firmware: 'Прошивка', last_data: 'Останні дані за період', product: 'Продукція',
    settings: 'Налаштування приладу (останній стан)', no_settings: 'стан приладу ще не отримано',
    keys: { 'thermostat.setpoint': 'Уставка', 'thermostat.differential': 'Диференціал', 'protection.high_limit': 'Верхня межа температури', 'protection.low_limit': 'Нижня межа температури', 'protection.high_alarm_delay': 'Затримка аварії високої температури', 'protection.low_alarm_delay': 'Затримка аварії низької температури', 'protection.door_delay': 'Затримка аварії дверей', 'thermostat.min_off_time': 'Мін. пауза компресора', 'thermostat.min_on_time': 'Мін. робота компресора', 'thermostat.night_setback': 'Нічний зсув уставки', 'defrost.interval': 'Інтервал відтайки', 'defrost.max_duration': 'Макс. тривалість відтайки', 'defrost.termination': 'Завершення відтайки', 'protection.max_starts_hour': 'Макс. пусків за годину', 'protection.max_continuous_run': 'Макс. безперервна робота', 'protection.pulldown_min_drop': 'Мін. зниження температури', 'protection.max_rise_rate': 'Макс. швидкість зростання' },
    on_short: 'увімк.', off_short: 'вимк.',
    units: { c: '°C', min: 'хв', h: 'год', s: 'с', per_h: 'разів/год', c_per_min: '°C/хв' },
    options: { 'defrost.termination': { 0: 'За температурою', 1: 'За таймером', temp: 'За температурою', timer: 'За таймером' } },
    haccp_limit: 'Критична межа HACCP', excursion_rule: 'відхилення — довше ніж {0} хв за межею, відтайка не враховується',
    summary: 'Температури за період', channel: 'Канал', min: 'Мін °C', max: 'Макс °C', avg: 'Сер. °C', samples: 'Вимірювань',
    summary_note: 'Мін/макс/сер. — по всіх первинних вимірюваннях за період (кожні {0}); графік та інженерний журнал показують середнє за інтервал {1}, тому короткі піки на них згладжені.',
    summary_note_hourly: 'Мін/макс — по погодинному архіву (мін/макс кожної години); графік та інженерний журнал показують середнє за інтервал {0}.',
    ch: { air: 'Повітря', evap: 'Випарник', cond: 'Конденсатор', setpoint: 'Уставка', comp: 'Компресор', defrost: 'Відтайка' },
    delta_t: 'ΔT повітря − випарник (сер.)', cond_max: 'Конденсатор, макс.',
    channels_absent: 'Канали {0} за цей період відсутні: їх або не передає прилад, або період старший за термін зберігання інженерних каналів (повітря і відтайка зберігаються довше — їх потребує HACCP-журнал).',
    chart: 'Графік (середнє за {0})', legend_air: 'синя — повітря', legend_evap: 'зелена — випарник', legend_setpoint: 'сіра пунктирна — уставка', legend_limit: 'червона пунктирна — межа HACCP',
    operation: 'Робота обладнання', comp_duty: 'Компресор: частка часу', comp_starts: 'Пусків компресора', comp_longest: 'Найдовша робота без зупинки', comp_per_hour: 'пусків/год',
    defrost_cycles: 'Циклів відтайки', defrost_total: 'Загальна тривалість відтайки', defrost_avg: 'Середня тривалість відтайки',
    door_events: 'Тривог дверей', door_total: 'Двері відчинені (сумарно, за тривогами)',
    offline_periods: 'Періодів офлайн', offline_total: 'Офлайн сумарно', gaps: 'Розривів запису', gaps_total: 'Розриви сумарно',
    excursions: 'Відхилень HACCP', excursions_total: 'Відхилення сумарно', none: 'немає', nd: 'н/д', nd_no_limit: 'н/д — межу не задано',
    alarms: 'Тривоги за період', no_alarms: 'Тривог за період не зафіксовано.',
    time: 'Час', event: 'Подія', severity: 'Важливість', value: 'Значення', limit: 'межа', cleared: 'Знято', active: 'Активна', ack: 'Підтверджено', note: 'нотатка', work_order: 'Наряд',
    sev: { critical: 'критична', warning: 'попередження', info: 'інформація' },
    connectivity: 'Звʼязок із хмарою', no_offline: 'Втрат звʼязку за період не зафіксовано.', offline_not_retained: 'Журнал подій за цей період уже не зберігається, тож про втрати звʼязку сказати нічого.', col_from: 'З', col_to: 'По', col_duration: 'Тривалість', still_offline: 'досі офлайн',
    hints: 'Рекомендації з обслуговування', no_hints: 'Рекомендацій за період немає.', hint_names: { alarm_repeat: 'Аварія повторюється' },
    col_rule: 'Правило', col_opened: 'Відкрито', col_closed: 'Закрито', col_status: 'Стан', open: 'відкрита', closed: 'закрита',
    work: 'Наряди й сервісні записи', no_work: 'Нарядів і сервісних записів за період немає.', col_kind: 'Тип', col_what: 'Що зроблено / назва', col_who: 'Хто', service_record: 'Сервісний запис', parts: 'запчастини', duration: 'тривалість',
    wo: { new: 'новий', assigned: 'призначено', in_progress: 'у роботі', done: 'виконано', cancelled: 'скасовано' },
    log: 'Інженерний журнал', col_time: 'Час', col_comp: 'Компр. %', col_defrost: 'Відтайка', col_note: 'Примітка', note_offline: 'офлайн', note_gap: 'розрив', note_door: 'двері', yes: 'так',
    note_from: 'з {0}', note_to: 'до {0}', partial_note: 'Інтервал, який період покриває лише частково, позначено в примітці («з …», «до …»); його значення обчислено за наявну частину.',
    conclusion: 'Висновок за період',
    c_peak: 'Найвища температура повітря в журналі — {0} °C ({1}, середнє за інтервал): {2}.',
    c_peak_defrost: 'під час відтайки', c_peak_door: 'при тривозі дверей', c_peak_offline: 'у період офлайн', c_peak_excursion: 'у межах відхилення HACCP', c_peak_plain: 'поза відтайкою, тривогами дверей і звʼязку — причина з даних не видна',
    c_next: 'Наступний інтервал: {0} °C.',
    c_excursions: 'Відхилень HACCP: {0} ({1}).', c_excursions_none: 'Відхилень HACCP не зафіксовано.', c_excursions_no_limit: 'Відхилення HACCP оцінити неможливо — критичну межу не задано; задайте її в картці обладнання.',
    c_events: 'Тривог: {0} (активних на кінець періоду: {1}) · тривог дверей: {2} · періодів офлайн: {3} · розривів запису: {4}.',
    c_events_none: 'Тривог, періодів офлайн і розривів запису за період не було.',
    c_action_needed: 'Дія потрібна: {0}.', c_action_check: 'На розсуд техніка: події періоду завершилися самі, але варто переглянути їхню причину.', c_action_none: 'Дія не потрібна за даними періоду.',
    c_reason_alarm: 'активна тривога', c_reason_excursion: 'відхилення HACCP', c_reason_hint: 'відкрита рекомендація з обслуговування', c_reason_offline: 'прилад досі офлайн', c_reason_wo: 'незавершений наряд',
    c_auto: 'Висновок сформовано автоматично за даними приладу; він не оцінює стан продукції та не замінює огляд техніка.',
    min_short: 'хв', h_short: 'год', d_short: 'дн', s_short: 'с', pct: '%',
    verify: 'Перевірка автентичності', verify_text: 'SHA-256 обчислено з даних звіту — періоду, обладнання, кожного рядка журналу, тривог, періодів офлайн і показників компресора, — а не з файлу PDF. За кодом перевірки платформа показує, коли, ким і за який період сформовано звіт, і той самий SHA-256: збіг означає, що дані не змінювалися. Перевірити:',
    page: 'Сторінка', of: 'з', no_data: 'Дані за період відсутні',
  },
  en: {
    title: 'Equipment Service Report', site_title: 'Site Service Report',
    organisation: 'Organisation', tax_id: 'Tax ID', serviced_by: 'Serviced by', site: 'Site', address: 'Address', timezone: 'Time zone',
    period: 'Period', bucket: 'Interval', generated: 'Generated', by: 'by', source: 'Data source', source_raw: 'raw measurements of the device', source_hourly: 'hourly archive',
    not_haccp: 'A technical document for service; the inspector gets the HACCP temperature control log instead.',
    device: 'Equipment', device_id: 'Identifier', serial: 'Serial number', model: 'Model', firmware: 'Firmware', last_data: 'Last data in the period', product: 'Product',
    settings: 'Controller settings (last state)', no_settings: 'no state received from the device yet',
    keys: { 'thermostat.setpoint': 'Setpoint', 'thermostat.differential': 'Differential', 'protection.high_limit': 'Alarm limit, high', 'protection.low_limit': 'Alarm limit, low', 'protection.high_alarm_delay': 'Alarm delay, high', 'protection.low_alarm_delay': 'Alarm delay, low', 'protection.door_delay': 'Door alarm delay', 'thermostat.min_off_time': 'Min compressor off time', 'thermostat.min_on_time': 'Min compressor on time', 'thermostat.night_setback': 'Night setback', 'defrost.interval': 'Defrost interval', 'defrost.max_duration': 'Max defrost duration', 'defrost.termination': 'Defrost termination', 'protection.max_starts_hour': 'Max starts per hour', 'protection.max_continuous_run': 'Max continuous run', 'protection.pulldown_min_drop': 'Min pull-down drop', 'protection.max_rise_rate': 'Max rise rate' },
    on_short: 'on', off_short: 'off',
    units: { c: '°C', min: 'min', h: 'h', s: 's', per_h: '/h', c_per_min: '°C/min' },
    options: { 'defrost.termination': { 0: 'By temperature', 1: 'By timer', temp: 'By temperature', timer: 'By timer' } },
    haccp_limit: 'HACCP critical limit', excursion_rule: 'excursion — longer than {0} min past the limit, defrost excluded',
    summary: 'Temperatures over the period', channel: 'Channel', min: 'Min °C', max: 'Max °C', avg: 'Avg °C', samples: 'Samples',
    summary_note: 'Min/max/avg are over all raw measurements of the period (every {0}); the chart and the engineering log show the {1} interval average, so short peaks are smoothed there.',
    summary_note_hourly: 'Min/max are from the hourly archive (min/max of every hour); the chart and the engineering log show the {0} interval average.',
    ch: { air: 'Air', evap: 'Evaporator', cond: 'Condenser', setpoint: 'Setpoint', comp: 'Compressor', defrost: 'Defrost' },
    delta_t: 'ΔT air − evaporator (avg)', cond_max: 'Condenser, max',
    channels_absent: 'Channels {0} are absent for this period: either the controller does not report them, or the period predates the retention of the engineering channels (air and defrost are kept longer — the HACCP journal needs them).',
    chart: 'Chart ({0} average)', legend_air: 'blue — air', legend_evap: 'green — evaporator', legend_setpoint: 'grey dashed — setpoint', legend_limit: 'red dashed — HACCP limit',
    operation: 'Equipment operation', comp_duty: 'Compressor: share of time', comp_starts: 'Compressor starts', comp_longest: 'Longest uninterrupted run', comp_per_hour: 'starts/h',
    defrost_cycles: 'Defrost cycles', defrost_total: 'Total defrost time', defrost_avg: 'Average defrost duration',
    door_events: 'Door alarms', door_total: 'Door open (total, by alarms)',
    offline_periods: 'Offline periods', offline_total: 'Offline total', gaps: 'Recording gaps', gaps_total: 'Gaps total',
    excursions: 'HACCP excursions', excursions_total: 'Excursions total', none: 'none', nd: 'n/a', nd_no_limit: 'n/a — no limit set',
    alarms: 'Alarms during the period', no_alarms: 'No alarms during the period.',
    time: 'Time', event: 'Event', severity: 'Severity', value: 'Value', limit: 'limit', cleared: 'Cleared', active: 'Active', ack: 'Acknowledged', note: 'note', work_order: 'Work order',
    sev: { critical: 'critical', warning: 'warning', info: 'info' },
    connectivity: 'Cloud connectivity', no_offline: 'No connectivity losses during the period.', offline_not_retained: 'The event log no longer covers this period, so nothing can be said about connectivity losses.', col_from: 'From', col_to: 'To', col_duration: 'Duration', still_offline: 'still offline',
    hints: 'Maintenance hints', no_hints: 'No hints during the period.', hint_names: { alarm_repeat: 'Recurring alarm' },
    col_rule: 'Rule', col_opened: 'Opened', col_closed: 'Closed', col_status: 'State', open: 'open', closed: 'closed',
    work: 'Work orders and service records', no_work: 'No work orders or service records during the period.', col_kind: 'Kind', col_what: 'Work done / title', col_who: 'Who', service_record: 'Service record', parts: 'parts', duration: 'duration',
    wo: { new: 'new', assigned: 'assigned', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' },
    log: 'Engineering log', col_time: 'Time', col_comp: 'Comp. %', col_defrost: 'Defrost', col_note: 'Note', note_offline: 'offline', note_gap: 'gap', note_door: 'door', yes: 'yes',
    note_from: 'from {0}', note_to: 'until {0}', partial_note: 'An interval the period covers only partly is marked in the note («from …», «until …»); its value is computed from the covered part.',
    conclusion: 'Conclusion for the period',
    c_peak: 'Highest air temperature in the log — {0} °C ({1}, interval average): {2}.',
    c_peak_defrost: 'during defrost', c_peak_door: 'during a door alarm', c_peak_offline: 'during an offline period', c_peak_excursion: 'within a HACCP excursion', c_peak_plain: 'outside defrost, door and connectivity events — no cause is visible in the data',
    c_next: 'Next interval: {0} °C.',
    c_excursions: 'HACCP excursions: {0} ({1}).', c_excursions_none: 'No HACCP excursions recorded.', c_excursions_no_limit: 'HACCP excursions cannot be assessed — no critical limit is set; set it on the equipment card.',
    c_events: 'Alarms: {0} (active at the end of the period: {1}) · door alarms: {2} · offline periods: {3} · recording gaps: {4}.',
    c_events_none: 'No alarms, offline periods or recording gaps during the period.',
    c_action_needed: 'Action needed: {0}.', c_action_check: "At the technician's discretion: the events of the period ended on their own, but their cause is worth a look.", c_action_none: 'No action needed on the data of the period.',
    c_reason_alarm: 'an active alarm', c_reason_excursion: 'a HACCP excursion', c_reason_hint: 'an open maintenance hint', c_reason_offline: 'the device is still offline', c_reason_wo: 'an unfinished work order',
    c_auto: "This conclusion is generated automatically from the device data; it does not assess the product and does not replace a technician's inspection.",
    min_short: 'min', h_short: 'h', d_short: 'd', s_short: 's', pct: '%',
    verify: 'Authenticity check', verify_text: 'The SHA-256 is computed from the report data — the period, the equipment, every log row, the alarms, the offline periods and the compressor figures — not from the PDF file. By the verification code the platform shows when, by whom and for which period the report was generated, and the same SHA-256: a match means the data has not been altered. Verify at:',
    page: 'Page', of: 'of', no_data: 'No data for the period',
  },
  pl: {
    title: 'Raport serwisowy urządzenia', site_title: 'Raport serwisowy lokalizacji',
    organisation: 'Organizacja', tax_id: 'NIP', serviced_by: 'Obsługuje', site: 'Lokalizacja', address: 'Adres', timezone: 'Strefa czasowa',
    period: 'Okres', bucket: 'Interwał', generated: 'Wygenerowano', by: 'przez', source: 'Źródło danych', source_raw: 'pomiary surowe urządzenia', source_hourly: 'archiwum godzinowe',
    not_haccp: 'Dokument techniczny dla serwisu; dla inspektora przeznaczony jest dziennik kontroli temperatury (HACCP).',
    device: 'Urządzenie', device_id: 'Identyfikator', serial: 'Numer seryjny', model: 'Model', firmware: 'Firmware', last_data: 'Ostatnie dane w okresie', product: 'Produkt',
    settings: 'Ustawienia sterownika (ostatni stan)', no_settings: 'stan urządzenia nie został jeszcze odebrany',
    keys: { 'thermostat.setpoint': 'Nastawa', 'thermostat.differential': 'Różnica (histereza)', 'protection.high_limit': 'Limit alarmu, górny', 'protection.low_limit': 'Limit alarmu, dolny', 'protection.high_alarm_delay': 'Opóźnienie alarmu, górne', 'protection.low_alarm_delay': 'Opóźnienie alarmu, dolne', 'protection.door_delay': 'Opóźnienie alarmu drzwi', 'thermostat.min_off_time': 'Min. przerwa sprężarki', 'thermostat.min_on_time': 'Min. praca sprężarki', 'thermostat.night_setback': 'Nocne przesunięcie', 'defrost.interval': 'Interwał odszraniania', 'defrost.max_duration': 'Maks. czas odszraniania', 'defrost.termination': 'Zakończenie odszraniania', 'protection.max_starts_hour': 'Maks. startów na godzinę', 'protection.max_continuous_run': 'Maks. praca ciągła', 'protection.pulldown_min_drop': 'Min. spadek przy schładzaniu', 'protection.max_rise_rate': 'Maks. tempo wzrostu' },
    on_short: 'wł.', off_short: 'wył.',
    units: { c: '°C', min: 'min', h: 'godz', s: 's', per_h: 'razy/godz', c_per_min: '°C/min' },
    options: { 'defrost.termination': { 0: 'Wg temperatury', 1: 'Wg timera', temp: 'Wg temperatury', timer: 'Wg timera' } },
    haccp_limit: 'Limit krytyczny HACCP', excursion_rule: 'odchylenie — dłużej niż {0} min poza limitem, odszranianie wyłączone',
    summary: 'Temperatury w okresie', channel: 'Kanał', min: 'Min °C', max: 'Maks °C', avg: 'Śr. °C', samples: 'Pomiary',
    summary_note: 'Min/maks/śr. — ze wszystkich pomiarów surowych w okresie (co {0}); wykres i dziennik inżynierski pokazują średnią z interwału {1}, więc krótkie piki są na nich wygładzone.',
    summary_note_hourly: 'Min/maks — z archiwum godzinowego (min/maks każdej godziny); wykres i dziennik inżynierski pokazują średnią z interwału {0}.',
    ch: { air: 'Powietrze', evap: 'Parownik', cond: 'Skraplacz', setpoint: 'Nastawa', comp: 'Sprężarka', defrost: 'Odszranianie' },
    delta_t: 'ΔT powietrze − parownik (śr.)', cond_max: 'Skraplacz, maks.',
    channels_absent: 'Kanały {0} są nieobecne w tym okresie: albo sterownik ich nie przesyła, albo okres jest starszy niż czas przechowywania kanałów inżynierskich (powietrze i odszranianie są przechowywane dłużej — potrzebuje ich dziennik HACCP).',
    chart: 'Wykres (średnia z {0})', legend_air: 'niebieska — powietrze', legend_evap: 'zielona — parownik', legend_setpoint: 'szara przerywana — nastawa', legend_limit: 'czerwona przerywana — limit HACCP',
    operation: 'Praca urządzenia', comp_duty: 'Sprężarka: udział czasu', comp_starts: 'Startów sprężarki', comp_longest: 'Najdłuższa praca bez przerwy', comp_per_hour: 'startów/h',
    defrost_cycles: 'Cykli odszraniania', defrost_total: 'Łączny czas odszraniania', defrost_avg: 'Średni czas odszraniania',
    door_events: 'Alarmów drzwi', door_total: 'Drzwi otwarte (łącznie, wg alarmów)',
    offline_periods: 'Okresów offline', offline_total: 'Offline łącznie', gaps: 'Przerw w zapisie', gaps_total: 'Przerwy łącznie',
    excursions: 'Odchyleń HACCP', excursions_total: 'Odchylenia łącznie', none: 'brak', nd: 'b/d', nd_no_limit: 'b/d — nie ustawiono limitu',
    alarms: 'Alarmy w okresie', no_alarms: 'Brak alarmów w okresie.',
    time: 'Czas', event: 'Zdarzenie', severity: 'Ważność', value: 'Wartość', limit: 'limit', cleared: 'Zakończony', active: 'Aktywny', ack: 'Potwierdzony', note: 'uwaga', work_order: 'Zlecenie',
    sev: { critical: 'krytyczny', warning: 'ostrzeżenie', info: 'informacja' },
    connectivity: 'Łączność z chmurą', no_offline: 'Brak utrat łączności w okresie.', offline_not_retained: 'Dziennik zdarzeń nie obejmuje już tego okresu, więc o utratach łączności nic nie można powiedzieć.', col_from: 'Od', col_to: 'Do', col_duration: 'Czas trwania', still_offline: 'nadal offline',
    hints: 'Wskazówki serwisowe', no_hints: 'Brak wskazówek w okresie.', hint_names: { alarm_repeat: 'Alarm się powtarza' },
    col_rule: 'Reguła', col_opened: 'Otwarto', col_closed: 'Zamknięto', col_status: 'Stan', open: 'otwarta', closed: 'zamknięta',
    work: 'Zlecenia i wpisy serwisowe', no_work: 'Brak zleceń i wpisów serwisowych w okresie.', col_kind: 'Rodzaj', col_what: 'Wykonano / tytuł', col_who: 'Kto', service_record: 'Wpis serwisowy', parts: 'części', duration: 'czas',
    wo: { new: 'nowe', assigned: 'przydzielone', in_progress: 'w toku', done: 'wykonane', cancelled: 'anulowane' },
    log: 'Dziennik inżynierski', col_time: 'Czas', col_comp: 'Spręż. %', col_defrost: 'Odszr.', col_note: 'Uwaga', note_offline: 'offline', note_gap: 'przerwa', note_door: 'drzwi', yes: 'tak',
    note_from: 'od {0}', note_to: 'do {0}', partial_note: 'Interwał, który okres obejmuje tylko częściowo, jest oznaczony w uwadze („od …”, „do …”); jego wartość obliczono z objętej części.',
    conclusion: 'Wniosek za okres',
    c_peak: 'Najwyższa temperatura powietrza w dzienniku — {0} °C ({1}, średnia z interwału): {2}.',
    c_peak_defrost: 'podczas odszraniania', c_peak_door: 'podczas alarmu drzwi', c_peak_offline: 'w okresie offline', c_peak_excursion: 'w ramach odchylenia HACCP', c_peak_plain: 'poza odszranianiem, alarmami drzwi i łączności — przyczyna nie wynika z danych',
    c_next: 'Następny interwał: {0} °C.',
    c_excursions: 'Odchyleń HACCP: {0} ({1}).', c_excursions_none: 'Nie odnotowano odchyleń HACCP.', c_excursions_no_limit: 'Odchyleń HACCP nie można ocenić — nie ustawiono limitu krytycznego; ustaw go w karcie urządzenia.',
    c_events: 'Alarmów: {0} (aktywnych na koniec okresu: {1}) · alarmów drzwi: {2} · okresów offline: {3} · przerw w zapisie: {4}.',
    c_events_none: 'W okresie nie było alarmów, okresów offline ani przerw w zapisie.',
    c_action_needed: 'Wymagane działanie: {0}.', c_action_check: 'Do oceny technika: zdarzenia okresu zakończyły się same, ale warto sprawdzić ich przyczynę.', c_action_none: 'Według danych okresu działanie nie jest wymagane.',
    c_reason_alarm: 'aktywny alarm', c_reason_excursion: 'odchylenie HACCP', c_reason_hint: 'otwarta wskazówka serwisowa', c_reason_offline: 'urządzenie nadal offline', c_reason_wo: 'niezakończone zlecenie',
    c_auto: 'Wniosek wygenerowano automatycznie z danych urządzenia; nie ocenia on stanu produktu i nie zastępuje przeglądu technika.',
    min_short: 'min', h_short: 'h', d_short: 'dn', s_short: 's', pct: '%',
    verify: 'Weryfikacja autentyczności', verify_text: 'SHA-256 obliczono z danych raportu — okresu, urządzenia, każdego wiersza dziennika, alarmów, okresów offline i wskaźników sprężarki — a nie z pliku PDF. Po kodzie weryfikacyjnym platforma pokazuje, kiedy, przez kogo i za jaki okres wygenerowano raport, oraz ten sam SHA-256: zgodność oznacza, że dane nie zostały zmienione. Sprawdź:',
    page: 'Strona', of: 'z', no_data: 'Brak danych za okres',
  },
  de: {
    title: 'Servicebericht der Anlage', site_title: 'Servicebericht des Standorts',
    organisation: 'Organisation', tax_id: 'Steuernummer', serviced_by: 'Betreut von', site: 'Standort', address: 'Adresse', timezone: 'Zeitzone',
    period: 'Zeitraum', bucket: 'Intervall', generated: 'Erstellt', by: 'von', source: 'Datenquelle', source_raw: 'Rohmessungen des Geräts', source_hourly: 'Stundenarchiv',
    not_haccp: 'Technisches Dokument für den Service; der Prüfer erhält das HACCP-Temperaturkontrollprotokoll.',
    device: 'Anlage', device_id: 'Kennung', serial: 'Seriennummer', model: 'Modell', firmware: 'Firmware', last_data: 'Letzte Daten im Zeitraum', product: 'Produkt',
    settings: 'Reglereinstellungen (letzter Zustand)', no_settings: 'noch kein Zustand vom Gerät empfangen',
    keys: { 'thermostat.setpoint': 'Sollwert', 'thermostat.differential': 'Differenz (Hysterese)', 'protection.high_limit': 'Alarmgrenze, oben', 'protection.low_limit': 'Alarmgrenze, unten', 'protection.high_alarm_delay': 'Alarmverzögerung, oben', 'protection.low_alarm_delay': 'Alarmverzögerung, unten', 'protection.door_delay': 'Türalarm-Verzögerung', 'thermostat.min_off_time': 'Min. Verdichterpause', 'thermostat.min_on_time': 'Min. Verdichterlaufzeit', 'thermostat.night_setback': 'Nachtabsenkung', 'defrost.interval': 'Abtauintervall', 'defrost.max_duration': 'Max. Abtaudauer', 'defrost.termination': 'Abtauende', 'protection.max_starts_hour': 'Max. Starts pro Stunde', 'protection.max_continuous_run': 'Max. Dauerlauf', 'protection.pulldown_min_drop': 'Min. Abkühlung beim Anlauf', 'protection.max_rise_rate': 'Max. Anstiegsrate' },
    on_short: 'ein', off_short: 'aus',
    units: { c: '°C', min: 'min', h: 'h', s: 's', per_h: 'mal/h', c_per_min: '°C/min' },
    options: { 'defrost.termination': { 0: 'Nach Temperatur', 1: 'Nach Timer', temp: 'Nach Temperatur', timer: 'Nach Timer' } },
    haccp_limit: 'Kritischer HACCP-Grenzwert', excursion_rule: 'Abweichung — länger als {0} Min. außerhalb des Grenzwerts, Abtauung ausgenommen',
    summary: 'Temperaturen im Zeitraum', channel: 'Kanal', min: 'Min °C', max: 'Max °C', avg: 'Mittel °C', samples: 'Messungen',
    summary_note: 'Min/Max/Mittel gelten über alle Rohmessungen des Zeitraums (alle {0}); Diagramm und technisches Protokoll zeigen das Intervallmittel über {1}, kurze Spitzen sind dort daher geglättet.',
    summary_note_hourly: 'Min/Max stammen aus dem Stundenarchiv (Min/Max jeder Stunde); Diagramm und technisches Protokoll zeigen das Intervallmittel über {0}.',
    ch: { air: 'Luft', evap: 'Verdampfer', cond: 'Verflüssiger', setpoint: 'Sollwert', comp: 'Verdichter', defrost: 'Abtauung' },
    delta_t: 'ΔT Luft − Verdampfer (Mittel)', cond_max: 'Verflüssiger, max.',
    channels_absent: 'Die Kanäle {0} fehlen für diesen Zeitraum: Entweder meldet der Regler sie nicht, oder der Zeitraum liegt vor der Aufbewahrungsfrist der technischen Kanäle (Luft und Abtauung werden länger gespeichert — das HACCP-Protokoll braucht sie).',
    chart: 'Diagramm (Mittel über {0})', legend_air: 'blau — Luft', legend_evap: 'grün — Verdampfer', legend_setpoint: 'grau gestrichelt — Sollwert', legend_limit: 'rot gestrichelt — HACCP-Grenzwert',
    operation: 'Betrieb der Anlage', comp_duty: 'Verdichter: Zeitanteil', comp_starts: 'Verdichterstarts', comp_longest: 'Längster Lauf ohne Pause', comp_per_hour: 'Starts/h',
    defrost_cycles: 'Abtauzyklen', defrost_total: 'Abtauzeit gesamt', defrost_avg: 'Mittlere Abtaudauer',
    door_events: 'Türalarme', door_total: 'Tür offen (gesamt, laut Alarmen)',
    offline_periods: 'Offline-Zeiträume', offline_total: 'Offline gesamt', gaps: 'Aufzeichnungslücken', gaps_total: 'Lücken gesamt',
    excursions: 'HACCP-Abweichungen', excursions_total: 'Abweichungen gesamt', none: 'keine', nd: 'k. A.', nd_no_limit: 'k. A. — kein Grenzwert festgelegt',
    alarms: 'Alarme im Zeitraum', no_alarms: 'Keine Alarme im Zeitraum.',
    time: 'Zeit', event: 'Ereignis', severity: 'Schwere', value: 'Wert', limit: 'Grenze', cleared: 'Beendet', active: 'Aktiv', ack: 'Bestätigt', note: 'Notiz', work_order: 'Auftrag',
    sev: { critical: 'kritisch', warning: 'Warnung', info: 'Info' },
    connectivity: 'Cloud-Verbindung', no_offline: 'Keine Verbindungsverluste im Zeitraum.', offline_not_retained: 'Das Ereignisprotokoll deckt diesen Zeitraum nicht mehr ab; zu Verbindungsverlusten lässt sich daher nichts sagen.', col_from: 'Von', col_to: 'Bis', col_duration: 'Dauer', still_offline: 'noch offline',
    hints: 'Wartungshinweise', no_hints: 'Keine Hinweise im Zeitraum.', hint_names: { alarm_repeat: 'Alarm wiederholt sich' },
    col_rule: 'Regel', col_opened: 'Eröffnet', col_closed: 'Geschlossen', col_status: 'Status', open: 'offen', closed: 'geschlossen',
    work: 'Aufträge und Serviceeinträge', no_work: 'Keine Aufträge und Serviceeinträge im Zeitraum.', col_kind: 'Art', col_what: 'Erledigt / Titel', col_who: 'Wer', service_record: 'Serviceeintrag', parts: 'Teile', duration: 'Dauer',
    wo: { new: 'neu', assigned: 'zugewiesen', in_progress: 'in Arbeit', done: 'erledigt', cancelled: 'storniert' },
    log: 'Technisches Protokoll', col_time: 'Zeit', col_comp: 'Verd. %', col_defrost: 'Abtau.', col_note: 'Bemerkung', note_offline: 'offline', note_gap: 'Lücke', note_door: 'Tür', yes: 'ja',
    note_from: 'ab {0}', note_to: 'bis {0}', partial_note: 'Ein Intervall, das der Zeitraum nur teilweise abdeckt, ist in der Bemerkung gekennzeichnet („ab …“, „bis …“); sein Wert ist aus dem abgedeckten Teil berechnet.',
    conclusion: 'Fazit für den Zeitraum',
    c_peak: 'Höchste Lufttemperatur im Protokoll — {0} °C ({1}, Intervallmittel): {2}.',
    c_peak_defrost: 'während der Abtauung', c_peak_door: 'während eines Türalarms', c_peak_offline: 'in einem Offline-Zeitraum', c_peak_excursion: 'innerhalb einer HACCP-Abweichung', c_peak_plain: 'außerhalb von Abtauung, Tür- und Verbindungsereignissen — aus den Daten ist keine Ursache ersichtlich',
    c_next: 'Nächstes Intervall: {0} °C.',
    c_excursions: 'HACCP-Abweichungen: {0} ({1}).', c_excursions_none: 'Keine HACCP-Abweichungen festgestellt.', c_excursions_no_limit: 'HACCP-Abweichungen sind nicht bewertbar — kein kritischer Grenzwert festgelegt; legen Sie ihn in der Anlagenkarte fest.',
    c_events: 'Alarme: {0} (am Ende des Zeitraums aktiv: {1}) · Türalarme: {2} · Offline-Zeiträume: {3} · Aufzeichnungslücken: {4}.',
    c_events_none: 'Keine Alarme, Offline-Zeiträume oder Aufzeichnungslücken im Zeitraum.',
    c_action_needed: 'Handlungsbedarf: {0}.', c_action_check: 'Nach Ermessen des Technikers: Die Ereignisse des Zeitraums endeten von selbst, ihre Ursache ist aber einen Blick wert.', c_action_none: 'Nach den Daten des Zeitraums kein Handlungsbedarf.',
    c_reason_alarm: 'ein aktiver Alarm', c_reason_excursion: 'eine HACCP-Abweichung', c_reason_hint: 'ein offener Wartungshinweis', c_reason_offline: 'das Gerät ist noch offline', c_reason_wo: 'ein nicht abgeschlossener Auftrag',
    c_auto: 'Das Fazit wird automatisch aus den Gerätedaten erstellt; es bewertet nicht den Zustand der Ware und ersetzt keine Prüfung durch den Techniker.',
    min_short: 'Min.', h_short: 'Std.', d_short: 'Tg.', s_short: 's', pct: '%',
    verify: 'Echtheitsprüfung', verify_text: 'Der SHA-256 wird aus den Berichtsdaten berechnet — Zeitraum, Anlage, jede Protokollzeile, Alarme, Offline-Zeiträume und Verdichterkennzahlen —, nicht aus der PDF-Datei. Über den Prüfcode zeigt die Plattform, wann, von wem und für welchen Zeitraum der Bericht erstellt wurde, sowie denselben SHA-256: Übereinstimmung bedeutet, dass die Daten unverändert sind. Prüfen unter:',
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
  // The newest measurement inside the period, for the header: a fact of this
  // document rather than a `devices` column the caller may not have loaded.
  const lastData = airPts.length ? airPts[airPts.length - 1].t + (raw.hourly ? 3600e3 : 0) : null;
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
           defrost, excursions, gaps, comp, offline, alarms, hints, work, doors, lastData };
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
/** on/off in the report's language; the named choice of a mode parameter; the number otherwise */
function fmtState(S, key, v) {
  if (typeof v === 'boolean') return v ? S.on_short : S.off_short;
  if (v === null || v === undefined) return '—';
  const named = S.options && S.options[key] && S.options[key][String(v)];
  return named || String(v);
}

/**
 * Unit code of a controller parameter — the same table as PARAM_UNITS in the
 * WebUI (webui/src/lib/meta.js), taken from the controller's module manifests
 * rather than guessed from the key name: cond_fan_delay, valve_delay and
 * min_compressor_run are seconds, max_rise_rate is °C per minute,
 * max_starts_hour a count. S.units[code] is the text in the report's language.
 */
const PARAM_UNITS = {
  'protection.high_limit': 'c', 'protection.low_limit': 'c', 'protection.pulldown_min_drop': 'c',
  'protection.high_alarm_delay': 'min', 'protection.low_alarm_delay': 'min', 'protection.door_delay': 'min',
  'protection.post_defrost_delay': 'min', 'protection.max_continuous_run': 'min', 'protection.pulldown_timeout': 'min',
  'protection.rate_duration': 'min',
  'protection.min_compressor_run': 's',
  'protection.max_starts_hour': 'per_h',
  'protection.max_rise_rate': 'c_per_min',
  'protection.compressor_hours': 'h',
  'thermostat.setpoint': 'c', 'thermostat.differential': 'c', 'thermostat.fan_stop_temp': 'c',
  'thermostat.fan_stop_hyst': 'c', 'thermostat.night_setback': 'c',
  'thermostat.min_off_time': 'min', 'thermostat.min_on_time': 'min', 'thermostat.startup_delay': 'min',
  'thermostat.safety_run_on': 'min', 'thermostat.safety_run_off': 'min',
  'thermostat.cond_fan_delay': 's',
  'thermostat.night_start': 'h', 'thermostat.night_end': 'h',
  'defrost.end_temp': 'c', 'defrost.demand_temp': 'c', 'defrost.fad_temp': 'c',
  'defrost.interval': 'h',
  'defrost.max_duration': 'min', 'defrost.drip_time': 'min', 'defrost.fan_delay': 'min',
  'defrost.stabilize_time': 'min', 'defrost.equalize_time': 'min',
  'defrost.valve_delay': 's',
};
function unitOf(key) {
  return PARAM_UNITS[key] || '';
}

/** [label, value with unit] for every known controller parameter present in last_state. */
function settingsRows(S, state) {
  const out = [];
  for (const key of Object.keys(S.keys)) {
    if (!state || state[key] === undefined) continue;
    const v = state[key];
    const named = S.options && S.options[key];
    const code = typeof v === 'number' && !named ? unitOf(key) : '';
    const unit = code ? ((S.units && S.units[code]) || code) : '';
    out.push([S.keys[key], `${fmtState(S, key, v)}${unit ? ' ' + unit : ''}`]);
  }
  return out;
}

/**
 * A short reading of the period for the technician, built only from facts the
 * report already holds: the warmest interval and what coincided with it, the
 * HACCP verdict (or that none is possible without a limit), the event counts,
 * and whether anything is still open. It speaks about the air the sensor
 * measured, never about the product, and says it was generated automatically.
 */
function conclusionBlock({ S, d, tz, bucketSec, hasLimits }) {
  const lines = [];
  const stepMs = bucketSec * 1000;
  const airBuckets = d.buckets.filter(b => b.air);
  if (airBuckets.length) {
    let peak = 0;
    airBuckets.forEach((b, i) => { if (b.air.avg > airBuckets[peak].air.avg) peak = i; });
    const b = airBuckets[peak];
    const t0 = new Date(b.time).getTime(), t1 = t0 + stepMs;
    const ctx = [];
    if (overlaps(t0, t1, d.defrost)) ctx.push(S.c_peak_defrost);
    if (overlaps(t0, t1, d.doors)) ctx.push(S.c_peak_door);
    if (overlaps(t0, t1, d.offline.map(o => [o.from, o.to]))) ctx.push(S.c_peak_offline);
    if (overlaps(t0, t1, d.excursions.map(e => [e.start, e.end]))) ctx.push(S.c_peak_excursion);
    const next = airBuckets[peak + 1];
    lines.push(`${tpl(S.c_peak, fmt1(b.air.avg), localFmt(b.time, tz), ctx.length ? ctx.join(', ') : S.c_peak_plain)}${next ? ' ' + tpl(S.c_next, fmt1(next.air.avg)) : ''}`);
  }
  const exMin = d.excursions.reduce((a, e) => a + e.minutes, 0);
  lines.push(!hasLimits ? S.c_excursions_no_limit : d.excursions.length ? tpl(S.c_excursions, d.excursions.length, fmtDuration(exMin, S)) : S.c_excursions_none);
  const activeAlarms = d.alarms.filter(a => !a.cleared_at).length;
  const anyEvents = d.alarms.length + d.doors.length + d.offline.length + d.gaps.length > 0;
  lines.push(anyEvents ? tpl(S.c_events, d.alarms.length, activeAlarms, d.doors.length, d.offline.length, d.gaps.length) : S.c_events_none);

  // «Action needed» only for what is still open; events that ended on their
  // own are left to the technician's judgement, never called a danger.
  const reasons = [];
  if (activeAlarms) reasons.push(S.c_reason_alarm);
  if (hasLimits && d.excursions.length) reasons.push(S.c_reason_excursion);
  if (d.hints.some(h => !h.closed_at)) reasons.push(S.c_reason_hint);
  if (d.offline.some(o => o.open)) reasons.push(S.c_reason_offline);
  if (d.work.orders.some(w => w.status !== 'done' && w.status !== 'cancelled')) reasons.push(S.c_reason_wo);
  const action = reasons.length
    ? { text: tpl(S.c_action_needed, reasons.join(', ')), color: RED }
    : { text: anyEvents ? S.c_action_check : S.c_action_none };
  return [
    { text: S.conclusion, style: 'subHeader' },
    { ul: lines, fontSize: 8.5, margin: [0, 2, 0, 3] },
    { ...action, bold: true, fontSize: 8.5, margin: [0, 0, 0, 3] },
    { text: S.c_auto, fontSize: 7.5, color: GREY, italics: true, margin: [0, 0, 0, 8] },
  ];
}

function deviceSection({ S, lang, tz, d, bucketKey, bucketSec, from, to, single, doorMin, eventsRetained }) {
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
          [{ text: `${S.firmware}:`, bold: true }, `${dev.firmware_version || '—'}${dev.proto_version ? ' · v' + dev.proto_version : ''}`, { text: `${S.last_data}:`, bold: true }, `${d.lastData ? localFmt(d.lastData, tz) : '—'}`],
          [{ text: `${S.product}:`, bold: true }, `${dev.haccp_product || '—'}`, { text: `${S.haccp_limit}:`, bold: true },
           hasLimits ? { text: `${limitSentence(haccp.strings(lang), d.limits, d.tolerance)}; ${tpl(S.excursion_rule, d.excursionMin)}` } : { text: S.nd_no_limit, color: RED }],
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
  const derivedLine = derived.length ? { text: derived.join('   ·   '), fontSize: 8, color: GREY, margin: [0, 0, 0, 4] } : { text: '', margin: [0, 0, 0, 2] };
  // Raw min/max above every plotted point is two statistics, not a chart with holes.
  const summaryNote = { text: d.hourly ? tpl(S.summary_note_hourly, bucketKey) : tpl(S.summary_note, fmtStep(d.stepSec, S), bucketKey), fontSize: 7.5, color: GREY, italics: true, margin: [0, 0, 0, 8] };

  // Empty engineering columns are a fact worth explaining: a technician reading
  // dashes should not conclude the sensors failed.
  const ENGINEERING = ['evap', 'cond', 'setpoint', 'comp'];
  const absent = d.summary.air ? ENGINEERING.filter(c => !d.summary[c]) : [];
  const absentLine = absent.length
    ? [{ text: tpl(S.channels_absent, absent.map(c => S.ch[c] || c).join(', ')), fontSize: 8, italics: true, color: GREY, margin: [0, 0, 0, 8] }]
    : [];

  const svg = chartSvg({ buckets: d.buckets, from, to, tz, limits: d.limits, tolerance: d.tolerance });
  const legend = [S.legend_air, d.summary.evap ? S.legend_evap : null, d.summary.setpoint ? S.legend_setpoint : null, hasLimits ? S.legend_limit : null].filter(Boolean).join(', ');
  // Title, chart and legend stay on one page: a legend at the top of the next page explains nothing.
  const chartBlock = svg
    ? [{ unbreakable: true, stack: [{ text: tpl(S.chart, bucketKey), style: 'subHeader' }, { svg, width: CHART.w, margin: [0, 2, 0, 2] }, { text: legend, fontSize: 7, color: GREY, margin: [0, 0, 0, 10] }] }]
    : [];

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
    stat(S.excursions, hasLimits ? String(d.excursions.length) : S.nd_no_limit),
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
    // An empty list means «no outages» only when the event log still reaches this
    // far back. Past EVENT_RETENTION_DAYS the rows are gone, and the report says
    // so instead of certifying a clean connection it cannot see.
    : { text: eventsRetained ? S.no_offline : S.offline_not_retained, italics: true, margin: [0, 4, 0, 10] };

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

  // ── engineering log: one table per calendar day, 8 pt so it reads on paper ──
  const byTime = new Map(d.buckets.map(b => [b.time, b]));
  const stepMs = bucketSec * 1000;
  const start = Math.floor(from.getTime() / stepMs) * stepMs;
  const offlineIv = d.offline.map(o => [o.from, o.to]);
  const gapIv = d.gaps.map(g => [g.from, g.to]);
  const exIv = d.excursions.map(e => [e.start, e.end]);
  const cols = [S.col_time, `${S.ch.air} °C`, `${S.ch.evap} °C`, `${S.ch.cond} °C`, `${S.ch.setpoint} °C`, S.col_comp, S.col_defrost, S.col_note];
  const days = new Map();
  let anyPartial = false;
  for (let t = start; t < to.getTime(); t += stepMs) {
    const b = byTime.get(new Date(t).toISOString());
    const { day, time } = localParts(t, tz);
    const v = (ch) => (b && b[ch] ? fmt1(b[ch].avg) : '—');
    const edges = edgeNotes({ t, stepMs, from, to, tz, S });
    if (edges.length) anyPartial = true;
    const notes = [...edges];
    if (overlaps(t, t + stepMs, offlineIv)) notes.push(S.note_offline);
    if (!b || overlaps(t, t + stepMs, gapIv)) notes.push(S.note_gap);
    if (overlaps(t, t + stepMs, d.doors)) notes.push(S.note_door);
    const dev = overlaps(t, t + stepMs, exIv);
    if (!days.has(day)) days.set(day, []);
    const fill = dev ? RED_BG : (!b ? GREY_BG : undefined);
    const cell = (text, extra = {}) => ({ text, fillColor: fill, ...extra });
    days.get(day).push([
      cell(time), cell(v('air'), dev ? { bold: true, color: RED } : {}), cell(v('evap'), { color: GREY }), cell(v('cond'), { color: GREY }), cell(v('setpoint'), { color: GREY }),
      cell(b && b.comp ? String(Math.round(b.comp.avg * 100)) : '—', { color: GREY }),
      cell(b && b.defrost && b.defrost.avg > 0 ? S.yes : '', { color: GREY }),
      cell(notes.join(', '), { color: GREY, italics: true }),
    ]);
  }
  const logTables = [...days.entries()].map(([day, rows]) => dayTable({
    body: [
      cols.map(t => ({ text: t, bold: true, fontSize: 8 })),
      [{ text: localFmt(day + 'T12:00:00Z', 'UTC', false), colSpan: 8, bold: true, fillColor: DAY_BG, fontSize: 8.5 }, {}, {}, {}, {}, {}, {}, {}],
      ...rows,
    ],
    headerRows: 2, widths: ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', '*'], fontSize: 8, rows: rows.length,
  }));
  const partialNote = anyPartial ? [{ text: S.partial_note, fontSize: 7.5, color: GREY, margin: [0, 2, 0, 0] }] : [];

  return [
    ...head,
    ...conclusionBlock({ S, d, tz, bucketSec, hasLimits }),
    { text: S.settings, style: 'subHeader' }, settingsBlock,
    { text: S.summary, style: 'subHeader' }, summaryTable, derivedLine, summaryNote, ...absentLine,
    ...chartBlock,
    { text: S.operation, style: 'subHeader' }, opBlock,
    { text: S.alarms, style: 'subHeader' }, alarmsBlock,
    { text: S.connectivity, style: 'subHeader' }, offlineBlock,
    { text: S.hints, style: 'subHeader' }, hintsBlock,
    { text: S.work, style: 'subHeader' }, workBlock,
    { text: `${S.log} (${bucketKey})`, style: 'subHeader' }, ...partialNote, ...logTables,
  ];
}

function buildDocument({ kind, lang, tz, tenant, site, devices, from, to, bucketKey, bucketSec, source, generatedBy, generatedAt, code, hash, verifyUrl, doorMin }) {
  const S = strings(lang);
  // cleanup-aux.js sweeps `events` at EVENT_RETENTION_DAYS while the hourly
  // archive keeps the temperatures far longer, so a report can legitimately
  // cover a period whose event rows are gone.
  const eventsRetained = from.getTime() >= new Date(generatedAt).getTime() - EVENT_RETENTION_DAYS * 86400e3;
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
      // The QR code sits in the header: a working document has no signature
      // block to follow, and a verification block kept whole at the end
      // regularly landed alone on a last page.
      { width: 56, qr: verifyUrl, fit: 56, alignment: 'right', margin: [10, 0, 0, 0] },
    ],
    margin: [0, 0, 0, 6],
  };
  const verifyBlock = {
    text: [{ text: `${S.verify}: `, bold: true }, `${S.verify_text} ${verifyUrl}\n`, { text: `${fmtCode(code)}   SHA-256 ${hash}`, fontSize: 7, color: '#555555' }],
    fontSize: 7.5, color: '#444444', margin: [0, 0, 0, 10],
  };
  return {
    docDefinition: {
      info: { title: `${title} — ${orgName}`, author: 'ModESP Cloud', subject: `${orgName} · ${localFmt(from, tz, false)} – ${localFmt(to, tz, false)}`, creator: 'ModESP Cloud', keywords: `service, ${code}` },
      ...haccp.documentOptions(lang),
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
        { text: S.not_haccp, fontSize: 8, color: GREY, italics: true, margin: [0, 0, 0, 4] },
        verifyBlock,
        ...devices.flatMap(d => deviceSection({ S, lang, tz, d, bucketKey, bucketSec, from, to, single: kind === 'device', doorMin, eventsRetained })),
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
  return { buffer, code, hash, source: plan.source, bucketKey: plan.bucketKey, empty: false, tz };
}

module.exports = {
  generate, strings, STRINGS,
  __test: { collectDevice, buildDocument, compressorStats, fetchOfflinePeriods, chartSvg, settingsRows, unitOf, conclusionBlock },
};
