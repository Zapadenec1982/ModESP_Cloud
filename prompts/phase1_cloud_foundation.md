# ModESP Cloud — Фаза 1: Cloud Foundation

## Контекст проекту

Ти працюєш над **ModESP Cloud** — хмарною платформою для управління парком
промислових ESP32 холодильних контролерів.

**Прочитай перед початком роботи:**
1. `CLAUDE.md` — архітектура, правила коду, структура проекту
2. `docs/MQTT_PROTOCOL.md` — MQTT топіки і формати повідомлень
3. `docs/DATABASE.md` — схема БД з поясненнями
4. `docs/API_REFERENCE.md` — REST API специфікація

---

## Завдання Фази 1

Реалізувати базову інфраструктуру бекенду: ESP32 підключається до хмари і дані
зберігаються в БД. Без WebUI, без push — тільки фундамент.

### Що потрібно зробити

#### 1. Ініціалізація Node.js проекту (`backend/`)

```bash
npm init
```

Залежності:
- `express` — HTTP сервер
- `mqtt` — MQTT клієнт
- `pg` — PostgreSQL клієнт
- `pino` — структурований logger
- `dotenv` — змінні середовища
- `bcrypt` — хешування паролів
- `jsonwebtoken` — JWT
- `zod` — валідація вхідних даних
- `ws` — WebSocket сервер

Dev залежності: `nodemon`

#### 2. Схема БД (`backend/src/db/schema.sql`)

Взяти з `docs/DATABASE.md` і оформити як готовий SQL файл для виконання.
Включити всі таблиці, індекси, RLS політики, функцію партиціонування.
Додати початкові партиції телеметрії на 3 місяці вперед.

#### 3. DbService (`backend/src/services/db.js`)

- `pg.Pool` з конфігурацією з `.env`
- Хелпер `query(sql, params)` з логуванням повільних запитів (> 1с)
- Хелпер `transaction(callback)` для атомарних операцій
- Graceful shutdown (закрити пул при SIGTERM)

#### 4. MqttService (`backend/src/services/mqtt.js`)

- Підключення до Mosquitto (localhost:1883)
- Підписка на всі топіки згідно `docs/MQTT_PROTOCOL.md`
- Парсинг `tenant_id` і `device_id` з топіку
- Обробники для кожного типу повідомлення:
  - `handleStatus(tenantId, deviceId, payload)` — оновити `devices.last_seen`, `devices.online`, `devices.last_state`
  - `handleAlarm(tenantId, deviceId, payload)` — INSERT/UPDATE в `alarms`
  - `handleTelemetry(tenantId, deviceId, payload)` — INSERT в `telemetry`
  - `handleOtaStatus(tenantId, deviceId, payload)` — логувати статус OTA
- Кожен обробник в try/catch — збій одного повідомлення не вбиває сервіс
- Device online/offline tracking: якщо пристрій не надсилав status > 90с → `online = false`

#### 5. Точка входу (`backend/src/index.js`)

- Завантаження `.env`
- Ініціалізація DbService (перевірка з'єднання з БД)
- Ініціалізація MqttService
- Базовий Express сервер з healthcheck: `GET /api/health`
- Graceful shutdown: SIGTERM → закрити MQTT → закрити DB → вийти

#### 6. Healthcheck endpoint

```json
GET /api/health
→ 200: { "status": "ok", "db": "ok", "mqtt": "ok", "uptime": 12345 }
→ 503: { "status": "degraded", "db": "error", "mqtt": "ok", "uptime": 12345 }
```

#### 7. `.env.example`

```
NODE_ENV=development
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=modesp_cloud
DB_USER=modesp_cloud
DB_PASS=

MQTT_HOST=localhost
MQTT_PORT=1883
MQTT_USER=modesp_backend
MQTT_PASS=

JWT_SECRET=
JWT_EXPIRES_IN=900
JWT_REFRESH_EXPIRES_IN=2592000

FCM_SERVER_KEY=
TELEGRAM_BOT_TOKEN=
```

---

## Критичні вимоги

### Мультитенантність
**КОЖЕН** SQL запит ЗОБОВ'ЯЗАНИЙ містити `WHERE tenant_id = $N`.
Це не опція — це вимога безпеки. Перевіряй кожен запит перед тим як писати наступний.

### Обробка помилок
- Помилки БД логуються але не крашають сервіс
- Помилки MQTT парсингу логуються і пропускаються
- Express має глобальний error handler

### Логування (pino)
```javascript
logger.info({ tenantId, deviceId, event: 'status' }, 'Device status received')
logger.warn({ deviceId, lastSeen }, 'Device went offline')
logger.error({ err, tenantId, deviceId }, 'Failed to save telemetry')
```

---

## Що НЕ робити в цій фазі

- ❌ WebUI — це Фаза 2
- ❌ Push сповіщення (FCM/Telegram) — це Фаза 3
- ❌ JWT авторизація — це Фаза 4
- ❌ REST API для пристроїв — це Фаза 2
- ❌ Складна аналітика — це Фаза 5

Фокус: MQTT → Node.js → PostgreSQL. Нічого зайвого.

---

## Результат фази

Після завершення:
1. `npm start` запускає сервіс без помилок
2. `GET /api/health` повертає `{"status":"ok",...}`
3. Симульоване MQTT повідомлення `status` зберігається в `devices`
4. Симульоване MQTT повідомлення `alarm` зберігається в `alarms`
5. Симульоване MQTT повідомлення `telemetry` зберігається в `telemetry`
6. Через 90с без `status` — `devices.online = false`

---

## Після завершення

1. Оновити `CLAUDE.md` — статус компонентів
2. Оновити `docs/ROADMAP.md` — зняти галочки Фази 1
3. Git commit з описом що реалізовано
4. Git push
