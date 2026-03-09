# ModESP Cloud — Claude Code Instructions

## Що це за проект

ModESP Cloud — мультитенантна IoT платформа для централізованого управління парком
промислових ESP32 холодильних контролерів (ModESP_v4).

**Зв'язаний проект:** `D:\ModESP_v4` — прошивка ESP32 (вже в production)
**Мова коду:** JavaScript (Node.js) + Svelte 4
**Runtime:** Node.js 22

---

## Архітектура (критично!)

```
ESP32 (ModESP_v4)
    │ MQTT over TLS
    ▼
Mosquitto Broker (порт 8883 зовні, 1883 localhost)
    │
    ▼
Node.js Backend (порт 3000, тільки localhost)
├── MqttService      → підписка на всі топіки, маршрутизація подій
├── DbService        → PostgreSQL пул з'єднань
├── WsService        → WebSocket сервер для real-time
├── ApiService       → Express REST API
├── PushService      → FCM + Telegram Bot
└── AuthService      → JWT access/refresh токени
    │
    ├── PostgreSQL 16
    └── Svelte WebUI (статика через Nginx)

Nginx → HTTPS термінація, reverse proxy, статика
```

---

## MQTT Протокол v1

### Принцип: Individual Scalar Keys + Cloud Adapter
ESP32 публікує 48 окремих state keys зі скалярними значеннями (delta publish).
Cloud агрегує individual keys в структурований стан, семплює телеметрію, детектує аварії.

### Структура топіків
```
modesp/v1/{tenant_slug}/{device_id}/state/{key}    → scalar (delta, QoS 0)
modesp/v1/{tenant_slug}/{device_id}/status          → "online"/"offline" (LWT)
modesp/v1/{tenant_slug}/{device_id}/heartbeat       → JSON metadata (~100B)
modesp/v1/{tenant_slug}/{device_id}/cmd/{key}       ← scalar command
```

- `tenant_slug` — короткий slug з tenants.slug (не UUID!)
- `device_id` — MAC-based 6 hex chars (A4CF12)

### Підписки бекенду
```javascript
// v1 protocol
client.subscribe('modesp/v1/+/+/state/+')      // individual state keys
client.subscribe('modesp/v1/+/+/status')         // online/offline
client.subscribe('modesp/v1/+/+/heartbeat')      // device health
// Auto-discovery
client.subscribe('modesp/v1/pending/+/status')   // pending devices
client.subscribe('modesp/v1/pending/+/state/+')
// Legacy (старі прошивки)
client.subscribe('modesp/+/state/+')
client.subscribe('modesp/+/status')
```

### Парсинг топіку
```javascript
const parts = topic.split('/')
if (parts[1] === 'v1') {
    // v1: modesp/v1/{tenant}/{device}/{subtopic}[/{key}]
    const tenantSlug = parts[2]   // "acme" або "pending"
    const deviceId   = parts[3]   // "A4CF12"
    const subtopic   = parts[4]   // "state" | "status" | "heartbeat"
    const stateKey   = parts[5]   // "equipment.air_temp" (тільки state/cmd)
} else {
    // legacy: modesp/{device}/{subtopic}/{key}
    const deviceId   = parts[1]
    const subtopic   = parts[2]
    const stateKey   = parts[3]
}
```

### Обробка MQTT повідомлень
```javascript
// State keys — скалярні значення, не JSON!
// Payload: "-2.50", "true", "cooling" (plain text, не JSON)
function handleStateKey(tenantSlug, deviceId, key, payload) {
  try {
    const value = parseScalar(payload) // "-2.50" → -2.5, "true" → true
    stateMap.update(deviceId, key, value)
    ws.broadcastDelta(tenantSlug, deviceId, { [key]: value })

    if (key.startsWith('protection.') && key.endsWith('_alarm')) {
      detectAlarmTransition(tenantSlug, deviceId, key, value)
    }
  } catch (err) {
    logger.error({ tenantSlug, deviceId, key, err }, 'Failed to handle state key')
  }
}
```

**Детально:** `docs/MQTT_PROTOCOL.md`

---

## База даних (критично!)

### Залізне правило мультитенантності
**КОЖЕН** запит до БД ЗОБОВ'ЯЗАНИЙ містити `WHERE tenant_id = $N`.
Витік даних між тенантами — критична вразливість. Перевіряй кожен запит.

```javascript
// ✅ Правильно
const devices = await db.query(
  'SELECT * FROM devices WHERE tenant_id = $1',
  [tenantId]
)

// ❌ НЕБЕЗПЕЧНО — ніколи так не робити
const devices = await db.query('SELECT * FROM devices')
```

### Партиціонування телеметрії
Таблиця `telemetry` партиціонована по місяцях. При INSERT — Postgres автоматично
направляє в правильну партицію. Партиції створюються заздалегідь (cron).

### Схема БД
**Детально:** `docs/DATABASE.md`

Таблиці: `tenants`, `devices`, `users`, `user_devices`, `alarms`,
`telemetry` (партиціонована), `events`, `refresh_tokens`

Ключові колонки `devices`:
- `mqtt_device_id` — MAC-based ID в MQTT topics (A4CF12)
- `serial_number` — заводський серійний номер (ручне введення)
- `last_state` — JSONB з 48 accumulated state keys
- `status` — pending | active | disabled

---

## Структура проекту

```
ModESP_Cloud/
├── CLAUDE.md                    # ← цей файл
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── MQTT_PROTOCOL.md
│   ├── DATABASE.md
│   ├── API_REFERENCE.md
│   ├── DEPLOYMENT.md
│   └── ROADMAP.md
├── backend/
│   ├── src/
│   │   ├── index.js             # точка входу, ініціалізація сервісів
│   │   ├── config/
│   │   │   └── state_meta.json  # імпорт з ModESP_v4/generated/state_meta.h
│   │   ├── services/
│   │   │   ├── db.js            # PostgreSQL пул (pg library)
│   │   │   ├── mqtt.js          # MQTT клієнт + topic parsing + state aggregation
│   │   │   ├── ws.js            # WebSocket сервер
│   │   │   ├── push.js          # FCM + Telegram
│   │   │   └── auth.js          # JWT логіка
│   │   ├── routes/
│   │   │   ├── auth.js          # POST /auth/login, /refresh, /logout
│   │   │   ├── devices.js       # GET/POST /devices, /devices/:id
│   │   │   ├── telemetry.js     # GET /devices/:id/telemetry
│   │   │   ├── alarms.js        # GET /devices/:id/alarms, /alarms
│   │   │   ├── users.js         # CRUD /users (admin only)
│   │   │   ├── tenants.js       # CRUD /tenants (superadmin)
│   │   │   └── firmware.js      # OTA endpoints
│   │   ├── middleware/
│   │   │   ├── auth.js          # JWT перевірка, tenant ізоляція
│   │   │   ├── device-access.js # Per-device RBAC (filterDeviceAccess, checkDeviceAccess)
│   │   │   └── validate.js      # Joi/Zod валідація
│   │   └── db/
│   │       ├── schema.sql       # Повна схема БД
│   │       └── migrations/      # Міграції (нумеровані файли)
│   ├── scripts/
│   │   ├── grant-all-devices.js # Backward-compat RBAC: призначити всі девайси юзерам
│   │   └── cleanup-telemetry.js # Retention: видалити партиції старші 90 днів
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
├── webui/
│   ├── src/
│   │   ├── App.svelte
│   │   ├── stores/
│   │   ├── lib/
│   │   └── pages/
│   ├── package.json
│   └── rollup.config.js
└── infra/
    ├── nginx/
    ├── systemd/
    └── mosquitto/
```

---

## Залізні правила коду

### Безпека — найвищий пріоритет
- `tenant_id` в КОЖНОМУ запиті до БД — без винятків
- Per-device RBAC: non-admin users бачать тільки assigned devices (user_devices)
- `filterDeviceAccess()` для list endpoints, `checkDeviceAccess()` для single-device
- Admin та AUTH_ENABLED=false bypass все per-device filtering
- Всі вхідні дані валідуються до обробки (Joi або Zod)
- Паролі — bcrypt, мінімум 12 rounds
- JWT secret — з env, ніколи не хардкодити
- Prepared statements — ніколи не конкатенувати SQL рядки

### Структура відповідей API
```javascript
// Успіх
res.json({ data: result })

// Помилка
res.status(400).json({
  error: 'validation_failed',
  message: 'Email is required',
  status: 400
})
```

### Обробка MQTT повідомлень
```javascript
// Завжди перевіряти tenant_id з топіку проти БД
// Завжди обгортати в try/catch — збій одного повідомлення не має вбивати сервіс
async function handleStatus(tenantId, deviceId, payload) {
  try {
    const data = JSON.parse(payload)
    // ... обробка
  } catch (err) {
    logger.error({ tenantId, deviceId, err }, 'Failed to handle status')
  }
}
```

### Логування
```javascript
// Використовувати pino (швидкий структурований logger)
const logger = require('pino')()
logger.info({ tenantId, deviceId }, 'Device came online')
logger.error({ err }, 'DB connection failed')
```

### Змінні середовища
Всі конфіги — через `.env`. Ніколи не хардкодити credentials, порти, секрети.
`.env` в `.gitignore`. `.env.example` завжди актуальний.

---

## API Middleware порядок

```javascript
// Порядок middleware для захищених роутів:
router.use(authenticate)            // 1. перевірити JWT
router.use(extractTenant)           // 2. tenant_id з токена в req.tenantId
router.use(authorize(roles))        // 3. перевірити роль (якщо потрібно)
// 4a. filterDeviceAccess()         — для list endpoints (GET /devices, GET /alarms)
// 4b. checkDeviceAccess()          — для single-device endpoints (GET /devices/:id)
// 5. обробник роуту
```

**Per-device RBAC bypass:**
- `AUTH_ENABLED=false` → middleware прозоро пропускає (backward compat)
- `role === 'admin'` → бачить все в своєму тенанті, без фільтрації
- `role === 'superadmin'` → бачить все cross-tenant, bypass tenant_id + device фільтрації

---

## WebSocket протокол

```javascript
// Клієнт підписується на пристрій
{ "action": "subscribe", "device_id": "a4cf1234abcd" }

// Сервер надсилає delta оновлення (не повний стан)
{ "type": "state_update", "device_id": "...", "changes": { ... } }
{ "type": "alarm", "device_id": "...", "alarm_code": "...", "active": true }
{ "type": "device_offline", "device_id": "...", "last_seen": "..." }
```

**Важливо:** WS з'єднання авторизується через query param `?token=<access_token>`.
Перевіряти JWT при WS handshake, відхиляти неавторизовані з'єднання.

---

## Правила документування

### Git — conventional commits
```
feat(mqtt): handle alarm messages with FCM routing
fix(auth): refresh token rotation on reuse
feat(db): add telemetry partition for 2026-04
docs: update API_REFERENCE with firmware endpoints
```

### Після кожної сесії ОБОВ'ЯЗКОВО:
1. Оновити цей файл (CLAUDE.md) якщо змінилась архітектура або структура
2. Оновити `docs/ROADMAP.md` — зняти галочки з завершених задач
3. Оновити `docs/API_REFERENCE.md` якщо змінилось API
4. Git commit + push

### Git commits — обов'язкові
Кожна сесія ЗОБОВ'ЯЗАНА закінчуватися git commit + push.
Формат: conventional commits (див. вище).
```bash
# Типовий workflow в кінці сесії:
git add -A
git commit -m "feat(scope): опис змін"
git push origin main
```
Якщо зміни стосуються кількох скоупів — робити окремі коміти.

### Changelog в кінці кожного документа
```
## Changelog
- YYYY-MM-DD — Що змінено (1 рядок)
```

---

## Поточний стан

**Фаза 7 + Phase 4 MQTT Auth + Tenant Management — повністю завершено**

| Компонент | Статус |
|-----------|--------|
| Документація | ✅ Готово |
| Firmware changes (ModESP_v4) | ✅ Реалізовано і протестовано |
| PostgreSQL схема | ✅ schema.sql + migrations (001-009) |
| Node.js backend (Phase 1) | ✅ db.js, mqtt.js, index.js |
| Unit tests | ✅ 20/20 pass |
| REST API (Phase 2) | ✅ devices, telemetry, alarms, commands |
| WebSocket (Phase 2) | ✅ real-time state_delta, alarm, device_status |
| Svelte WebUI (Phase 2) | ✅ Dashboard, DeviceDetail, PendingDevices |
| Push Notifications (Phase 3) | ✅ push.js, telegram.js, fcm.js, REST API, WebUI |
| Auth (Phase 4) | ✅ auth.js service, JWT middleware, login/refresh/logout, users CRUD, WebUI Login/Users |
| History & Analytics (Phase 5) | ✅ telemetry stats, alarm stats, fleet summary, uPlot chart, AlarmHistory, Dashboard fleet bar |
| Fleet OTA (Phase 6) | ✅ Cloud: firmware upload/list/delete, deploy/rollout, status checker. Firmware: OTA handler E2E verified (~8s) |
| WebUI Polish (Phase 6.5) | ✅ i18n (UK+EN), light/dark theme, PATCH devices, service records, search by model/serial |
| Per-Device RBAC (Phase 7a) | ✅ device-access middleware, all routes protected, WS per-device check, users device management, grant-all-devices script |
| Backend Scalability (Phase 7b) | ✅ DB pool 30, batch state writer, heartbeat dedup, event batching, telemetry retention, query limit, WS backpressure, StateMap monitoring |
| Frontend RBAC (Phase 7c) | ✅ isAdmin/canWrite stores, conditional UI, route guards, device assignment modal, i18n |
| OTA Board Compatibility (Phase 7d) | ✅ migration 007, board_type on upload/deploy, board validation, Firmware WebUI board awareness |
| Dynamic MQTT Auth (Phase 4) | ✅ mosquitto-go-auth + PostgreSQL, bootstrap provisioning, credentials lifecycle API, WebUI |
| TLS (Let's Encrypt) | ✅ modesp.com.ua, порт 8883, auto-renewal hook, ESP32 CA bundle verified |
| Mosquitto конфіг (prod) | ✅ mosquitto-go-auth + TLS + per_listener_settings + SQL ACL |
| Nginx HTTPS | ✅ modesp.com.ua:443, HTTP→HTTPS redirect, security headers, HSTS, rate limiting |
| VPS розгортання | ✅ Production: https://modesp.com.ua, MQTT TLS bidirectional, OTA E2E verified |
| Tenant Management (Phase 8a) | ✅ superadmin role (migration 009), tenants CRUD API, device reassign, Tenants WebUI, PendingDevices tenant select |

---

## Якщо загубився

- `CLAUDE.md` → як працює проект (цей файл)
- `docs/ARCHITECTURE.md` → компоненти і потоки даних
- `docs/MQTT_PROTOCOL.md` → формати повідомлень
- `docs/DATABASE.md` → схема БД
- `docs/API_REFERENCE.md` → REST endpoints
- `docs/ROADMAP.md` → що робити далі

---

## Changelog

- 2026-03-07 — Створено. Повна інструкція для Claude Code: архітектура, правила, структура проекту.
- 2026-03-07 — Оновлено. MQTT секція: individual scalar keys + cloud adapter pattern, реальна topic structure.
- 2026-03-07 — Phase 1 backend: db.js, mqtt.js, index.js, schema.sql, state_meta.json, unit tests. Git commit requirements додано.
- 2026-03-07 — Phase 2: REST API, WebSocket, Svelte WebUI (Dashboard, DeviceDetail, PendingDevices). Статус таблицю оновлено.
- 2026-03-07 — Phase 3: Push notifications — push.js orchestrator, telegram.js bot, fcm.js, notifications REST API, Notifications WebUI page.
- 2026-03-07 — Phase 4: Auth & User Management — auth.js service (bcrypt/JWT), auth middleware, auth/users routes, seed-admin script, WebSocket JWT auth, WebUI Login/Users pages, AUTH_ENABLED toggle.
- 2026-03-07 — Phase 5: History & Analytics — telemetry from/to + bucketed stats API, alarm stats API, fleet summary API, uPlot TelemetryChart, AlarmHistory component, Dashboard fleet summary bar, ensure-partitions.js script.
- 2026-03-07 — Phase 6: Fleet OTA (cloud side) — firmware upload/list/delete API (multer), OTA deploy + group rollout API, ota.js service (batch scheduling, periodic status checker, auto-pause on failure threshold), sendJsonCommand (QoS 1), Firmware.svelte WebUI page with deploy modal.
- 2026-03-08 — Phase 6 complete: ModESP_v4 OTA handler verified E2E (~8s). Partition table fix (otadata + ota_1 for rollback). ROADMAP оновлено.
- 2026-03-08 — Phase 6.5: i18n (UK+EN), light/dark theme toggle, device metadata (model, comment, manufactured_at), PATCH /devices/:id, service records CRUD, search by model/serial, migration 005.
- 2026-03-08 — Phase 7a: Per-Device RBAC — device-access.js middleware (filterDeviceAccess + checkDeviceAccess), all device/telemetry/alarm/fleet routes protected, WebSocket per-device check, users device management (GET/PUT bulk), grant-all-devices.js migration script, migration 006.
- 2026-03-08 — Phase 7b: Backend Scalability — DB pool max=30 + statement_timeout 30s, batch state writer (N→1 multi-row UPDATE), heartbeat write dedup (_lastFw), event INSERT batching (1s flush), cleanup-telemetry.js (90-day partition retention), telemetry LIMIT 10000 + X-Truncated, WS backpressure (64KB), StateMap monitoring (60s stats).
- 2026-03-08 — Phase 7c: Frontend RBAC — isAdmin/canWrite derived stores, conditional UI (edit/command/service hidden for viewer, ParameterEditor readonly), admin-only route guards (wrap from svelte-spa-router), device assignment modal on Users page (search, select all/none, checklist, bulk PUT), i18n keys (uk+en).
- 2026-03-08 — Phase 7d: OTA Board Compatibility — migration 007 (firmwares.board_type), firmware upload with board_type, deploySingle board mismatch check (400), createRollout filters incompatible devices, OTA payload includes board_type, Firmware WebUI board awareness (select on upload, column in library, compatibility in deploy modal, incompatible devices disabled).
- 2026-03-08 — VPS deployment complete: backend running (modesp-backend.service), WebUI via Nginx, MQTT bidirectional verified, OTA E2E confirmed, admin + viewer accounts created, ESP32 connected.
- 2026-03-09 — Phase 4 completion (Dynamic MQTT Auth): mosquitto-go-auth + PostgreSQL (migration 008 mqtt_username column + indexes), mqtt-auth.js service (provision/rotate/revoke), REST API credentials endpoints, bootstrap provisioning in mqtt.js (ensureDevice), mosquitto.conf rewrite (per_listener_settings + auth_plugin + SQL ACL with read/write separation), provision-mqtt-creds.js migration script, WebUI credentials feedback on PendingDevices assign + MQTT auth status/rotate/revoke on DeviceDetail, i18n (uk+en).
- 2026-03-09 — TLS deployment: Let's Encrypt cert for modesp.com.ua, Mosquitto TLS on port 8883, ESP32 connected via mqtts:// with built-in CA bundle, auto-renewal hook. Firmware: _set_mqtt_creds handler (ModESP_v4 commit 9c4f027). Deploy script fixes: superquery $1 placeholder, aclquery prefix||suffix, certfile=fullchain.pem, build prereqs (make, mosquitto-dev).
- 2026-03-09 — HTTPS: Nginx конфіг оновлено з реальним доменом modesp.com.ua, WebUI dist symlink, auto-renewal hook тепер перезавантажує і Mosquitto і Nginx.
- 2026-03-09 — Tenant Management (Phase 8a): superadmin role (migration 009), tenants CRUD API (routes/tenants.js), device reassign endpoint (POST /devices/:id/reassign), Tenants WebUI page, isSuperAdmin store, DeviceDetail "Change Tenant" modal, PendingDevices tenant dropdown for superadmin, seed-admin --role flag, i18n (uk+en).
