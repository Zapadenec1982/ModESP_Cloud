# Архітектура ModESP Cloud

## Огляд

ModESP Cloud — мультитенантна IoT платформа для промислових холодильних контролерів.
Побудована на принципі розділення відповідальності: ESP32 виконує критичну логіку
реального часу, хмара забезпечує моніторинг, аналітику і сповіщення.

**Ключовий паттерн:** Cloud Adapter — хмара адаптується під нативний протокол прошивки
(individual scalar keys), виконуючи агрегацію, семплування та детекцію подій server-side.

---

## Компоненти системи

### ESP32 (ModESP_v4) — edge пристрій
- Виконує захисну логіку, термостат, відтайку в реальному часі
- Публікує 48 individual state keys в MQTT (delta, скалярні значення)
- Підписується на 60 command keys з хмари
- Heartbeat кожні 30с (метадані: fw version, uptime, heap, rssi)
- HA Auto-Discovery для Home Assistant інтеграції
- Локальний WebUI для пуско-налагодження (HTTP, тільки локальна мережа)

### Mosquitto — MQTT брокер
- Єдина точка входу для всіх ESP32 пристроїв
- ACL на рівні топіків: tenant + device ізоляція
- Persistence для QoS 1 повідомлень (аварії не губляться при перезапуску)
- TLS термінація для з'єднань від ESP32 (порт 8883)
- Phase 1: статичний ACL файл. Phase 4+: mosquitto-go-auth з PostgreSQL

### Node.js Backend — серцевина платформи
- **MqttService** — підписка на all topics, парсинг, маршрутизація
- **State Aggregator** — накопичення individual keys → повний стан пристрою (Map)
- **Alarm Detector** — детекція protection.* transitions → DB + push
- **Telemetry Sampler** — snapshot temperatures кожні 5хв → PostgreSQL
- **Event Detector** — state transitions (compressor on/off, defrost) → DB
- **WsService** — WebSocket сервер, delta broadcast per-tenant
- **ApiService** — REST API, command translation (JSON → individual MQTT keys)
- **PushService** — FCM + Telegram Bot
- **AuthService** — JWT access/refresh токени

### PostgreSQL — сховище даних
- Пристрої, тенанти, користувачі
- Телеметрія з партиціонуванням по місяцях (server-side sampled)
- Аварії з повною історією (active/cleared)
- State metadata registry (валідація команд)

### Svelte WebUI — хмарний дашборд
- Окремий від локального ESP32 WebUI
- Список всіх пристроїв тенанта з online/offline статусом
- Real-time моніторинг через WebSocket (delta updates)
- Графіки телеметрії, історія аварій
- Управління користувачами і пристроями
- Auto-discovery: прийняття/відхилення pending пристроїв

### Nginx — зовнішній шлюз
- Термінація HTTPS (Let's Encrypt)
- Роздача статичних файлів WebUI
- Reverse proxy до Node.js API
- Rate limiting

---

## Потоки даних

### Стан пристрою (ESP32 → Cloud → WebUI)
```
ESP32
  │ MQTT publish QoS 0 (delta, кожну 1с якщо змінилось)
  │ modesp/v1/{tenant}/{device}/state/{key} → scalar
  ▼
Mosquitto
  │
  ▼
Node.js MqttService
  ├── State Aggregator: accumulate key→value в Map
  │     ├── devices.last_state JSONB (debounced batch update)
  │     └── devices.last_seen (debounced)
  ├── WebSocket delta broadcast → Svelte WebUI (immediate)
  └── Event Detector: state transitions → INSERT INTO events
```

### Аварія (ESP32 → Cloud → Push)
```
ESP32
  │ MQTT publish QoS 1, retain=true
  │ modesp/v1/{tenant}/{device}/state/protection.{alarm}_alarm → "true"/"false"
  │ (re-publish кожні 5хв)
  ▼
Mosquitto (persist — не губиться при перезапуску)
  │
  ▼
Node.js Alarm Detector
  │ Порівнює prev/curr значення protection.*_alarm
  │ false→true: новий alarm
  │ true→false: alarm cleared
  ├── PostgreSQL: INSERT INTO alarms / UPDATE cleared_at
  ├── FCM → телефони підписників
  ├── Telegram Bot → чат техніка
  └── WebSocket broadcast → WebUI (badge, toast)
```

### Телеметрія (server-side sampling)
```
Node.js Telemetry Sampler (таймер кожні 5 хв)
  │ Читає accumulated state з Map для кожного device
  │ Channels: air_temp, evap_temp, cond_temp, setpoint
  ▼
PostgreSQL: INSERT INTO telemetry (partitioned by month)
```

> ESP32 НЕ надсилає окремі telemetry bundles. Cloud семплює з накопиченого стану.
> Це зменшує навантаження на ESP32 (80KB вільної RAM) і спрощує прошивку.

### Команда (WebUI → Cloud → ESP32)
```
Svelte WebUI
  │ HTTP POST /api/devices/{id}/command
  │ { "cmd": "set_setpoint", "value": 3.5 }
  ▼
Node.js REST API
  │ 1. Авторизація (JWT + роль)
  │ 2. Валідація через state_meta (type, min/max, writable)
  │ 3. Translation: "set_setpoint" → "thermostat.setpoint"
  │ 4. MQTT publish: scalar value
  │    modesp/v1/{tenant}/{device}/cmd/thermostat.setpoint → "3.5"
  ▼
Mosquitto
  │
  ▼
ESP32 handle_incoming()
  │ Парсинг key з topic, валідація за STATE_META
  │ Запис у SharedState → Equipment arbitration
  ▼
Equipment module → relay/sensor control
```

### Heartbeat (ESP32 → Cloud)
```
ESP32
  │ MQTT publish QoS 0, кожні 30с
  │ modesp/v1/{tenant}/{device}/heartbeat
  │ → {"proto":1,"fw":"1.2.3","up":86400,"heap":80000,"rssi":-62}
  ▼
Node.js MqttService
  ├── devices.firmware_version = heartbeat.fw
  ├── devices.last_seen = NOW()
  └── Fleet health dashboard data
```

### Auto-discovery (новий пристрій)
```
ESP32 (без tenant_slug)
  │ modesp/v1/pending/{device}/status → "online"
  ▼
Node.js Auto-Discovery Handler
  │ Невідомий device_id → створити devices (status='pending')
  ▼
Svelte WebUI
  │ Адмін бачить "Нове обладнання: A4CF12"
  │ Призначає tenant + name + location
  ▼
Node.js
  │ 1. UPDATE devices SET tenant_id, status='active'
  │ 2. Оновити Mosquitto ACL
  │ 3. MQTT publish: modesp/v1/pending/{device}/cmd/_set_tenant → "acme"
  ▼
ESP32
  │ Зберігає tenant в NVS
  │ Rebuild prefix → reconnect
  ▼
modesp/v1/acme/{device}/... (нормальна робота)
```

---

## Мультитенантність

Кожен клієнт (організація) — окремий **тенант** з ізольованими даними.

**Ізоляція на рівні MQTT:**
- Mosquitto ACL: кожен ESP32 має credentials з правами тільки на свої topics
- Topic містить `tenant_slug` — бекенд додатково перевіряє відповідність
- Pending пристрої ізольовані в `modesp/v1/pending/` namespace

**Ізоляція на рівні БД:**
- `tenant_id` присутній в кожній таблиці
- Всі запити містять `WHERE tenant_id = $1` — витік між тенантами неможливий
- Row-Level Security (PostgreSQL RLS) як додатковий захист

**Ізоляція на рівні API:**
- JWT токен містить `tenant_id` і `role`
- Middleware перевіряє що запитуваний ресурс належить тенанту з токена

---

## Безпека

| Шар | Захист |
|-----|--------|
| ESP32 → Mosquitto | MQTT over TLS (порт 8883), унікальний логін/пароль на пристрій |
| Браузер → Nginx | HTTPS (Let's Encrypt), HSTS |
| WebUI → API | JWT Bearer токен, refresh token rotation |
| API → DB | Prepared statements, параметризовані запити |
| API → MQTT | Валідація команд через state_meta (type, range, writable) |
| Між тенантами | tenant_id в кожному запиті + PostgreSQL RLS |
| Push | FCM server key зберігається тільки на сервері |

---

## Масштабування

**Поточна ціль:** до 1000 пристроїв на одному VPS (1 vCPU, 2GB RAM)

**Вузькі місця при зростанні:**
- Телеметрія: партиціонування PostgreSQL по місяцях → TimescaleDB при 10М+ рядків
- WebSocket: Node.js cluster або Redis pub/sub при кількох процесах
- Mosquitto: горизонтальне масштабування через bridge або EMQX при 10К+ пристроїв
- State Map: ~50KB per device × 1000 = ~50MB (прийнятно для 2GB RAM)

**Що не потребує змін при масштабуванні:**
- MQTT topic structure (вже включає tenant_slug і версію)
- Схема БД (tenant_id в кожній таблиці з першого дня)
- REST API (stateless, масштабується горизонтально)
- Individual scalar keys (MQTT 5.0 topic aliases зменшать overhead)

---

## Changelog

- 2026-03-07 — Створено. Базова архітектура.
- 2026-03-07 — Оновлено. Cloud adapter pattern, state aggregation, server-side telemetry sampling, auto-discovery flow, command translation.
