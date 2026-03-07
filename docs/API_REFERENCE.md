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
  "devices": [
    {
      "id": "uuid",
      "device_id": "a4cf1234abcd",
      "name": "Холодильна камера №1",
      "location": "Склад A, секція 3",
      "firmware_version": "1.2.3",
      "online": true,
      "last_seen": "2026-03-07T10:30:00Z",
      "alarm_active": false
    }
  ],
  "total": 42,
  "page": 1
}
```

### `GET /devices/:id`
Деталі пристрою з поточним станом.

**Response 200:**
```json
{
  "id": "uuid",
  "device_id": "a4cf1234abcd",
  "name": "Холодильна камера №1",
  "online": true,
  "last_seen": "2026-03-07T10:30:00Z",
  "state": {
    "thermostat.temperature": 4.5,
    "thermostat.setpoint": 4.0,
    "thermostat.compressor": true,
    "protection.alarm_active": false
  }
}
```

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
Часові ряди температур.

**Query params:**
- `hours=24` — глибина в годинах (default: 24, max: 720)
- `channels=air,evap` — фільтр каналів

**Response 200:**
```json
{
  "device_id": "a4cf1234abcd",
  "channels": ["air", "evap", "setpoint"],
  "data": [
    [1709812345, 4.5, -8.2, 4.0],
    [1709812645, 4.3, -8.5, 4.0]
  ]
}
```

### `GET /devices/:id/telemetry/summary`
Агрегована статистика за період.

**Query params:** `hours=24`

**Response 200:**
```json
{
  "air": { "min": 3.1, "max": 5.8, "avg": 4.4 },
  "evap": { "min": -10.2, "max": -6.1, "avg": -8.3 },
  "compressor_duty": 0.65,
  "defrost_count": 2
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

**Query params:** `active=true&severity=critical`

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

### `POST /users/:id/devices`
Надати доступ до пристрою.

```json
{ "device_id": "uuid" }
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

## Firmware (OTA)

### `POST /firmware`
Завантажити новий firmware (тільки admin).

**Content-Type:** multipart/form-data
**Fields:** `file`, `version`, `board`

### `GET /firmware`
Список доступних версій.

### `POST /devices/:id/ota`
Запустити OTA на конкретному пристрої.

```json
{ "firmware_id": "uuid" }
```

### `POST /devices/ota/group`
Груповий OTA rollout.

```json
{
  "firmware_id": "uuid",
  "device_ids": ["uuid1", "uuid2"],
  "batch_size": 5,
  "interval_minutes": 10
}
```

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
Призначити pending пристрій поточному тенанту.

**Ролі:** admin

**Body:**
```json
{
  "name": "Холодильна камера №1",
  "location": "Склад A, секція 3",
  "serial_number": "SN-2024-00142"
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "mqtt_device_id": "A4CF12",
  "status": "active",
  "message": "Device assigned, _set_tenant command sent"
}
```

Cloud автоматично: оновлює Mosquitto ACL, відправляє `_set_tenant` команду,
пристрій переключається на нові topics.

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
