# MQTT Протокол ModESP v1

## Огляд

Протокол побудований на принципі **individual scalar keys** — кожен параметр пристрою
публікується як окремий MQTT топік зі скалярним значенням. Це забезпечує:
- Delta publish (тільки змінені значення) → мінімальний трафік
- Малий footprint на ESP32 (32-байт буфер на повідомлення)
- Real-time оновлення для WebSocket (кожна зміна = окрема подія)

Cloud-side виконує **агрегацію**: збирає individual keys в структурований стан пристрою,
семплує телеметрію для БД, детектує зміни аварій.

---

## Версіонування

Версія протоколу є частиною топіку. Breaking changes → нова мажорна версія.
Бекенд підписується на всі версії одночасно.

**Поточна версія:** `v1`

---

## Структура топіків

```
modesp/v1/{tenant_slug}/{device_id}/{subtopic}[/{key}]
```

| Сегмент | Тип | Опис | Приклад |
|---------|-----|------|---------|
| `v1` | string | Версія протоколу | `v1` |
| `tenant_slug` | string | Slug організації (4-32 chars, lowercase) | `acme` |
| `device_id` | string | MAC-based ID пристрою (6 hex chars) | `A4CF12` |
| `subtopic` | string | Тип: `state`, `status`, `heartbeat`, `cmd` | `state` |
| `key` | string | Ключ стану (тільки для `state`/`cmd`) | `equipment.air_temp` |

### Ідентифікатори

**tenant_slug** — короткий slug з таблиці `tenants` (unique). UUID залишається
primary key в БД. Slug використовується в MQTT для компактності та читабельності.

**device_id** — автоматично генерується з WiFi MAC-адреси ESP32 (останні 3 байти).
Серійний номер заводу зберігається окремо в cloud БД, не в MQTT.

---

## Топіки публікації (ESP32 → Cloud)

### `state/{key}` — стан пристрою (individual keys)

**QoS:** 0 (state), 1 (protection.*) | **Retain:** false (state), true (protection.*)
**Інтервал:** delta publish кожну 1с (тільки змінені ключі)

Кожен ключ публікується як окремий топік зі скалярним payload:

```
modesp/v1/acme/A4CF12/state/equipment.air_temp        → "-2.50"
modesp/v1/acme/A4CF12/state/equipment.evap_temp       → "-18.30"
modesp/v1/acme/A4CF12/state/equipment.compressor      → "true"
modesp/v1/acme/A4CF12/state/thermostat.setpoint       → "4.00"
modesp/v1/acme/A4CF12/state/thermostat.state          → "cooling"
modesp/v1/acme/A4CF12/state/protection.alarm_active   → "false"
modesp/v1/acme/A4CF12/state/protection.alarm_code     → "none"
```

**Типи payload:** float (`"-2.50"`), int (`"30"`), bool (`"true"`/`"false"`), string (`"cooling"`)

#### Повний перелік publish keys (48 ключів)

**Equipment (реальний стан обладнання):**

| Key | Тип | Опис |
|-----|-----|------|
| `equipment.air_temp` | float | Температура повітря (°C) |
| `equipment.evap_temp` | float | Температура випарника (°C) |
| `equipment.cond_temp` | float | Температура конденсатора (°C) |
| `equipment.compressor` | bool | Стан компресора |
| `equipment.defrost_relay` | bool | Стан реле відтайки |
| `equipment.sensor1_ok` | bool | Справність датчика 1 |
| `equipment.energy_kwh` | float | Енергоспоживання за інтервал семплювання (кВт·год). Зарезервований ключ для майбутніх CT clamp сенсорів. Коли присутній — cloud використовує реальне значення замість розрахункового |

**Protection (аварії та діагностика):**

| Key | Тип | QoS | Retain | Опис |
|-----|-----|-----|--------|------|
| `protection.lockout` | bool | 1 | true | Блокування компресора |
| `protection.alarm_active` | bool | 1 | true | Будь-яка аварія активна |
| `protection.alarm_code` | string | 1 | true | Код пріоритетної аварії |
| `protection.high_temp_alarm` | bool | 1 | true | Висока температура |
| `protection.low_temp_alarm` | bool | 1 | true | Низька температура |
| `protection.sensor1_alarm` | bool | 1 | true | Відмова датчика 1 |
| `protection.sensor2_alarm` | bool | 1 | true | Відмова датчика 2 |
| `protection.door_alarm` | bool | 1 | true | Двері відкриті |
| `protection.short_cycle_alarm` | bool | 1 | true | Короткий цикл |
| `protection.rapid_cycle_alarm` | bool | 1 | true | Часті запуски |
| `protection.continuous_run_alarm` | bool | 1 | true | Безперервна робота |
| `protection.pulldown_alarm` | bool | 1 | true | Збій pulldown |
| `protection.rate_alarm` | bool | 1 | true | Швидке зростання T |
| `protection.compressor_starts_1h` | int | 0 | false | Запусків за годину |
| `protection.compressor_duty` | float | 0 | false | Duty cycle (%) |
| `protection.compressor_run_time` | int | 0 | false | Час роботи поточного циклу (с) |
| `protection.last_cycle_run` | int | 0 | false | Тривалість останнього циклу ON (с) |
| `protection.last_cycle_off` | int | 0 | false | Тривалість останнього циклу OFF (с) |
| `protection.compressor_hours` | float | 0 | false | Мотогодини (persistent) |

**Thermostat (термостат):**

| Key | Тип | Опис |
|-----|-----|------|
| `thermostat.temperature` | float | Робоча температура (°C) |
| `thermostat.req.compressor` | bool | Запит компресора від термостата |
| `thermostat.req.evap_fan` | bool | Запит вентилятора випарника |
| `thermostat.req.cond_fan` | bool | Запит вентилятора конденсатора |
| `thermostat.state` | string | Стан FSM: idle, cooling, startup, safety_run |
| `thermostat.comp_on_time` | int | Час ON поточного циклу (с) |
| `thermostat.comp_off_time` | int | Час OFF поточного циклу (с) |
| `thermostat.night_active` | bool | Нічний режим активний |
| `thermostat.effective_setpoint` | float | Ефективна уставка з нічним зсувом |
| `thermostat.display_temp` | float | Температура для дисплея |

**Defrost (відтайка):**

| Key | Тип | Опис |
|-----|-----|------|
| `defrost.active` | bool | Відтайка активна |
| `defrost.phase` | string | Фаза: idle, stabilize, valve_open, active, equalize, drip, fad |
| `defrost.state` | string | Стан FSM |
| `defrost.phase_timer` | int | Таймер поточної фази (с) |
| `defrost.interval_timer` | int | Відлік до наступної відтайки (с) |
| `defrost.defrost_count` | int | Лічильник відтайок |
| `defrost.last_termination` | string | Причина завершення: temp, timeout |
| `defrost.consecutive_timeouts` | int | Послідовні таймаути |
| `defrost.req.compressor` | bool | Запит компресора від defrost |
| `defrost.req.defrost_relay` | bool | Запит реле відтайки |

**DataLogger (локальний логер):**

| Key | Тип | Опис |
|-----|-----|------|
| `datalogger.records_count` | int | Записів в логері |
| `datalogger.events_count` | int | Подій в логері |
| `datalogger.flash_used` | float | Використано flash (%) |

#### Alarm re-publish

Всі `protection.*` ключі автоматично перепублікуються кожні **5 хвилин** з QoS 1, retain=true.
Це гарантує доставку стану аварій навіть якщо cloud перезапустився.

---

### `status` — online/offline (LWT)

**QoS:** 1 | **Retain:** true

```
modesp/v1/acme/A4CF12/status → "online"    (при підключенні)
modesp/v1/acme/A4CF12/status → "offline"   (LWT при розриві з'єднання)
```

Налаштовується як Last Will and Testament (LWT) при підключенні до брокера.
При підключенні — публікується `"online"` (retained, QoS 1).

---

### `heartbeat` — метадані пристрою

**QoS:** 0 | **Retain:** false | **Інтервал:** кожні 30с

```
modesp/v1/acme/A4CF12/heartbeat → {"proto":1,"fw":"1.2.3","up":86400,"heap":80000,"rssi":-62}
```

Компактний JSON (~100 байт) з метаданими, які НЕ дублюються в state keys:

| Поле | Тип | Опис |
|------|-----|------|
| `proto` | int | Версія протоколу (1) |
| `fw` | string | Версія прошивки |
| `up` | int | Uptime в секундах |
| `heap` | int | Вільна heap пам'ять (байт) |
| `rssi` | int | WiFi RSSI (dBm) |

---

## Топіки підписки (Cloud → ESP32)

### `cmd/{key}` — команди (individual keys)

**QoS:** 0 | **Retain:** false

Кожна команда — окремий топік зі скалярним значенням:

```
modesp/v1/acme/A4CF12/cmd/thermostat.setpoint     ← "4.0"
modesp/v1/acme/A4CF12/cmd/protection.reset_alarms  ← "true"
modesp/v1/acme/A4CF12/cmd/defrost.manual_start     ← "true"
```

Firmware валідує значення за типом і min/max з STATE_META перед застосуванням.
Невалідні або read-only ключі ігноруються з попередженням в логах.

#### Повний перелік subscribe keys (60 ключів)

**Equipment (калібрування сенсорів):**
`equipment.ntc_beta`, `equipment.ntc_r_series`, `equipment.ntc_r_nominal`,
`equipment.ds18b20_offset`, `equipment.filter_coeff`

**Protection (межі та затримки аварій):**
`protection.high_limit`, `protection.low_limit`, `protection.high_alarm_delay`,
`protection.low_alarm_delay`, `protection.door_delay`, `protection.manual_reset`,
`protection.post_defrost_delay`, `protection.reset_alarms`,
`protection.min_compressor_run`, `protection.max_starts_hour`,
`protection.max_continuous_run`, `protection.pulldown_timeout`,
`protection.pulldown_min_drop`, `protection.max_rise_rate`, `protection.rate_duration`,
`protection.compressor_hours`

**Thermostat (режим роботи):**
`thermostat.setpoint`, `thermostat.differential`, `thermostat.min_off_time`,
`thermostat.min_on_time`, `thermostat.startup_delay`, `thermostat.evap_fan_mode`,
`thermostat.fan_stop_temp`, `thermostat.fan_stop_hyst`, `thermostat.cond_fan_delay`,
`thermostat.safety_run_on`, `thermostat.safety_run_off`, `thermostat.night_setback`,
`thermostat.night_mode`, `thermostat.night_start`, `thermostat.night_end`,
`thermostat.night_active`, `thermostat.display_defrost`

**Defrost (параметри відтайки):**
`defrost.type`, `defrost.interval`, `defrost.counter_mode`, `defrost.initiation`,
`defrost.termination`, `defrost.end_temp`, `defrost.max_duration`,
`defrost.demand_temp`, `defrost.drip_time`, `defrost.fan_delay`, `defrost.fad_temp`,
`defrost.stabilize_time`, `defrost.valve_delay`, `defrost.equalize_time`,
`defrost.manual_start`

**DataLogger (конфігурація логера):**
`datalogger.enabled`, `datalogger.retention_hours`, `datalogger.sample_interval`,
`datalogger.log_evap`, `datalogger.log_cond`, `datalogger.log_setpoint`,
`datalogger.log_humidity`

### `cmd/_set_tenant` — системна команда (auto-discovery)

**QoS:** 1 | **Retain:** false

```
modesp/v1/pending/A4CF12/cmd/_set_tenant ← "acme"
```

Спеціальна команда для auto-discovery flow. Firmware зберігає tenant slug в NVS,
перебудовує prefix і перепідключається до брокера з новим tenant_slug в топіку.

---

## Підписки бекенду

```javascript
// v1 protocol — основні підписки
client.subscribe('modesp/v1/+/+/state/+')      // individual state keys
client.subscribe('modesp/v1/+/+/status')         // online/offline (LWT)
client.subscribe('modesp/v1/+/+/heartbeat')      // device health

// Auto-discovery — pending devices
client.subscribe('modesp/v1/pending/+/status')   // нові пристрої
client.subscribe('modesp/v1/pending/+/state/+')  // стан pending пристроїв

// Legacy support — пристрої зі старою прошивкою
client.subscribe('modesp/+/state/+')             // legacy state keys
client.subscribe('modesp/+/status')               // legacy online/offline
```

### Парсинг топіку

```javascript
// v1:     modesp/v1/{tenant}/{device}/{subtopic}[/{key}]
// legacy: modesp/{device}/{subtopic}/{key}
const parts = topic.split('/')
if (parts[1] === 'v1') {
    const tenantSlug = parts[2]   // "acme" або "pending"
    const deviceId   = parts[3]   // "A4CF12"
    const subtopic   = parts[4]   // "state" | "status" | "heartbeat" | "cmd"
    const stateKey   = parts[5]   // "equipment.air_temp" (тільки для state/cmd)
} else {
    // legacy: modesp/{device}/{subtopic}/{key}
    const deviceId   = parts[1]   // "A4CF12"
    const subtopic   = parts[2]   // "state" | "status" | "cmd"
    const stateKey   = parts[3]   // "equipment.air_temp"
}
```

---

## Cloud-side обробка

### Агрегація стану (in-memory)

Cloud накопичує individual keys в Map per-device. Це забезпечує:
- Повний стан пристрою для REST API і WebSocket
- Детекцію змін аварій (порівняння prev/curr)
- Семплування телеметрії для БД

### Семплування телеметрії (server-side)

Cloud кожні 5 хвилин зберігає snapshot temperature channels з накопиченого стану
в таблицю `telemetry`. Це заміна firmware-side telemetry bundles — ефективніше
для ESP32 (не потрібен JSON serializer і таймер на пристрої).

### Детекція подій

Cloud відстежує state transitions:
- `equipment.compressor`: false→true = `compressor_on`, true→false = `compressor_off`
- `defrost.active`: false→true = `defrost_start`, true→false = `defrost_end`
- `protection.*_alarm`: false→true = alarm triggered, true→false = alarm cleared

---

## Auto-discovery flow

1. Новий ESP32 без tenant → публікує з `pending`:
   `modesp/v1/pending/A4CF12/status` → `"online"`
2. Cloud бачить невідомий пристрій → створює запис `status = 'pending'`
3. Адмін в WebUI бачить pending device → призначає tenant
4. Cloud публікує: `modesp/v1/pending/A4CF12/cmd/_set_tenant` → `"acme"`
5. Cloud оновлює Mosquitto ACL (device → tenant topics)
6. Firmware зберігає tenant в NVS → reconnect → `modesp/v1/acme/A4CF12/...`

---

## Mosquitto ACL

```
# Backend — повний доступ
user modesp_backend
topic readwrite modesp/#

# Зареєстрований пристрій
user device_A4CF12
topic write modesp/v1/acme/A4CF12/state/#
topic write modesp/v1/acme/A4CF12/status
topic write modesp/v1/acme/A4CF12/heartbeat
topic read  modesp/v1/acme/A4CF12/cmd/#

# Pending пристрій (до призначення tenant)
user device_A4CF12_pending
topic write modesp/v1/pending/A4CF12/state/#
topic write modesp/v1/pending/A4CF12/status
topic write modesp/v1/pending/A4CF12/heartbeat
topic read  modesp/v1/pending/A4CF12/cmd/#
```

Phase 1: статичний ACL файл, регенерація при додаванні пристрою.
Масштаб: `mosquitto-go-auth` з PostgreSQL backend (Phase 4+).

---

## Правила сумісності

1. **Мінорні зміни** (нові state keys) — зворотньо сумісні, версія не змінюється
2. **Breaking changes** (зміна topic structure) — нова версія `v2`
3. **Бекенд підписується на всі версії** — v1, v2, legacy
4. **Heartbeat містить `proto` поле** — бекенд знає як парсити
5. **Legacy підтримка** — пристрої без v1 prefix працюють через legacy підписки

---

## Bandwidth оцінка

Overhead v1 vs legacy: **+9 bytes/message** (довший topic з tenant slug).

| Масштаб | Messages/sec (avg) | v1 Bandwidth | Overhead vs legacy |
|---------|-------------------|--------------|--------------------|
| 1 пристрій | 10 | 610 B/s | +90 B/s |
| 100 пристроїв | 1,000 | 59 KB/s | +9 KB/s |
| 1000 пристроїв | 10,000 | 590 KB/s | +90 KB/s |

Bottleneck при масштабі — PostgreSQL insert throughput і Node.js event loop,
не MQTT bandwidth. MQTT 5.0 Topic Aliases можуть зменшити overhead в майбутньому.

---

## Changelog

- 2026-03-07 — Створено. Початкова версія (JSON bundles, не відповідала прошивці).
- 2026-03-07 — Повний перепис. v1 протокол: individual scalar keys, heartbeat, auto-discovery, legacy support.
- 2026-03-24 — Додано зарезервований ключ `equipment.energy_kwh` для CT clamp датчиків енергії.
