# REST API Reference — ModESP Cloud

## Загальні принципи

**Base URL:** `https://cloud.example.com/api/v1`

**Авторизація:** Bearer JWT токен в заголовку
```
Authorization: Bearer <access_token>
```

**Формат відповіді:** JSON
**Помилки:**
```json
{
  "error": "device_not_found",
  "message": "Device with id 'abc123' not found",
  "status": 404
}
```

---

## Авторизація

### `POST /auth/login`
Отримати access + refresh токени.

**Body:**
```json
{
  "email": "technician@example.com",
  "password": "..."
}
```

**Response 200:**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900,
  "user": {
    "id": "uuid",
    "email": "technician@example.com",
    "role": "technician",
    "tenant_id": "uuid"
  }
}
```

### `POST /auth/refresh`
Оновити access токен.

**Body:**
```json
{ "refresh_token": "eyJ..." }
```

### `POST /auth/logout`
Відкликати refresh токен.

---

## Пристрої

### `GET /devices`
Список всіх пристроїв тенанта.

**Query params:**
- `online=true` — тільки онлайн пристрої
- `page=1&limit=20` — пагінація

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "mqtt_device_id": "A4CF12",
      "name": "Холодильна камера №1",
      "location": "Склад А",
      "serial_number": "MX-2024-001",
      "model": "ModESP-4R",
      "comment": "...",
      "manufactured_at": "2024-06-15",
      "firmware_version": "1.2.3",
      "online": true,
      "last_seen": "2026-03-07T10:30:00Z",
      "alarm_active": false,
      "air_temp": 4.5
    }
  ]
}
```

### `GET /devices/:id`
Деталі пристрою з поточним станом + список користувачів з доступом.

**Response 200:**
```json
{
  "id": "uuid",
  "mqtt_device_id": "A4CF12",
  "name": "Холодильна камера №1",
  "location": "Склад А",
  "serial_number": "MX-2024-001",
  "model": "ModESP-4R",
  "comment": "Нотатки...",
  "manufactured_at": "2024-06-15",
  "online": true,
  "last_seen": "2026-03-07T10:30:00Z",
  "last_state": {
    "thermostat.temperature": 4.5,
    "thermostat.setpoint": 4.0,
    "thermostat.compressor": true,
    "protection.alarm_active": false
  },
  "users": [
    { "id": "uuid", "email": "tech@example.com", "role": "technician" }
  ]
}
```

### `PATCH /devices/:id`
Оновити властивості пристрою.

**Ролі:** admin, technician

**Body** (будь-яке поле опціональне, мінімум 1):
```json
{
  "name": "Нова назва",
  "location": "Склад Б",
  "serial_number": "MX-2024-002",
  "model": "ModESP-4R",
  "comment": "Коментар",
  "manufactured_at": "2024-06-15"
}
```

**Response 200:** оновлений пристрій (без state).

---

## Сервісні записи

### `GET /devices/:id/service-records`
Історія обслуговування пристрою.

**Response 200:**
```json
{
  "data": [
    {
      "id": 1,
      "service_date": "2026-03-01",
      "technician": "Іванов І.І.",
      "reason": "Планове ТО",
      "work_done": "Чистка конденсатора",
      "created_at": "2026-03-01T10:00:00Z"
    }
  ]
}
```

### `POST /devices/:id/service-records`
Додати сервісний запис.

**Ролі:** admin, technician

**Body:**
```json
{
  "service_date": "2026-03-01",
  "technician": "Іванов І.І.",
  "reason": "Планове ТО",
  "work_done": "Чистка конденсатора, перевірка тиску"
}
```

### `DELETE /devices/:id/service-records/:recordId`
Видалити сервісний запис.

**Ролі:** admin, technician

---

### `POST /devices/:id/mqtt-credentials`
Генерувати або ротувати MQTT credentials для пристрою. Повертає plaintext пароль **один раз**.
Якщо пристрій онлайн — credentials автоматично відправляються через MQTT (`cmd/_set_mqtt_creds`).

**Ролі:** admin

**Response:**
```json
{
  "data": {
    "username": "device_A4CF12",
    "password": "Kx9mR4pQ2wLn8bYz",
    "mqtt_host": "cloud.example.com",
    "mqtt_port": 8883,
    "sent_via_mqtt": true
  }
}
```

- `sent_via_mqtt: true` — credentials відправлено через MQTT, пристрій переключиться автоматично
- `sent_via_mqtt: false` — MQTT недоступний, потрібно ввести вручну через локальний WebUI

---

### `DELETE /devices/:id/mqtt-credentials`
Відкликати MQTT credentials. Пристрій не зможе підключитись.

**Ролі:** admin

---

### `POST /devices/:id/command`
Відправити команду на пристрій.

**Ролі:** admin, technician

**Body:**
```json
{
  "cmd": "set_setpoint",
  "value": 3.5
}
```

**Command translation (REST → MQTT):**
API команда транслюється в individual MQTT key зі скалярним значенням.

| API cmd | MQTT topic key | Тип значення |
|---------|----------------|-------------|
| `set_setpoint` | `thermostat.setpoint` | float |
| `reset_alarms` | `protection.reset_alarms` | bool (true) |
| `start_defrost` | `defrost.manual_start` | bool (true) |
| `set_parameter` | `{key}` (будь-який writable key) | typed |

Для `set_parameter` передавати key напряму:
```json
{ "cmd": "set_parameter", "key": "thermostat.differential", "value": 2.5 }
```

Валідація через state_meta: тип, min/max, writable flag.

**Response 200:**
```json
{ "status": "sent", "mqtt_topic": "thermostat.setpoint", "value": "3.5" }
```

---

## Телеметрія

### `GET /devices/:id/telemetry`
Часові ряди температур (raw data).

**Query params:**
- `hours=24` — глибина в годинах (default: 24, max: 744)
- `from=2026-03-01T00:00:00Z&to=2026-03-07T00:00:00Z` — ISO діапазон (альтернатива hours)
- `channels=air,evap` — фільтр каналів (comma-separated)

Max range: 31 day.

**Response 200:**
```json
{
  "data": [
    { "time": "2026-03-07T10:30:00Z", "channel": "air", "value": 4.5 },
    { "time": "2026-03-07T10:30:00Z", "channel": "evap", "value": -8.2 }
  ]
}
```

### `GET /devices/:id/telemetry/stats`
Агрегована статистика (bucketed min/max/avg).

**Query params:**
- `hours=24` або `from`/`to` — часовий діапазон
- `channels=air,evap` — фільтр каналів
- `bucket=1h` — розмір bucket: `5m`, `15m`, `1h`, `6h`, `1d` (default: `1h`)

**Response 200:**
```json
{
  "data": {
    "buckets": [
      {
        "time": "2026-03-07T10:00:00Z",
        "air": { "min": 3.8, "max": 5.2, "avg": 4.4, "samples": 12 },
        "evap": { "min": -9.1, "max": -7.2, "avg": -8.3, "samples": 12 }
      }
    ],
    "summary": {
      "air": { "min": 3.1, "max": 5.8, "avg": 4.4 },
      "evap": { "min": -10.2, "max": -6.1, "avg": -8.3 }
    }
  }
}
```

---

## Аварії

### `GET /devices/:id/alarms`
Список аварій пристрою.

**Query params:**
- `active=true` — тільки активні
- `limit=50`

**Response 200:**
```json
{
  "alarms": [
    {
      "id": 1234,
      "alarm_code": "high_temp",
      "severity": "critical",
      "active": true,
      "value": 12.5,
      "limit_value": 10.0,
      "triggered_at": "2026-03-07T08:15:00Z",
      "cleared_at": null
    }
  ]
}
```

### `GET /alarms` — всі аварії по тенанту
Агрегований список аварій по всьому парку.

**Query params:** `active=true`, `from`, `to`, `limit`

### `GET /alarms/stats`
Статистика частоти аварій за період.

**Query params:** `from`, `to` (default: last 30 days)

**Response 200:**
```json
{
  "data": [
    { "alarm_code": "high_temp_alarm", "count": 12, "avg_duration_sec": 1800 },
    { "alarm_code": "door_alarm", "count": 5, "avg_duration_sec": 300 }
  ]
}
```

---

## Fleet

### `GET /fleet/summary`
Зведена інформація по всьому парку пристроїв тенанта.

**Response 200:**
```json
{
  "data": {
    "devices_total": 5,
    "devices_online": 3,
    "devices_active": 4,
    "alarms_active": 1,
    "alarms_24h": 3
  }
}
```

---

## Користувачі (тільки admin)

### `GET /users`
### `POST /users`

**Body:**
```json
{
  "email": "new.technician@example.com",
  "password": "...",
  "role": "technician"
}
```

### `PUT /users/:id`
### `DELETE /users/:id`

### `GET /users/:id/devices`
Список пристроїв, до яких користувач має доступ.

**Ролі:** admin

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "mqtt_device_id": "A4CF12",
      "name": "Холодильна камера №1",
      "location": "Склад А",
      "model": "ModESP-4R",
      "online": true
    }
  ]
}
```

### `PUT /users/:id/devices`
Bulk-заміна списку пристроїв користувача (видаляє старі, додає нові).

**Ролі:** admin

**Body:**
```json
{ "device_ids": ["uuid1", "uuid2", "uuid3"] }
```

**Response 200:**
```json
{ "data": { "message": "Device access updated", "count": 3 } }
```

### `POST /users/:id/devices`
Надати доступ до одного пристрою.

**Ролі:** admin

```json
{ "device_id": "uuid" }
```

### `DELETE /users/:id/devices/:deviceId`
Відкликати доступ до пристрою.

**Ролі:** admin

---

## Per-Device RBAC (Phase 7a)

Всі ендпоінти пристроїв тепер перевіряють per-device доступ:

**Правила:**
- `superadmin` — бачить всі пристрої всіх тенантів, cross-tenant bypass
- `admin` — бачить всі пристрої свого тенанту, без обмежень
- `technician` / `viewer` — бачить тільки пристрої з таблиці `user_devices`
- `AUTH_ENABLED=false` — всі перевірки вимкнені (backward compatible)

**List endpoints** (використовують `filterDeviceAccess`):
- `GET /devices` — фільтрує по user_devices
- `GET /alarms` — фільтрує по device_id
- `GET /alarms/stats` — фільтрує по device_id
- `GET /fleet/summary` — рахує тільки assigned devices

**Single-device endpoints** (використовують `checkDeviceAccess`):
- `GET /devices/:id` — 403 якщо немає доступу
- `PATCH /devices/:id` — 403 якщо немає доступу
- `POST /devices/:id/command` — 403 якщо немає доступу
- `POST /devices/:id/request-state` — 403 якщо немає доступу
- `GET/POST/DELETE /devices/:id/service-records` — 403 якщо немає доступу
- `GET /devices/:id/telemetry` — 403 якщо немає доступу
- `GET /devices/:id/telemetry/stats` — 403 якщо немає доступу
- `GET /devices/:id/alarms` — 403 якщо немає доступу

**WebSocket:** `subscribe` перевіряє user_devices для non-admin.

**Помилка 403:**
```json
{
  "error": "forbidden",
  "message": "Device access denied",
  "status": 403
}
```

---

## Push сповіщення

### `POST /users/me/push-token`
Зареєструвати FCM токен.

```json
{ "token": "fcm_token_here" }
```

### `POST /users/me/telegram`
Прив'язати Telegram акаунт.

```json
{ "telegram_id": 123456789 }
```

### `GET /users/me/notifications`
Налаштування підписок на сповіщення.

### `PUT /users/me/notifications`
```json
{
  "alarm_critical": true,
  "alarm_warning": false,
  "device_offline": true
}
```

---

## Тенанти (superadmin / admin)

### `GET /tenants`
Список тенантів з кількістю пристроїв і користувачів.

**Ролі:** superadmin — всі тенанти; admin — тільки свій.

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Acme Corp",
      "slug": "acme",
      "plan": "pro",
      "active": true,
      "device_count": 5,
      "user_count": 3,
      "created_at": "2026-03-09T10:00:00Z"
    }
  ]
}
```

### `POST /tenants`
Створити новий тенант.

**Ролі:** superadmin

**Body:**
```json
{
  "name": "Acme Corp",
  "slug": "acme",
  "plan": "basic"
}
```

**Валідація:**
- `name`: обов'язкове, 1-100 символів
- `slug`: обов'язкове, regex `/^[a-z0-9][a-z0-9_-]*$/`, 2-50 символів, reserved: `__system__`, `pending`
- `plan`: optional, одне з `basic`, `pro`, `enterprise` (default: `basic`)

### `PATCH /tenants/:id`
Оновити тенант.

**Ролі:** superadmin

**Body** (будь-яке поле опціональне):
```json
{
  "name": "New Name",
  "plan": "enterprise",
  "active": false
}
```

Slug змінити не можна якщо є пристрої (`400 Cannot change slug while devices exist`).

### `DELETE /tenants/:id`
Soft-delete тенант. Не можна видалити якщо є пристрої.

**Ролі:** superadmin

**Response 400:**
```json
{
  "error": "tenant_has_devices",
  "message": "Cannot delete tenant with active devices"
}
```

---

### `POST /devices/:id/reassign`
Перенести пристрій до іншого тенанту.

**Ролі:** superadmin

**Body:**
```json
{ "tenant_id": "uuid" }
```

**Дії:**
1. UPDATE device.tenant_id
2. DELETE user_devices (скидання прив'язок)
3. Rotate MQTT credentials
4. Send `_set_mqtt_creds` + `_set_tenant` через MQTT (по OLD slug)
5. Refresh MQTT registries

**Response 200:**
```json
{
  "data": {
    "message": "Device reassigned",
    "device_id": "F27FCD",
    "new_tenant": "acme",
    "mqtt_credentials_rotated": true
  }
}
```

---

## Firmware (OTA)

### `POST /firmware/upload`
Завантажити новий firmware binary (тільки admin).

**Content-Type:** multipart/form-data
**Fields:** `file` (.bin, ≤ 4MB), `version` (string), `notes` (optional), `board_type` (optional — модель плати, наприклад "ModESP-4R"; якщо не вказано — firmware universal для всіх плат)

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "version": "1.2.3",
    "filename": "tenant_1.2.3_1709827200.bin",
    "original_name": "modesp_v4_1.2.3.bin",
    "size_bytes": 1548288,
    "checksum": "sha256:a1b2c3d4...",
    "board_type": "ModESP-4R",
    "notes": "Fix sensor calibration",
    "created_at": "2026-03-08T10:00:00Z"
  }
}
```

### `GET /firmware`
Список доступних версій для тенанта.

### `DELETE /firmware/:id`
Видалити firmware (тільки якщо немає активних OTA jobs).

### `POST /ota/deploy`
Запустити OTA на одному пристрої.

**Ролі:** admin

**Board Compatibility:** Якщо firmware має `board_type`, а пристрій має `model` — вони повинні збігатись. При невідповідності повертається 400.

```json
{ "firmware_id": "uuid", "device_id": "F27FCD" }
```

**Response 201:**
```json
{
  "data": {
    "job_id": "uuid",
    "device_id": "F27FCD",
    "firmware_version": "1.2.3",
    "status": "sent"
  }
}
```

**Response 400 (board mismatch):**
```json
{
  "error": "board_mismatch",
  "message": "Board mismatch: firmware targets \"ModESP-4R\", device is \"ModESP-2R\"",
  "status": 400
}
```

### `POST /ota/rollout`
Груповий OTA rollout з batching.

**Ролі:** admin

```json
{
  "firmware_id": "uuid",
  "device_ids": ["F27FCD", "A4CF12"],
  "batch_size": 2,
  "batch_interval_s": 300,
  "fail_threshold_pct": 50
}
```

**Board Compatibility:** Якщо firmware має `board_type`, несумісні пристрої (device.model ≠ firmware.board_type) автоматично виключаються з rollout. Кількість виключених повертається в `skipped_incompatible`.

**Response 201:**
```json
{
  "data": {
    "rollout_id": "uuid",
    "firmware_version": "1.2.3",
    "total_devices": 2,
    "skipped_incompatible": 1,
    "batch_size": 2,
    "status": "running"
  }
}
```

### `GET /ota/jobs`
Список OTA jobs. Query: `?status=sent&rollout_id=uuid&device_id=F27FCD`

### `GET /ota/rollouts`
Список rollouts з агрегованими count (succeeded/failed/queued).

### `GET /ota/rollouts/:id`
Деталі rollout з per-device breakdown.

### `POST /ota/rollouts/:id/pause`
Призупинити running rollout.

### `POST /ota/rollouts/:id/resume`
Продовжити paused rollout.

### `POST /ota/rollouts/:id/cancel`
Скасувати rollout, всі queued jobs → cancelled.

---

## Auto-discovery (Pending Devices)

### `GET /devices/pending`
Список пристроїв, що очікують призначення tenant.

**Ролі:** admin

**Response 200:**
```json
{
  "devices": [
    {
      "mqtt_device_id": "A4CF12",
      "first_seen": "2026-03-07T10:30:00Z",
      "last_seen": "2026-03-07T10:35:00Z",
      "firmware_version": "1.2.3"
    }
  ]
}
```

### `POST /devices/pending/:mqtt_device_id/assign`
Призначити pending пристрій тенанту.

**Ролі:** admin (свій тенант), superadmin (будь-який тенант через `tenant_id`)

**Body:**
```json
{
  "name": "Холодильна камера №1",
  "location": "Склад A, секція 3",
  "serial_number": "SN-2024-00142",
  "model": "ModESP-4R",
  "comment": "Нотатки (необов'язково)",
  "tenant_id": "uuid (тільки для superadmin, опціонально)"
}
```

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "mqtt_device_id": "A4CF12",
    "status": "active",
    "message": "Device assigned",
    "mqtt_credentials": {
      "username": "device_A4CF12",
      "password": "Kx9mR4pQ2wLn8bYz",
      "mqtt_host": "cloud.example.com",
      "mqtt_port": 8883,
      "sent_via_mqtt": true
    }
  }
}
```

Cloud автоматично: генерує MQTT credentials, відправляє `cmd/_set_mqtt_creds` + `cmd/_set_tenant` через MQTT.
Якщо MQTT недоступний — `sent_via_mqtt: false`, credentials потрібно ввести вручну.

---

## WebSocket

**URL:** `wss://cloud.example.com/ws`

**Авторизація:** query param `?token=<access_token>`

### Підписка на пристрій
```json
{ "action": "subscribe", "device_id": "a4cf1234abcd" }
```

### Повідомлення від сервера

**state_update:**
```json
{
  "type": "state_update",
  "device_id": "a4cf1234abcd",
  "changes": {
    "thermostat.temperature": 4.8,
    "thermostat.compressor": false
  }
}
```

**alarm:**
```json
{
  "type": "alarm",
  "device_id": "a4cf1234abcd",
  "alarm_code": "high_temp",
  "severity": "critical",
  "active": true
}
```

**device_online / device_offline:**
```json
{
  "type": "device_offline",
  "device_id": "a4cf1234abcd",
  "last_seen": "2026-03-07T10:35:00Z"
}
```

---

## Changelog

- 2026-03-07 — Створено. Авторизація, пристрої, телеметрія, аварії, користувачі, OTA, WebSocket.
- 2026-03-07 — Оновлено. Command translation (REST→MQTT individual keys), auto-discovery endpoints, set_parameter generic command.
- 2026-03-07 — Phase 5: telemetry from/to + stats (bucketed), alarm stats, fleet summary endpoints.
- 2026-03-07 — Phase 6: firmware upload/list/delete, OTA deploy + group rollout, rollout pause/resume/cancel, jobs listing.
- 2026-03-08 — Device metadata: PATCH /devices/:id, service records CRUD, new fields (model, comment, manufactured_at), users with access in device detail.
- 2026-03-08 — Phase 7a: Per-Device RBAC — GET/PUT /users/:id/devices, filterDeviceAccess/checkDeviceAccess middleware on all device endpoints, WebSocket per-device check, 403 for unauthorized device access.
- 2026-03-08 — Phase 7d: OTA Board Compatibility — firmware upload з board_type, deploy board mismatch 400, rollout auto-filter incompatible + skipped_incompatible count.
- 2026-03-09 — Phase 4 MQTT Auth: POST/DELETE /devices/:id/mqtt-credentials (generate/rotate/revoke), assign endpoint returns mqtt_credentials, GET /devices/:id returns has_mqtt_credentials.
- 2026-03-09 — Phase 8a Tenant Management: Tenants CRUD (GET/POST/PATCH/DELETE /tenants), POST /devices/:id/reassign (superadmin), assign endpoint with optional tenant_id for superadmin.
