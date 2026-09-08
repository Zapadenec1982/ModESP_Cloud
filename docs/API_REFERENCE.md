# REST API Reference — ModESP Cloud

## Загальні принципи

**Base URL:** `https://cloud.example.com/api/v1`

**Авторизація:** Bearer JWT токен в заголовку
```
Authorization: Bearer <access_token>
```

**Формат відповіді:** JSON

> **OpenAPI.** Інтеграційна поверхня (усе, що доступно API-ключу: пристрої, телеметрія, аварії, точки,
> наряди, рекомендації, звіти, а також вихідні події вебхуків) описана машинно в OpenAPI 3.1:
> `GET /api/docs` — інтерактивна документація (Swagger UI, self-hosted), `GET /api/docs/openapi.json` —
> документ, копія в репозиторії — `docs/openapi.json` (генерується з `backend/src/openapi`, CI перевіряє
> актуальність). Обидва маршрути публічні, з лімітом 120 запитів/хв на IP. Цей файл лишається повним
> довідником, включно з обліковою й адміністративною поверхнею, якої в OpenAPI немає.

> **Виняток — `/api/public/*`.** Роутер публічної сторінки статусу точки змонтований **вище**
> ланцюжка автентифікації і навмисне не вимагає Bearer-токена. Він має власний rate limiter і власний
> звужений набір полів — див. «Публічна сторінка статусу точки».

> **Окремий rate limiter на зовнішні сервіси.** `/api/geo/*`, `/api/map/route`,
> `/api/map/isochrones`, `/api/sites/:id/weather` і `/api/sites/geocode-pending` ходять до третіх
> сторін (Nominatim, Open-Meteo, OSRM, OpenRouteService), тому обмежені **30 запитами/хв на
> користувача** — не на IP: цілий тенант за одним NAT ділив би спільну IP-квоту.

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
  "csrf_token": "0f3a…",
  "expires_in": 900,
  "user": {
    "id": "uuid",
    "email": "technician@example.com",
    "role": "technician",
    "tenant_id": "uuid"
  }
}
```

> **Сесії (епік 2.9).** Кожна відповідь, що відкриває або продовжує сесію (login, select-tenant,
> switch-tenant, refresh, прийняття запрошення, реєстрація, `mfa/verify`), крім `refresh_token` у тілі
> ставить його ж в httpOnly-cookie `modesp_rt` (`Path=/api/auth; SameSite=Strict; Secure` у production,
> `COOKIE_SECURE=false` для LAN по http) і повертає `csrf_token`. Браузер cookie не читає: refresh і logout
> ідуть без тіла, з заголовком `X-CSRF-Token: <csrf_token>`. Скрипти й застосунки, як і раніше, передають
> `refresh_token` у тілі — CSRF-заголовок тоді не потрібен. Access-токен несе `sid` — ідентифікатор сесії
> (сім'ї refresh-токенів), його показує `GET /auth/sessions`.

**Response 200 з увімкненим другим фактором:** пароль прийнято, токенів ще немає — потрібен код:
```json
{ "require_mfa": true, "mfa_token": "eyJ...", "user": { "id": "uuid", "email": "…" } }
```
`mfa_token` живе 5 хвилин і придатний лише для `POST /auth/mfa/verify` (як Bearer він відповідає 401).

### `POST /auth/select-tenant`
Завершити логін після вибору тенанта (multi-tenant flow).

**Body:**
```json
{
  "pending_token": "eyJ...",
  "tenant_id": "uuid"
}
```

**Response 200:** Same as login (access_token, refresh_token, user, tenant, tenants).

### `POST /auth/switch-tenant`
Перемикання активного тенанта (потребує Bearer token).

**Body:**
```json
{ "tenant_id": "uuid" }
```

**Response 200:** New access_token, refresh_token, tenant, tenants array.

### `POST /auth/refresh`
Оновити access токен. Також повертає `tenants` array. Refresh-токен одноразовий: відповідь містить новий
`refresh_token` (і новий `csrf_token`), старий стає недійсним.

**Body** (API-клієнти) або **cookie `modesp_rt` + заголовок `X-CSRF-Token`** (браузер):
```json
{ "refresh_token": "eyJ..." }
```

**Помилки:** `400 validation_failed` — ні тіла, ні cookie; `403 csrf_required` — cookie без правильного
CSRF-заголовка; `401 token_expired`; `401 invalid_token`; `401 token_reused` — токен пред'явлено вдруге:
це ознака вкраденого ланцюжка, тож **уся сесія закривається** (і легітимний власник теж входить знову),
cookie очищується.

### `POST /auth/logout`
Закрити сесію (усі refresh-токени її сім'ї). Токен — у тілі або в cookie з `X-CSRF-Token`; cookie очищується.

---

### `POST /auth/forgot-password`
Самостійне скидання пароля (публічний, ліміт 10 запитів/год з IP). Відповідь однакова незалежно від того,
чи існує адреса. Для активного акаунта генерується той самий 16-символьний код, що й в адмінському
потоці, і надсилається листом (Resend) як посилання `#/reset?email=…&code=…`; без налаштованої пошти
залишається адмінський код.

```json
{ "email": "tech@example.com", "lang": "uk" }
```

**Response 200:** `{ "data": { "message": "If an account with that email exists, a reset link has been sent" } }`

### `POST /auth/reset-password`
Завершення скидання (публічний): код + новий пароль (політика — мінімум 15 символів). Скидає всі
refresh-токени користувача.

```json
{ "email": "tech@example.com", "reset_code": "0a1b2c3d4e5f6789", "new_password": "…15+ символів…" }
```

### `GET /auth/invite/:token`
Публічний перегляд запрошення (`#/invite/<token>`). `404` — невідомий токен; `410` з
`error: invitation_accepted | invitation_revoked | invitation_expired | invitation_tenant_inactive`.

**Response 200:**
```json
{
  "data": {
    "email": "new.tech@example.com",
    "role": "technician",
    "tenant": { "name": "Org A", "slug": "org-a" },
    "existing_user": false,
    "expires_at": "2026-09-05T09:00:00.000Z"
  }
}
```

### `POST /auth/invite/:token/accept`
Прийняття запрошення. Новий акаунт: `password` (мінімум 15 символів) стає паролем; наявний акаунт
(`existing_user: true`): `password` — його поточний пароль, після перевірки акаунт додається до
організації зі своєю поточною роллю. `accept_terms` має бути `true`. Відповідь — як у `POST /auth/login`
(`201` для нового акаунта, `200` для наявного), плюс `created`.

```json
{ "password": "…", "accept_terms": true }
```

### Самореєстрація (plan epic 2.1)

Організація на плані «Старт» і її перший адміністратор. `REGISTRATION_MODE` вирішує, чи відкрита форма
(`off` → `403 registration_closed`) і чи потрібне схвалення superadmin'ом (`approve`, типово: організація
створюється зі статусом `suspended`, trial стартує при схваленні); `open` стартує 14-денний trial одразу
(`REGISTRATION_TRIAL_DAYS`). З налаштованою поштою (`RESEND_API_KEY`) адреса підтверджується посиланням
з листа до першого входу; без пошти адреса береться як є. Ліміт: 5 запитів/год з IP на `register` і
`resend-verification`. Поле `website` — honeypot: заповнене → `201 { received: true }` і нічого не створюється.

#### `GET /auth/registration`
Публічний. Що показати на сторінці `#/register`.

**Response 200:** `{ "data": { "mode": "approve", "email_verification": true, "trial_days": 14 } }`

#### `POST /auth/register`
```json
{ "organisation": "Кафе «Полярний»", "email": "owner@example.com", "password": "…15+ символів…", "accept_terms": true, "lang": "uk" }
```
Slug виводиться з назви (транслітерація, `[a-z0-9-]`, унікальність через `-2`, `-3`). `409 email_taken` —
на адресу вже є акаунт. **Response 201:**
```json
{
  "data": {
    "tenant": { "id": "…", "name": "Кафе «Полярний»", "slug": "kafe-poliarnyi", "status": "trial", "trial_expires_at": "…" },
    "verification_required": false,
    "approval_required": false,
    "email_sent": false,
    "access_token": "…", "refresh_token": "…", "user": { "…": "…" }, "tenant": { "…": "…" }, "tenants": []
  }
}
```
Токени є лише коли нічого не лишилось чекати (`verification_required` і `approval_required` обидва `false`) —
тоді відповідь така сама, як у `POST /auth/login`. Інакше вхід відповідає `401 email_not_verified` або
`401 pending_approval`, поки адресу не підтверджено чи організацію не схвалено.

#### `POST /auth/verify-email`
Посилання з листа (`#/verify?email=…&code=…`). `code` — 64 hex; зберігається лише його SHA-256, дійсний
24 години. `400 invalid_code | code_expired`. **Response 200:** `{ "verified": true, "approval_required": false, … }`
плюс токени входу, якщо організація вже відкрита.

#### `POST /auth/resend-verification`
`{ "email": "…", "lang": "uk" }` — новий лист для непідтвердженої адреси; відповідь однакова для будь-якої адреси.

---

### Другий фактор і сесії (plan epic 2.9)

TOTP (RFC 6238, крок 30 с, вікно ±1) з будь-яким застосунком-автентифікатором; секрет зберігається
зашифрованим (AES-256-GCM під `MFA_ENCRYPTION_KEY`, за замовчуванням — `JWT_SECRET`). Код приймається
один раз: крок, з якого він прийшов, запам'ятовується. Усі ендпоїнти, крім `mfa/verify`, потребують Bearer.

#### `POST /auth/mfa/verify`
Публічний, ліміт 10 спроб / 15 хв з IP. Завершує вхід після `require_mfa`.

**Body:** `{ "mfa_token": "eyJ...", "code": "123456" }` — 6 цифр з застосунку або резервний код `xxxx-xxxx`.

**Response 200:** як у `POST /auth/login` (з cookie, `csrf_token`, а за кількох організацій —
`require_tenant_select`). **Помилки:** `401 invalid_token` (mfa_token прострочено — увійти знову),
`401 invalid_mfa_code` (невірний, використаний або старіший за останній прийнятий).

#### `GET /auth/mfa`
```json
{ "data": { "enabled": true, "enabled_at": "2026-09-08T10:00:00Z", "pending": false, "backup_codes_left": 9 } }
```

#### `POST /auth/mfa/setup`
Починає (або перезапускає) налаштування: новий *очікуючий* секрет, який вхід ще не змінює.
`409 mfa_enabled`, якщо фактор уже ввімкнено.
```json
{ "data": { "secret": "JBSWY3DP…", "otpauth_url": "otpauth://totp/ModESP%20Cloud:…", "qr": "data:image/png;base64,…" } }
```

#### `POST /auth/mfa/enable`
**Body:** `{ "code": "123456" }` — перший код із застосунку. Секрет стає чинним, **усі інші сесії
облікового запису закриваються** (вони не проходили другий фактор), резервні коди показуються **один раз**.
```json
{ "data": { "enabled": true, "backup_codes": ["ab12-cd34", "…"], "sessions_closed": 1 } }
```
`400 invalid_mfa_code`, `409 no_setup`.

#### `POST /auth/mfa/disable`
**Body:** `{ "password": "…", "code": "123456" }` — і пароль, і код (або резервний): ні вкрадена сесія, ні
вкрадений телефон окремо фактор не вимкнуть. `401 invalid_credentials | invalid_mfa_code`, `409 mfa_not_enabled`.
**Response 200:** `{ "data": { "enabled": false } }`.

#### `POST /auth/mfa/backup-codes`
**Body:** `{ "code": "…" }`. Нові 10 резервних кодів, старі перестають діяти.

#### `GET /auth/sessions`
Відкриті сесії користувача — одна на пристрій, з поточною позначкою:
```json
{ "data": [
  { "id": "uuid", "current": true, "user_agent": "Mozilla/5.0 …", "ip": "203.0.113.5",
    "tenant_id": "uuid", "tenant_name": "Морозко", "created_at": "…", "last_used_at": "…", "expires_at": "…" }
] }
```

#### `DELETE /auth/sessions`
«Вийти всюди, крім цього пристрою». **Response 200:** `{ "data": { "revoked": 2 } }`.

#### `DELETE /auth/sessions/:id`
Закрити одну сесію (лише свою; чужа — `404`). Для поточної cookie очищується.
**Response 200:** `{ "data": { "revoked": true, "current": false } }`.

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
      "air_temp": 4.5,
      "latitude": 50.4501,
      "longitude": 30.5234,
      "site_id": "uuid",
      "site_name": "АТБ №142",
      "site_city": "Львів",
      "site_region": "Львівська область",
      "site_country": "Україна",
      "site_latitude": 49.844,
      "site_longitude": 24.0262
    }
  ]
}
```

`latitude` / `longitude` — **сирі** координати пристрою; COALESCE з координатами точки тут навмисне
**не** застосовується. Ефективні координати для карти рахує `GET /api/map/devices`. Якби цей ендпоінт
віддавав `COALESCE(d.latitude, s.latitude)`, список «Без координат» на сторінці «Карта» став би
порожнім, а кнопка «Прибрати з карти» виглядала б зламаною: `PATCH {latitude: null}` повертав би
координати точки.

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
  "site_id": "uuid",
  "site_name": "АТБ №142",
  "site_city": "Львів",
  "site_region": "Львівська область",
  "site_country": "Україна",
  "site_latitude": 49.844,
  "site_longitude": 24.0262,
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
  "manufactured_at": "2024-06-15",
  "model_id": "uuid (посилання на device_models)",
  "power_overrides": {
    "compressor_watts": 500,
    "fan_watts": 90
  },
  "latitude": 50.4501,
  "longitude": 30.5234,
  "site_id": "uuid або null"
}
```

- `model_id` — прив'язка до профілю потужності з таблиці `device_models`
- `power_overrides` — JSONB, індивідуальне перевизначення потужності для пристрою (перекриває значення з device_models)
- `latitude` / `longitude` — координати для сторінки «Карта» (lat ∈ [-90, 90], lng ∈ [-180, 180]; `null` прибирає пристрій з карти)
- `site_id` — торгова точка пристрою; `null` відв'язує. **Тільки admin / superadmin** — технік отримує
  **403** `forbidden`. Це поле керує доступом, а не підписом: `middleware/device-access.js` віддає
  пристрій усім, хто має грант `user_sites` на його точку, тож технік із доступом до одного пристрою
  міг би відв'язати його й забрати доступ у колег (або навпаки — розширити). Решта шляхів зміни
  членства (`POST/DELETE /users/:id/sites`, `DELETE /sites/:id?force=true`) теж admin-only.
  Точка перевіряється на приналежність тенанту
  **пристрою** (для superadmin це `tenant_id` рядка пристрою, а не активний тенант сесії). Чужа точка
  дає **400** `invalid_site` — інакше адмін тенанта A міг би прив'язати свій пристрій до побаченого
  UUID точки тенанта B

**Response 200:** оновлений пристрій (без state).

> **CSV-імпорт (фаза 12) приймає нові колонки:** `site_name`, `country`, `region`, `city`,
> `address_line`. Рядок з невідомою назвою точки створює точку в тенанті призначення. Геокодування
> нової точки — fire-and-forget через масову чергу: імпорт на 500 рядків не має чекати на геокодер із
> лімітом 1 запит/с. Рядки, що потрапляють у системний тенант (`pre_register`), `site_id` не отримують
> взагалі — пристрій системного тенанта не може володіти точкою тенанта.

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
Надіслати команду контролеру. Ролі: **admin, technician** (viewer отримує 403 ще до перевірки доступу до
пристрою). Значення перевіряється за `state_meta.json`: тип (`bool`/`int`/`float`), `min`/`max`, крок
`step`; булеві приймають `true/false/1/0`. Ключі, що змінюють роботу обладнання (`thermostat.setpoint`,
`thermostat.differential`, `protection.high_limit`, `protection.low_limit`, `protection.manual_reset`,
`protection.reset_alarms`, `defrost.manual_start`, `defrost.manual_stop`; позначені `dangerous: true` у
`GET /api/meta`), приймаються лише з `confirm: true` — інакше `400 confirmation_required`.

```json
{ "key": "thermostat.setpoint", "value": -18, "confirm": true }
```

**Response 200:** `{ "data": { "device_id": "A4CF12", "key": "thermostat.setpoint", "value": -18, "sent": true } }`

Кожна команда записується в журнал дій як `device.command` (`changes: { key, value, confirmed, dangerous }`).

### `GET /devices/:id/commands?limit=50`
Історія команд пристрою з журналу дій (admin; superadmin — будь-який пристрій).

```json
{ "data": [ { "id": 1, "created_at": "…", "user_email": "tech@example.com", "user_role": "technician",
              "key": "thermostat.setpoint", "value": "-18", "confirmed": true, "dangerous": true, "status_code": 200 } ] }
```

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

## Моделі обладнання (Device Models)

### `GET /device-models`
Список моделей обладнання з профілями потужності.

**Ролі:** admin

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "ModESP-4R",
      "compressor_watts": 450,
      "defrost_watts": 200,
      "fan_watts": 80,
      "standby_watts": 15,
      "created_at": "2026-03-24T10:00:00Z"
    }
  ]
}
```

### `POST /device-models`
Створити модель обладнання.

**Ролі:** admin

**Body:**
```json
{
  "name": "ModESP-4R",
  "compressor_watts": 450,
  "defrost_watts": 200,
  "fan_watts": 80,
  "standby_watts": 15
}
```

### `PATCH /device-models/:id`
Оновити модель обладнання.

**Ролі:** admin

### `DELETE /device-models/:id`
Видалити модель (не можна видалити якщо є пов'язані пристрої).

**Ролі:** admin

---

## Енергомоніторинг

### `GET /devices/:id/energy/summary`
Зведення енергоспоживання пристрою за період.

**Query params:**
- `from`, `to` — ISO діапазон (default: останні 24 години)

**Response 200:**
```json
{
  "data": {
    "total_kwh": 12.45,
    "cost": 37.35,
    "currency": "UAH",
    "energy_source": "estimated",
    "breakdown": {
      "compressor_kwh": 9.80,
      "defrost_kwh": 1.50,
      "fan_kwh": 0.85,
      "standby_kwh": 0.30
    },
    "period": {
      "from": "2026-03-23T00:00:00Z",
      "to": "2026-03-24T00:00:00Z"
    }
  }
}
```

- `energy_source`: `estimated` (розрахунковий за профілем потужності) або `metered` (реальний з CT clamp)
- `cost`: розраховується за тарифом організації (`tenants.electricity_rate`)

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

**Query params:** `active=true`, `from`, `to`, `limit`, `severity=critical,warning`

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

### `POST /alarms/:id/ack`
Взяти аварію в роботу (admin, technician з доступом до пристрою). Один раз на аварію: повторно —
`409 already_acknowledged`. Розсилає WebSocket-подію `alarm_ack`. Списки аварій віддають
`acknowledged_at`, `acknowledged_by_email`, `ack_note`, `escalated_at`.

```json
{ "note": "Виїжджаю, буду за 30 хв" }
```

### `GET /alarms/:id/deliveries`
Журнал доставки сповіщень цієї аварії (admin): канал, статус, помилка, користувач або підписник.

Правила розсилки (push.js): адміністратори організації; техніки/глядачі — через `user_devices ∪
user_sites`; superadmin — лише з `users.receive_all_tenant_alerts`; налаштування користувача
(`GET/PUT /profile/notifications`): увімкнено, мінімальна важливість, канали, тихі години (критичні
й ескалації проходять завжди). Критична аварія без підтвердження за `ALARM_ACK_ESCALATION_MIN`
(15) хв один раз повторно надсилається адміністраторам (`alarms.escalated_at`). Втрата зв'язку —
аварія `device_offline` (warning) через `OFFLINE_ALARM_DELAY_MS` (2 хв) після виявлення офлайну,
закривається першим повідомленням пристрою.

---

## Events (Phase 11a)

### `GET /devices/:id/events`
Історія подій пристрою (compressor on/off, defrost, online/offline).

**Query params:**
- `event_type=compressor_on` — фільтр за типом
- `from`, `to` — ISO діапазон
- `limit=200` — максимум записів (default: 200)

**Response 200:**
```json
{
  "data": [
    {
      "id": 1234,
      "event_type": "compressor_on",
      "payload": null,
      "time": "2026-03-15T10:30:00Z"
    }
  ]
}
```

**Event types:** `device_online`, `device_offline`, `compressor_on`, `compressor_off`, `defrost_start`, `defrost_end`

---

## Maintenance hints (plan epic 2.4)

Аварію визначає контролер; `services/maintenance.js` раз на годину (`MAINTENANCE_EVAL_INTERVAL_MIN`,
0 вимикає) дивиться на історію його аварій у кожній організації з функцією плану `maintenance`
(тариф «Обʼєкт» і вище). Без функції — `402 plan_feature` на всьому, крім `GET /devices/:id/hints`,
який тоді віддає `{ data: [], feature_enabled: false }`.

| `rule_key` | Показник | Дефолт | Вікно |
|---|---|---|---|
| `alarm_repeat` | той самий `alarm_code` від контролера на пристрої, разів за вікно (`device_offline` не рахується) | 3 | 168 год (7 днів) |

Підказка відкривається один раз на (пристрій, код аварії), коли лічильник ≥ межі, оновлює `value`
і `last_seen_at`, поки вікно ще тримає стільки аварій, і закривається з `closed_reason = 'resolved'`,
щойно старі аварії випадають з вікна. Відхилена підказка може відкритись знову наступної години,
якщо аварії нікуди не зникли. Відкриття розсилає WebSocket-подію `hint`
(`{ hint_id, device_id, rule_key, alarm_code, severity, value, threshold, active }`) і сповіщення
адміністраторам організації (`info`, або `warning` за правилом) у Telegram / пошту / web push з назвою
аварії, кількістю та вікном; запис у `notification_log` з `alarm_code = hint:<код аварії>`.

Міграція 034 прибрала пʼять серверних метричних правил (пуски компресора, частка роботи, таймаути
відтайки, відкривання дверей, температура конденсатора): це дублювало логіку прошивки. Їхні відкриті
підказки закрито як `dismissed`.

### `GET /maintenance/hints`
Підказки організації (superadmin — усіх). Query: `active=true|false|all` (default `true`),
`limit` (≤ 200), `offset`. Техніки й глядачі бачать лише свої пристрої (`user_devices ∪ user_sites`).
Кожен рядок: `id, device_id, device_uuid, device_name, device_model, rule_key, alarm_code, severity, value, threshold,
window_hours, opened_at, last_seen_at, closed_at, closed_reason, acknowledged_at, acknowledged_by_email, ack_note,
work_order_id, work_order_status`.

### `GET /devices/:id/hints`
Те саме для одного пристрою (uuid або mqtt id), плюс `feature_enabled`.

### `POST /maintenance/hints/:id/ack`
Взяти в роботу (admin, technician з доступом до пристрою). `{ "note": "..." }` необовʼязково.
Повторно — `409 already_acknowledged`; закрита — `409 closed`. Підказка лишається відкритою.

### `POST /maintenance/hints/:id/dismiss`
Закрити як `dismissed` (admin). Розсилає `hint` з `active: false`.

### `GET /maintenance/rules`
Ефективні правила організації (admin): для кожного `rule_key` — `threshold, window_hours, severity, enabled,
unit, overridden, default { … }, model_overrides [ … ]`.

### `PUT /maintenance/rules/:key`
Перевизначення організації (admin): `{ threshold (≥ 1), window_hours? (1–720), severity?, enabled?, model? }`;
`model` — рядок з `devices.model` для правила лише на цю модель. `?global=1` — платформне значення
(лише superadmin). Невідомий ключ — `404`. WebUI показує вікно в днях і зберігає `days × 24`.

### `DELETE /maintenance/rules/:key[?model=…]`
Прибрати перевизначення (повернутись до платформного). Немає перевизначення — `404`.

### `POST /maintenance/evaluate`
Запустити оцінку зараз (superadmin); відповідь — звіт по організаціях
`{ "<slug>": { opened, refreshed, closed, devices } }`.

---

## Work orders (plan epic 2.3)

Наряд звʼязує аварію чи рекомендацію з техніком, точкою і візитом. Статуси:
`new → assigned → in_progress → done | cancelled`. Видимість: адмін бачить усі наряди організації,
технік і глядач — призначені їм і на пристроях, які вони можуть відкрити (`user_devices ∪ user_sites`).
Кожен рядок: `id, title, description, priority (low|normal|high|urgent), status, device_id (uuid),
device_mqtt_id, device_name, site_id, site_name, site_city, site_address, maps_url, alarm_id, hint_id,
assigned_to, assigned_to_email, created_by_email, scheduled_at, assigned_at, started_at, closed_at,
closed_reason, service_record_id, created_at`.

### `GET /work-orders`
Query: `status=open|closed|all|<status>` (default `open`), `mine=1`, `device_id`, `site_id`, `limit` (≤ 200), `offset`.
Сортування: терміновість, потім найновіші.

### `POST /work-orders`
Створити (admin; technician — лише на пристрої з доступом і лише `assigned_to` = себе).
```json
{ "title": "Висока температура — камера №1", "device_id": "WO0001", "alarm_id": 42,
  "priority": "high", "assigned_to": "<user uuid>", "scheduled_at": "2026-09-06T08:00:00Z" }
```
`device_id` — uuid або mqtt id; `site_id` береться з пристрою, якщо не передано; потрібен хоча б один із них.
`alarm_id` / `hint_id` мають належати організації (і цьому пристрою). Непідтверджена аварія чи
підказка підтверджується автоматично з приміткою `Наряд #N`. Виконавцю (крім самого себе) надходить
сповіщення `work_order` з адресою точки і `maps_url`; WebSocket `work_order` (`action: created`).

### `GET /work-orders/:id`
Деталі + `alarm`, `hint`, `service_record` (або `null`).

### `PATCH /work-orders/:id`
`title, description, priority, scheduled_at` — admin або виконавець; закритий наряд — `409 closed`.

### `POST /work-orders/:id/assign`
`{ "user_id": "<uuid>" }` — admin: будь-який активний technician/admin організації; technician: лише
себе і лише непризначений наряд (`409 already_assigned`). Новий виконавець отримує сповіщення.

### `POST /work-orders/:id/start`
Виконавець або admin → `in_progress` (`409 already_started`).

### `POST /work-orders/:id/close`
```json
{ "work_done": "Замінено пускове реле", "duration_min": 95, "cost": 1450, "cost_currency": "UAH",
  "parts": [{ "name": "Реле пускове", "qty": 1, "cost": 850 }], "service_date": "2026-09-05", "reason": "…" }
```
Виконавець або admin. Пише `service_records` (`user_id`, `work_order_id`, `technician` = e-mail, `reason`
за замовчуванням — назва наряду) і переводить наряд у `done`; відповідь містить `service_record_id`.

### `POST /work-orders/:id/cancel`
`{ "reason": "…" }` (admin) → `cancelled`.

### `GET /work-orders/stats`
`from`, `to` (default 30 днів): `total, new, assigned, in_progress, done, cancelled, from_alarms, from_hints,
avg_assign_min, avg_start_min, avg_close_min` (admin, technician).

### `GET /work-orders/assignees`
Активні техніки й адміни організації (admin): `id, email, role, base_address`.

### `GET /devices/:id/work-orders`
Наряди одного пристрою (`status=open` — лише відкриті), будь-яка роль із доступом до пристрою.

Списки `GET /alarms`, `GET /devices/:id/alarms` і `GET /maintenance/hints` віддають `work_order_id` і `work_order_status`
останнього наряду, створеного з цієї аварії чи підказки.

---

## Data Export

Усі export-ендпоінти захищені rate limiter (10 req/min/user). Кожне завантаження (і GET також)
пишеться в `audit_log` (`export.telemetry_csv`, `export.inventory_csv`, `export.alarms_csv`,
`export.haccp_pdf`, `export.haccp_site_pdf`) — інспектор чи клієнт завжди може дізнатися, хто і
коли формував документ. PDF-звіти доступні лише планам із функцією `reports` (інакше
`402 plan_feature`).

### `GET /devices/:id/telemetry/export.csv`
CSV export телеметрії пристрою.

**Query params:** `from`, `to` (ISO), `channels=air,evap` (optional)

**Headers:**
- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="telemetry_{deviceId}_{from}_{to}.csv"`

Включає UTF-8 BOM для сумісності з Excel. Max 500k рядків. RFC 4180.

### `GET /devices/export/inventory.csv`
CSV інвентаризація всіх пристроїв тенанту (раніше `GET /devices/export.csv`; старий шлях
більше не існує — він конфліктував з `/devices/:id`).

**Columns:** Device ID, Name, Location, Serial, Model, Firmware, Online, Last Seen (+ Tenant для superadmin)

### `GET /alarms/export.csv`
CSV export алармів.

**Query params:** `from`, `to` (ISO, default: 24h, max: 90 днів), `active=true`, `severity=critical,warning`

**Columns:** Device, Device Name, Alarm Code, Severity, Active, Value, Limit, Started, Cleared (+ Tenant для superadmin)

### `GET /devices/:id/telemetry/export.pdf`
Журнал контролю температури HACCP для одного пристрою (PDF) — документ, який можна показати
інспектору.

**Query params:**
- `from`, `to` (ISO). Первинні вимірювання — до 31 дня; якщо період старший за зберігання
  сирих даних плану (`plan_limits.retention_days`), звіт будується з погодинного архіву
  `telemetry_hourly` (до 366 днів у одному звіті, архів зберігається 3 роки)
- `channels=air,evap,setpoint` (default: air,evap,setpoint)
- `bucket=1h` — `5m`, `15m`, `1h`, `6h`, `1d` (default `1h`). На архівних даних bucket
  розширюється щонайменше до `1h`; для довгих періодів — до `6h`/`1d`, щоб таблиця не
  перевищила 10 000 рядків
- `lang=uk|en|pl|de` (default: мова організації або `uk`)

**Headers відповіді:** `X-Report-Code` (`XXXX-XXXX-XXXX`), `X-Report-Sha256`, `X-Report-Source`
(`raw` | `hourly`); усі три відкриті через `Access-Control-Expose-Headers`.

**Вміст PDF:**
- Заголовок мовою звіту; організація (`tenants.legal_name`, код ЄДРПОУ/ІПН), точка з адресою
  і часовим поясом (`tenant_settings.timezone`, для точки — `sites.timezone`)
- Обладнання: назва, ідентифікатор, серійний номер, модель; період і інтервал; хто і коли
  сформував; джерело даних
- Підсумок по каналах (мін/макс/сер., кількість вимірювань), аварії за період
  (з відміткою підтвердження), температурний журнал у **місцевому часі точки**
- Примітка про датчики з останнім сервісним записом, блок «Відповідальна особа / посада /
  підпис / дата»
- Футер на кожній сторінці: код перевірки, SHA-256 даних звіту, URL перевірки

**Помилки:** `400 validation_failed` (дати, bucket), `404 no_data` (за період немає даних —
порожній «журнал» не формується), `402 plan_feature`.

### `GET /sites/:id/export.pdf`
Той самий журнал для всіх активних пристроїв точки (до 50) — один документ, розділ на
пристрій. Admin бачить усі точки організації; technician/viewer — лише з грантом у
`user_sites` (інакше `403`). Параметри й заголовки — як у пристрою.

### Планові звіти (plan epic 2.7)

Розклад (`report_schedules`) — «стояче замовлення»: щотижня або щомісяця звіт однієї точки (або кожної
точки організації) формується за період, що щойно завершився, зберігається в архіві і йде одержувачам
листом із PDF у вкладенні. Періоди — цілі місцеві тижні (пн–нд) і місяці в часовому поясі точки
(організації — для розкладу «усі точки»); відправка о 06:00 місцевого часу 1-го числа або в понеділок
(`REPORT_SCHEDULE_INTERVAL_MIN`, типово щогодинна перевірка). Період ніколи не йде двічі: розклад
пам'ятає кінець останнього доставленого періоду, ручний запуск теж рахується. Три типи: `haccp` —
той самий документ, що й `GET /sites/:id/export.pdf`; `alarms` — аварії точки за період (підсумок за
важливістю й обладнанням, час до підтвердження, журнал; тиждень без аварій — теж документ); `energy` —
кВт·год з каналу `energy` на кожен пристрій, години роботи компресора з подій, вартість за тарифом
організації (потребує функції плану `energy`). Функція плану `reports` потрібна для всього розділу.

#### `GET /reports/schedules` · `POST /reports/schedules`
**Ролі:** admin. Body створення:
```json
{ "site_id": "uuid | null", "type": "haccp | alarms | energy", "cadence": "monthly | weekly",
  "recipients": ["haccp@company.ua"], "lang": "uk", "bucket": "1h", "enabled": true }
```
`site_id: null` — усі точки організації (один лист, окремий PDF на точку, до 10 вкладень на лист).
`recipients` — 1–10 адрес. До 50 розкладів на організацію (`409 limit_reached`). **Response 201:**
```json
{ "data": { "id": "uuid", "site_id": "uuid", "site_name": "Магазин №1", "type": "haccp", "cadence": "monthly",
  "recipients": ["haccp@company.ua"], "lang": "uk", "bucket": "1h", "enabled": true,
  "next_run_at": "2026-10-01T03:00:00Z", "last_run_at": null, "last_period_to": null, "last_status": null, "last_error": null,
  "created_by": "admin@company.ua", "created_at": "…", "updated_at": "…" } }
```
`last_status`: `ok` (надіслано з вкладенням) | `empty` (даних не було, лист без вкладення) | `error` (`last_error`
пояснює: `plan_feature`, помилка пошти чи генерації). `402 plan_feature` без функції `reports` (або `energy`
для цього типу).

#### `PATCH /reports/schedules/:id` · `DELETE /reports/schedules/:id`
**Ролі:** admin. Ті самі поля, всі необов'язкові; зміна періодичності або точки перераховує `next_run_at`.
Видалення розкладу не чіпає сформованих звітів (`report_exports.schedule_id` стає NULL).

#### `POST /reports/schedules/:id/run`
**Ролі:** admin. Сформувати й надіслати звіт за останній цілий період зараз (повторно — теж, якщо вже йшов).
```json
{ "data": { "status": "ok", "emailed": true, "period": { "from": "…", "to": "…" }, "tz": "Europe/Kyiv", "next_run_at": "…",
  "reports": [ { "site_id": "uuid", "site": "Магазин №1", "code": "ABCD-EFGH-JKLM", "file_name": "haccp_Магазин_1_2026-08-01_2026-08-31.pdf",
                 "empty": false, "error": null, "source": "raw" } ] } }
```

#### `GET /reports`
Архів організації — усе з `report_exports`, найновіше зверху. **Ролі:** будь-яка; технік і переглядач бачать
лише звіти своїх точок і пристроїв. Query: `type=haccp|alarms|energy`, `site_id`, `scheduled=true`,
`limit` (≤200), `offset`.
```json
{ "data": [ { "code": "ABCD-EFGH-JKLM", "kind": "site", "report_type": "haccp", "device_id": null, "device_name": null,
              "site_id": "uuid", "site_name": "Магазин №1", "period_from": "…", "period_to": "…", "bucket": "1h", "source": "raw",
              "lang": "uk", "generated_by": "schedule", "generated_at": "…", "schedule_id": "uuid",
              "file_name": "haccp_….pdf", "bytes": 48213, "archived": true } ],
  "meta": { "total": 1, "limit": 50, "offset": 0 } }
```
`archived: true` — PDF збережено і його можна завантажити; разові експорти реєструють лише код і хеш.
`REPORT_ARCHIVE_DAYS` (типово 3 роки) — після цього PDF видаляється, код і SHA-256 лишаються для перевірки.

#### `GET /reports/:code/download`
PDF планового звіту з архіву (`Content-Type: application/pdf`, заголовки `X-Report-Code`, `X-Report-Sha256`,
`X-Report-Source`, ім'я файла за RFC 5987). `404`, якщо звіту немає, він не з архіву або точка недоступна.


### `GET /api/public/report/:code`
Перевірка справжності звіту. **Без автентифікації**, лімітер `/api/public`. Код із футера
(дефіси й регістр не важливі). Повертає лише те, що вже надруковано у звіті:

```json
{
  "data": {
    "code": "K7Q2-M9XA-4H3P",
    "kind": "device",
    "organisation": "ТОВ «Морозко»",
    "site": "Магазин №1",
    "device": "Вітрина 1",
    "period_from": "2026-08-01T00:00:00.000Z",
    "period_to": "2026-08-31T23:59:59.000Z",
    "bucket": "1h",
    "source": "raw",
    "lang": "uk",
    "sha256": "3c1f…",
    "generated_at": "2026-09-02T09:12:41.000Z",
    "valid": true
  }
}
```

Невідомий код — `404 not_found` без деталей. Жодних ідентифікаторів, телеметрії чи даних
користувачів у відповіді немає.

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

## Торгові точки (Sites)

Торгова точка — фізичний об'єкт (магазин, склад, цех), до якого прив'язані пристрої. Один пристрій
належить максимум одній точці (`devices.site_id`), одна точка тримає скільки завгодно пристроїв.
Адреса живе на точці; `devices.location` лишається вільним описом місця **всередині** точки
(«Зал, ряд 3»).

**Спільні правила всіх ендпоінтів `/sites`:**

- Кожен запит обмежений `tenant_id`; superadmin має звичний cross-tenant bypass і додатковий
  query-параметр `tenant_id`.
- `GET /sites` і `GET /sites/:id` пропущені через `filterDeviceAccess`. Лічильники
  (`device_count`, `online_count`, `alarm_count`) рахуються по **видимому** набору пристроїв, а точка,
  в якій викликач не бачить жодного пристрою, у видачу не потрапляє взагалі.
- Будь-який `:id`, `:siteId`, `:linkId` не-UUID формату повертає **404**, не 400 — щоб зіпсований
  ідентифікатор не відрізнявся від неіснуючого.
- `POST` / `PATCH` / `DELETE` і все керування публічними посиланнями — тільки `admin`.

### `GET /sites`
Список точок тенанта зі зведеними лічильниками пристроїв.

**Query params:**
- `search=атб` — пошук по назві, місту, адресі
- `country_code=UA`, `region=Львівська область`, `city=Львів` — фільтри
- `tenant_id=uuid` — тільки superadmin

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "АТБ №142",
      "country_code": "UA",
      "country": "Україна",
      "region": "Львівська область",
      "city": "Львів",
      "address_line": "просп. Свободи, 28",
      "postal_code": "79000",
      "latitude": 49.844,
      "longitude": 24.0262,
      "geo_source": "geocoded",
      "geo_precision": "house",
      "geocoded_at": "2026-08-23T09:12:00Z",
      "timezone": "Europe/Kyiv",
      "notes": null,
      "device_count": 10,
      "online_count": 9,
      "alarm_count": 1,
      "created_at": "2026-08-23T09:10:00Z",
      "updated_at": "2026-08-23T09:12:00Z"
    }
  ]
}
```

`geo_source`: `none` (координат ще немає) · `geocoded` (від Nominatim) · `manual` (задано людиною) ·
`failed` (3+ невдалі спроби; причина в `geo_error`).

### `POST /sites`
Створити точку.

**Ролі:** admin

**Body:**
```json
{
  "name": "АТБ №142",
  "country_code": "UA",
  "country": "Україна",
  "region": "Львівська область",
  "city": "Львів",
  "address_line": "просп. Свободи, 28",
  "postal_code": "79000",
  "latitude": null,
  "longitude": null,
  "timezone": null,
  "notes": null,
  "tenant_id": "uuid (тільки superadmin)"
}
```

Обов'язкове тільки `name`. Якщо координати не передані, а адреса є — виконується inline-геокодування
(best effort, структурований запит до Nominatim). Виклик **не чекає** на геокодер довше 5 секунд:
якщо черга зайнята, точка створюється з `geo_source: "none"`, а фонова задача дописує координати
пізніше. Геокодер вимкнений або недоступний — точка все одно створюється.

**Response 201:** `{ "data": { ...site } }`

**409** — назва вже зайнята в цьому тенанті (унікальний індекс `uq_sites_tenant_name`). Порівняння
регістро- і пробіло-нечутливе: «АТБ №142» і « атб №142 » — одна назва.

### `GET /sites/:id`
Точка з переліком її пристроїв.

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "name": "АТБ №142",
    "city": "Львів",
    "latitude": 49.844,
    "longitude": 24.0262,
    "timezone": "Europe/Kyiv",
    "device_count": 2,
    "online_count": 2,
    "alarm_count": 0,
    "devices": [
      { "id": "uuid", "mqtt_device_id": "A4CF12", "name": "Камера №1", "online": true, "alarm_active": false }
    ]
  }
}
```

### `PATCH /sites/:id`
Оновити точку. Мінімум одне поле.

**Ролі:** admin

**Body** (будь-яка підмножина):
```json
{
  "name": "АТБ №142",
  "country_code": "UA",
  "country": "Україна",
  "region": "Львівська область",
  "city": "Львів",
  "address_line": "просп. Свободи, 30",
  "postal_code": "79000",
  "latitude": 49.844,
  "longitude": 24.0262,
  "timezone": "Europe/Kyiv",
  "notes": "Вхід з двору"
}
```

**Не приймаються ніколи:** `id`, `tenant_id`, `geo_source`, `geo_precision`, `geocoded_at`,
`geo_attempts`, `geo_error`, `osm_type`, `osm_id`, `created_at`. Зокрема `tenant_id` — зміна тенанта
точки перенесла б разом із нею видимість усіх її пристроїв на карті та всі гранти `user_sites`.

**Зміна адреси запускає повторне геокодування, але нічого не стирає.** `latitude`, `longitude`,
`geo_source`, `geo_precision`, `geocoded_at` перезаписуються **тільки при успіху**. Якщо геокодер
вимкнений, у таймауті або віддав порожній результат — попередні координати лишаються на місці.
Виправлення друкарської помилки в адресі під час недоступності Nominatim не має стирати точку з карти.

**Response 200:** `{ "data": { ...site } }`

### `DELETE /sites/:id`
Видалити точку.

**Ролі:** admin

**Query params:** `force=true` — відв'язати пристрої (`site_id = NULL`) і видалити точку.
Прапорець парситься строго: `?force=false` і `?force=0` означають **не** force.

**409, якщо на точці є пристрої і `force` не переданий:**
```json
{
  "error": "site_has_devices",
  "message": "Site has 10 attached devices",
  "status": 409,
  "device_count": 10
}
```

**Response 200:**
```json
{ "data": { "deleted": true } }
```

Примусове видалення виконується в транзакції і пише в аудит перелік відв'язаних пристроїв разом із
прапорцем `force` — інакше воно було б не відрізнити від видалення порожньої точки, тоді як
`devices.site_id` занулено безповоротно.

### `POST /sites/:id/geocode`
Примусово перегеокодувати точку.

**Ролі:** admin

**Response 200** — завжди 200, навіть коли нічого не сталося:
```json
{
  "data": { "...site": "..." },
  "meta": { "geocoder": "ok" }
}
```

`meta.geocoder`: `ok` (координати оновлено) · `disabled` (`GEOCODER_PROVIDER` порожній або `none`) ·
`failed` (провайдер не відповів або збігів немає — `geo_attempts` збільшено, координати не змінені).
UI показує причину замість мовчазного no-op.

### `GET /sites/:id/weather`
Поточна погода та прогноз на точці (Open-Meteo).

**Ролі:** будь-яка автентифікована. **Доступ до точки** — той самий, що й у `GET /sites/:id`: бачити
хоча б один пристрій на точці або мати грант `user_sites`, інакше **404**. Погода — публічні дані, а от
«які `site_id` існують у тенанті» — ні, тож ендпоінт не має бути оракулом існування точок.

**Rate limit:** 30 запитів/хв на користувача.

**Response 200:**
```json
{
  "data": {
    "current": {
      "observed_at": "2026-08-23T09:00:00Z",
      "temp_c": 27.4,
      "humidity": 41,
      "pressure_hpa": 1012.3,
      "wind_ms": 3.1,
      "weather_code": 1
    },
    "forecast": {
      "hourly": [
        { "time": "2026-08-23T10:00:00Z", "temp_c": 28.1, "humidity": 39, "weather_code": 1 }
      ]
    },
    "timezone": "Europe/Kyiv"
  }
}
```

`{ "data": null }` — погода вимкнена (`WEATHER_PROVIDER` порожній), у точки немає координат, або
провайдер не відповів. Ніколи не 500.

### `GET /sites/:id/weather/history`
Історія зовнішніх умов з `weather_observations` (без звернення до провайдера).

**Ролі та доступ до точки:** як у `GET /sites/:id/weather` вище — інакше **404**.

**Query params:** `from`, `to` (ISO). Некоректна дата → **400** `validation_failed`.

**Response 200:**
```json
{
  "data": [
    { "observed_at": "2026-08-22T09:00:00Z", "temp_c": 25.8, "humidity": 44,
      "pressure_hpa": 1011.0, "wind_ms": 2.4, "weather_code": 0 }
  ]
}
```

Це джерело даних для накладення «зовнішня температура» на графік телеметрії пристрою — саме воно
пояснює стрибки навантаження і просідання COP.

### `GET /sites/:id/nearest-technicians`
Найближчі до точки техніки, відсортовані за відстанню.

**Ролі:** admin, technician (для `viewer` — 403: це перелік персоналу)

**Доступ до самої точки:** той самий, що й у `GET /sites/:id` — викликач має бачити хоча б один
пристрій на точці або мати грант `user_sites`, інакше **404**. Без цієї перевірки будь-який технік міг
би опитати будь-який `site_id` тенанта, а три такі запити тріангулюють домашню базу колеги — саме те,
що маскування `base_address` нижче й приховує.

**Query params:** `limit` — 1..50, за замовчуванням 5.

**Response 200** (для `admin` / `superadmin`):
```json
{
  "data": [
    { "id": "uuid", "email": "tech@example.com", "distance_km": 12.4,
      "duration_s": 1080, "base_address": "Львів, вул. Городоцька 100" }
  ]
}
```

Беруться користувачі **того ж тенанта** з роллю `technician`/`admin`, `active = true` і заповненою
домашньою базою (`users.base_latitude` / `base_longitude`). Відстань — haversine; `duration_s` — реальний
час у дорозі, коли налаштований `OSRM_URL`, інакше `null`.

Для викликача з роллю `technician` `email` маскується (`t***@example.com`), `base_address` повертається
як `null`, а `distance_km` округлюється до **цілих кілометрів** (для admin/superadmin — до 0.1 км).
Округлення навмисне: 0.1 км по трьох точках дає координату бази з точністю ~100 м. Жодних інших полів
користувача (hash пароля, токени, telegram_id) у відповіді немає ніколи.

### `GET /sites/:id/public-links`
Публічні посилання точки.

**Ролі:** admin

**Response 200:**
```json
{
  "data": [
    { "id": "uuid", "label": "Для клієнта", "expires_at": "2026-11-21T09:00:00Z",
      "revoked_at": null, "view_count": 37, "last_viewed": "2026-08-23T08:40:00Z",
      "created_at": "2026-08-23T09:00:00Z" }
  ]
}
```

Токен у списку **не повертається** — у базі лежить лише його sha256.

### `POST /sites/:id/public-links`
Створити публічне посилання. Сирий токен повертається **рівно один раз**.

**Ролі:** admin

**Body:**
```json
{ "label": "Для клієнта", "expires_at": "2026-11-21T09:00:00Z" }
```

Обидва поля опціональні; `expires_at` за замовчуванням — 90 днів. Безстрокового посилання не буває.

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "token": "SHOWN_ONCE_base64url_token",
    "label": "Для клієнта",
    "expires_at": "2026-11-21T09:00:00Z"
  }
}
```

Посилання для людини складається з токена: `https://<host>/#/public/site/<token>`.

Токен — 32 випадкові байти. Він не пишеться в логи і не потрапляє в `audit_log` (там лише `site_id`,
`label`, `expires_at`): `audit_log` захищений тригером незмінності, тож витерти звідти токен було б
неможливо.

### `DELETE /sites/:id/public-links/:linkId`
Відкликати посилання (`revoked_at = NOW()`).

**Ролі:** admin

**Response 200:** `{ "data": { "deleted": true } }`

### `POST /sites/geocode-pending`
Фонове геокодування точок із `geo_source = 'none'`.

**Ролі:** admin
**Rate limit:** 30 запитів/хв на користувача.

**Query params:** `retry_failed=true` — включити також точки з `geo_source = 'failed'`.

**Response 200:**
```json
{ "data": { "queued": 12 } }
```

Можливі відмови, обидві зі статусом 200:
- `{ "data": { "queued": 0, "reason": "bulk_disabled" } }` — `GEOCODER_BULK_ENABLED=false` (значення
  за замовчуванням). Політика OSM забороняє систематичні масові запити до публічного Nominatim
  незалежно від темпу, тому вмикати це можна лише для self-hosted інстансу.
- `{ "data": { "queued": 0, "reason": "sweep_in_progress" } }` — попередній прохід ще працює.
  Прапорець «прохід триває» тримається **на тенант**, а не на процес: прохід на 50 точок при
  `GEOCODER_RATE_LIMIT_MS=1100` займає близько хвилини, і спільний прапорець блокував би адмінів усіх
  інших тенантів. Він усе ще в памʼяті процесу — за двох воркерів позаду nginx кожен матиме свій, і
  тоді потрібен advisory lock у Postgres на `tenant_id`.

Один прохід обмежений 50 точками. Черга геокодера має два пріоритети: інтерактивні запити (створення
точки, `/geo/*`) завжди обганяють масові.

### `GET /sites/geocode-status`
Прогрес геокодування для індикатора в UI.

**Response 200:**
```json
{ "data": { "pending": 12, "geocoded": 180, "failed": 3 } }
```

`pending` = `geo_source='none'`, `geocoded` = `geo_source IN ('geocoded','manual')`,
`failed` = `geo_source='failed'`.

---

## Геокодування (Geo)

Проксі до Nominatim. **Браузер ніколи не звертається до Nominatim напряму** — так у провайдера є один
ідентифікований `User-Agent`, один rate limiter (1 запит/с) і один спільний кеш, як того вимагає
політика використання OSM.

Обидва ендпоінти доступні будь-якому автентифікованому користувачу і обмежені **30 запитами/хв на
користувача**. Будь-яка помилка провайдера (таймаут, 429, 5xx, зіпсована відповідь, вимкнений
геокодер) дає **200 з порожнім результатом**, ніколи 500.

### `GET /geo/search`
Пошук адреси (автодоповнення).

**Query params:** `q` (до 200 символів), `limit` (1..10)

**Response 200:**
```json
{
  "data": [
    {
      "display_name": "просп. Свободи, 28, Львів, Львівська область, 79000, Україна",
      "latitude": 49.844,
      "longitude": 24.0262,
      "precision": "house",
      "address": {
        "country_code": "UA",
        "country": "Україна",
        "region": "Львівська область",
        "city": "Львів",
        "address_line": "просп. Свободи, 28",
        "postal_code": "79000"
      }
    }
  ]
}
```

`precision`: `house` · `street` · `city` · `region` · `country`.

> **Київ не має `region`.** Місто зі спеціальним статусом не повертає `address.state`, тоді як
> Львів/Харків/Одеса/Дніпро повертають «... область» коректно. У такому разі `region` заповнюється
> назвою міста, щоб Київ групувався у власний регіон, а не в кошик «невідомий регіон».

### `GET /geo/reverse`
Зворотне геокодування — координати в адресу (використовується при перетягуванні маркера).

**Query params:** `lat`, `lon`

**Response 200:** один об'єкт тієї ж форми, або `{ "data": null }`.

---

## Карта (Map)

Усі ендпоінти монтуються під `/api/map`, всі проходять `filterDeviceAccess` і всі обмежені
`tenant_id`. Точка, в якій викликач не бачить жодного пристрою, не дає жодного Feature — ані на карті,
ані в теплокарті аварій.

Валідація параметрів виконується **до** будь-якого SQL чи зовнішнього виклику: `bbox` — рівно чотири
скінченні числа в допустимих діапазонах і `min <= max`; `from`/`to` — ISO-дати; `status` — з білого
списку. Некоректне значення дає **400** `validation_failed`, ніколи 500.

### `GET /map/devices`
GeoJSON-шар карти. Один Feature на **точку** плюс синтетичні Feature для пристроїв із власними
координатами без точки.

**Query params:**
- `tenant_id` (superadmin), `user_id` (тільки admin — інакше будь-хто перелічив би призначення чужого
  користувача), `site_id`
- `country_code`, `region`, `city`
- `status=online|offline|alarm|all`
- `model`, `firmware_version`
- `q` — вільний пошук по назві, `mqtt_device_id`, `location`, назві точки
- `bbox=minLon,minLat,maxLon,maxLat`

**Response 200:**
```json
{
  "data": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [24.0262, 49.844] },
        "properties": {
          "site_id": "uuid",
          "site_name": "АТБ №142",
          "city": "Львів",
          "region": "Львівська область",
          "country": "Україна",
          "country_code": "UA",
          "tenant_slug": "acme",
          "device_count": 10,
          "online_count": 9,
          "offline_count": 1,
          "alarm_count": 1,
          "devices": [
            { "id": "uuid", "mqtt_device_id": "A4CF12", "name": "Камера №1",
              "online": true, "alarm_active": false, "air_temp": -18.4 }
          ]
        }
      }
    ]
  },
  "meta": { "total_sites": 42, "total_devices": 310, "ungeocoded_devices": 7 }
}
```

FeatureCollection лежить **у `data`**, а не на верхньому рівні — це загальна форма відповіді всього
API. `meta.ungeocoded_devices` живить лічильник «Без координат» у UI.

Координати пристрою на карті — `COALESCE(devices.latitude, sites.latitude)`: власні координати
пристрою перекривають координати точки. (У `GET /devices` цей COALESCE **не** застосовується — там
повертаються сирі колонки пристрою.)

**Синтетичні Feature без точки** (`site_id: null` — пристрій із власними координатами, але без
торгової точки) додатково несуть у `properties` поля самого пристрою: `device_id`, `mqtt_device_id`,
`name`, `online`, `alarm_active`, `air_temp`. Це те, що читає `MapCanvas` для заголовка попапа,
температури й посилання «Відкрити пристрій», і те, на чому `lib/geo.js featureKey()` будує стабільний
ключ маркера — без `device_id` два пристрої з однаковими округленими координатами злилися б в один
маркер. У Feature торгової точки цих полів немає: там заголовок — `site_name`.

### `GET /map/filters`
Значення для випадних списків фільтрів, з кількостями.

**Response 200:**
```json
{
  "data": {
    "countries": [{ "code": "UA", "name": "Україна", "count": 40 }],
    "regions": [{ "name": "Львівська область", "count": 12 }],
    "cities": [{ "name": "Львів", "count": 9 }],
    "models": [{ "name": "ModESP-4R", "count": 120 }],
    "firmware_versions": [{ "version": "1.2.3", "count": 88 }],
    "tenants": [{ "id": "uuid", "slug": "acme", "name": "Acme Corp", "count": 40 }],
    "users": [{ "id": "uuid", "email": "tech@example.com", "count": 15 }]
  }
}
```

`tenants` присутній тільки для superadmin, `users` — тільки для admin і вище. Технік не отримує жодного
з цих ключів.

### `GET /map/alarm-heatmap`
Теплокарта аварій за період — агрегується в SQL, не в JS.

**Query params:** `from`, `to` + усі фільтри `GET /map/devices`.

**Response 200:**
```json
{
  "data": [[49.844, 24.0262, 12], [50.4498, 30.5231, 3]],
  "meta": { "max_weight": 12, "total": 15 }
}
```

`meta.max_weight` обов'язковий для клієнта: без нього шар `L.heatLayer` нормалізується відносно свого
дефолту 1.0 і малює суцільну пляму.

### `GET /map/isochrones`
Зони доїзду навколо точки.

**Ролі:** admin, technician
**Rate limit:** 30 запитів/хв на користувача.

**Query params:** `lat`, `lon`, `minutes=15,30,60` — **максимум 3** значення, кожне 1..120.
Більше або поза діапазоном → 400 (інакше один запит `minutes=1,2,...,500` спалює всю квоту ORS).

**Response 200:**
```json
{
  "data": { "type": "FeatureCollection", "features": [ { "type": "Feature", "properties": {
    "minutes": 15, "approximate": true, "provider": null, "assumed_speed_kmh": 30 } } ] },
  "meta": { "approximate": true, "provider": null, "minutes": [15, 30, 60], "assumed_speed_kmh": 30 }
}
```

- З `ORS_API_KEY` — справжні ізохрони від OpenRouteService, `approximate: false`.
- Без ключа (значення за замовчуванням), а також при таймауті чи помилці ORS — **кільця прямої
  відстані** за середньою швидкістю 30 км/год, `approximate: true`. Гейт стоїть саме на **ключі**, а не
  на `ORS_URL`: демо-конфігурація постачає URL заповненим і ключ порожнім.
- `approximate` дублюється в `properties` **кожного** Feature, а не тільки в `meta` — прапорець має
  подорожувати разом із геометрією, яку малюють, кешують чи експортують.
- **UI зобов'язаний видимо позначати наближені кільця як наближені.** Рішення про виїзд не має
  спиратися на коло, яке користувач вважає полігоном часу доїзду.

### `POST /map/route`
Маршрут обʼїзду по точках (OSRM `/trip` — оптимізація порядку, або `/route`).

**Ролі:** admin, technician
**Rate limit:** 30 запитів/хв на користувача.

**Body:**
```json
{
  "site_ids": ["uuid", "uuid", "uuid"],
  "start": { "lat": 49.8397, "lon": 24.0297 },
  "roundtrip": true
}
```

`site_ids` — від 1 до 25 UUID. Кожен перевіряється на приналежність тенанту викликача **і** на
видимість під його RBAC — до будь-якого зовнішнього виклику.

Координати точки беруться **ефективні**, як і на карті: власні `sites.latitude/longitude`, а якщо їх
немає — координати першого розміщеного пристрою цієї точки (з видимих викликачеві). Інакше точка, яку
`GET /map/devices` намалював, давала б **400** `invalid_site` при спробі додати її в обʼїзд. Точка,
яку карта намалювати не може, лишається **400** `invalid_site` зі списком `site_ids`.

**Response 200:**
```json
{
  "data": {
    "order": ["uuid-2", "uuid-1", "uuid-3"],
    "legs": [{ "from": "uuid-2", "to": "uuid-1", "distance_m": 4120, "duration_s": 540 }],
    "geometry": { "type": "LineString", "coordinates": [[24.03, 49.84]] },
    "total_distance_m": 18400,
    "total_duration_s": 2460,
    "google_maps_url": "https://www.google.com/maps/dir/?api=1&origin=49.8397,24.0297&destination=..."
  },
  "meta": { "optimized": true, "provider": "osrm" }
}
```

**Деградація — теж 200.** Коли `OSRM_URL` порожній, сервер у таймауті або віддав не-2xx:
`order` рахується жадібним «найближчий сусід» по haversine, `total_distance_m` — сума по прямій,
`legs` і `geometry` — `null`, `total_duration_s` — `null`, `meta.optimized = false`,
`meta.provider = null`. `google_maps_url` працює завжди — це звичайне посилання, йому не потрібен
жоден API. UI підписує такий результат як «орієнтовно, без оптимізації за часом у дорозі».

---

## Гео-статистика

### `GET /stats/geo`
Метрики по країнах / регіонах / містах / точках із деталізацією вглиб.

**Query params:**
- `group_by=country|region|city|site` (за замовчуванням `country`) — **білий список**; будь-яке інше
  значення дає 400
- `from`, `to` — ISO
- плюс усі фільтри `GET /map/devices`

**Response 200:**
```json
{
  "data": [
    {
      "key": "UA",
      "label": "Україна",
      "device_count": 310,
      "online_count": 298,
      "offline_count": 12,
      "alarm_count": 4,
      "alarms_period": 57,
      "avg_air_temp": -18.2,
      "uptime_pct": 99.1,
      "energy_kwh": 12480.5,
      "service_visits": 8
    }
  ],
  "meta": {
    "group_by": "country",
    "from": "2026-07-23T00:00:00Z",
    "to": "2026-08-23T00:00:00Z",
    "totals": { "device_count": 310, "alarms_period": 57, "energy_kwh": 12480.5 }
  }
}
```

`energy_kwh` рахується за енергомоделлю фази 13, `service_visits` — записи `service_records` у
періоді, `alarms_period` — аварії у періоді. Метрика, яку не можна порахувати дешево, повертається як
`null` — вигаданих нулів немає.

### `GET /stats/geo/export.csv`
Той самий набір даних у CSV, з тими самими фільтрами і тим самим RBAC.

**Headers:**
- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="geo_stats_{group_by}_{from}_{to}.csv"`

Включає UTF-8 BOM для сумісності з Excel, як і решта експортів.

---

## Профіль користувача

`/api/users` змонтований під `authorize('admin')`, тому технік не може відредагувати навіть власний
профіль через нього. Домашня база персоналу живе на окремому роутері `/api/profile`, доступному
будь-якому автентифікованому користувачу — **тільки для власного запису**.

### `GET /profile`
**Повний шлях:** `/api/profile`

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "email": "tech@example.com",
    "role": "technician",
    "base_latitude": 49.8397,
    "base_longitude": 24.0297,
    "base_address": "Львів, вул. Городоцька 100",
    "locale": "pl",
    "timezone": "Europe/Warsaw"
  }
}
```

`locale` (`uk|en|pl|de`) і `timezone` (IANA) — власні мова й часовий пояс користувача (епік 2.11).
`null` означає «як в організації» (`tenant_settings.locale` / `.timezone`, далі платформні `uk` /
`Europe/Kyiv`). Саме в цій мові й поясі приходять Telegram, пошта і web push; WebUI перемикається
на неї при вході, а перемикач мови в бічній панелі записує вибір сюди. Кнопка мови в Telegram-боті
пише те саме поле. Відповіді `POST /auth/login` і `POST /auth/select-tenant` віддають `user.locale`
і `user.timezone`.

### `PATCH /profile`
Оновити домашню базу і/або мову та часовий пояс. Приймаються **тільки** пʼять полів:
`base_latitude`, `base_longitude`, `base_address`, `locale`, `timezone` (невалідний пояс — `400`).

**Body:**
```json
{
  "base_latitude": 49.8397,
  "base_longitude": 24.0297,
  "base_address": "Львів, вул. Городоцька 100"
}
```

`null` у координатах прибирає базу — користувач зникає з видачі `nearest-technicians`.
Роль, email і тенант через цей ендпоінт змінити неможливо.

**Response 200:** оновлений профіль тієї ж форми.

### `PUT /profile`
Власні email та/або пароль (колишній `PUT /users/me`). Зміна пароля вимагає `old_password`; політика —
мінімум 15 символів.

```json
{ "email": "new@example.com", "password": "…15+…", "old_password": "…" }
```

### `PUT /profile/password`
```json
{ "old_password": "…", "new_password": "…15+ символів…" }
```

### `POST /profile/telegram-link` · `DELETE /profile/telegram-link`
Код прив'язки Telegram для власного акаунта (16 символів, 15 хв) / відв'язати.

### `POST /profile/push-subscription` · `DELETE /profile/push-subscription`
Зберегти / видалити Web Push підписку поточного браузера:
```json
{ "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } }
```

---

### `GET /profile/notifications` · `PUT /profile/notifications`
Власні налаштування сповіщень (часткове оновлення):
```json
{ "enabled": true, "min_severity": "warning", "telegram": true, "webpush": true, "email": false,
  "quiet_from": "22:00", "quiet_to": "07:00", "quiet_tz": "Europe/Kyiv" }
```

---

## Публічна сторінка статусу точки

Найризикованіша частина гео-функціоналу: помилка тут публічно оприлюднює дані тенанта. Тому роутер
змонтований під `/api/public` **вище** `app.use('/api', authenticate)` — Express виконує middleware у
порядку реєстрації, тож перенесення цього рядка нижче зламає тест, а не поверне 401.

### `GET /api/public/plans`
Публічні плани для сторінки цін лендінгу. **Без автентифікації**, `Cache-Control: public, max-age=300`.
Ті самі рядки `plan_limits`, за якими платформа рахує ліміти: `plan`, `name`, `tagline`,
`max_devices/sites/users`, `retention_days`, `sampling_sec`, `features`, `price_controller_uah`,
`price_site_uah`, `price_base_uah`, `price_note` (грн на місяць без ПДВ, `null` — за запитом).

### `POST /api/public/pilot-request`
Форма «Запит на пілот» з лендінгу. **Без автентифікації**, лімітер `/api/public`.

```json
{ "name": "Олена", "company": "Аптека №7", "email": "olena@example.com", "phone": "+380…",
  "segment": "pharma", "sites": 3, "message": "…", "source": "landing", "lang": "uk", "website": "" }
```

`name` і коректний `email` обов'язкові (`400 validation_failed`); `segment` — `service | retail |
horeca | pharma | other` (інше → `other`). `website` — honeypot: заповнений відповідає `200`
і нічого не зберігає. Запит спершу пишеться в `pilot_requests`, потім надсилається на
`PILOT_REQUEST_EMAIL`; відповідь `201 { "received": true, "emailed": true|false }`.

### `GET /api/pilot-requests`
Список запитів на пілот (тільки superadmin), `?limit=50&offset=0`, `meta.total`; IP не
повертається.

### `GET /api/public/site`
Публічний read-only статус однієї точки. **Без автентифікації.**

**Headers:** `X-Site-Token: <raw token>`

Токен передається заголовком, а не сегментом шляху: nginx пише повний шлях в `access.log`, а це
довгоживучі облікові дані на сторінку статусу тенанта. Посилання для людини лишається
`https://modesp.com.ua/#/public/site/<token>` — фрагмент URL браузер на сервер не надсилає, тож токен
не потрапляє ні в серверні логи, ні в `Referer`.

**Rate limit:** 30 запитів / 5 хв на IP (власний лімітер, не спільний з `/api`). Посилання з
`site_public_links.rate_limit_exempt = true` (showcase демо-точки з лендінгу, ставить
`seed-demo.js`) лімітер пропускають; відкликання чи закінчення терміну повертає ліміт протягом
хвилини.

**Response 200:**
```json
{
  "data": {
    "name": "АТБ №142",
    "organisation": "ТОВ «Мережа»",
    "link_expires_at": "2026-12-01T00:00:00.000Z",
    "city": "Львів",
    "region": "Львівська область",
    "country": "Україна",
    "devices": [
      { "name": "Камера №1", "online": true, "air_temp": -18.4, "alarm_active": false },
      { "name": "#2", "online": false, "air_temp": null, "alarm_active": false }
    ],
    "device_count": 2,
    "online_count": 1,
    "alarm_count": 0,
    "generated_at": "2026-08-23T10:15:00.000Z"
  }
}
```

**Свідоме відхилення від SPEC §7.7.** Специфікація перелічує «лише name / city / region / country
і на пристрій `{ name, online, air_temp, alarm_active }`». Реалізація додає ще чотири поля:
`device_count`, `online_count`, `alarm_count` рахуються на сервері з масиву `devices`, який і так
у тілі відповіді, тож нової інформації вони не розкривають (сторінка просто не мусить рахувати їх
у браузері), а `generated_at` — це годинник сервера. Жодне з них не є даними тенанта.

**Що у відповіді немає ніколи:** `mqtt_device_id`, серійні номери, будь-які UUID, slug тенанта, версія
прошивки, дані користувачів і координати точніші за місто. Назва пристрою рахується на сервері як `name`
або `'#' + номер_рядка` — підстановка `mqtt_device_id` як fallback (загальноприйнята в решті кодової бази)
тут заборонена. Показуються тільки пристрої зі `status = 'active'`: м'яко видалені зберігають `site_id`
і живуть ще 7 днів, очікуючі теж існують — обидві категорії відсіюються.

**404 — однаково для трьох різних причин:** токена не існує, токен відкликаний, токен прострочений.

```json
{ "error": "not_found", "message": "Not found", "status": 404 }
```

Ні `WWW-Authenticate`, ні відмінного повідомлення: підтверджувати, що токен колись існував, не можна.
Кожен успішний перегляд інкрементує `view_count` і `last_viewed`.

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

### `GET /users/:id/tenants`
Список тенантів, до яких належить користувач.

**Ролі:** superadmin

### `POST /users/:id/tenants`
Додати користувача до тенанту.

**Ролі:** superadmin

**Body:**
```json
{ "tenant_id": "uuid" }
```

**Response 200:** Array of user's tenants `[{id, name, slug}]`.

### `DELETE /users/:id/tenants/:tenantId`
Видалити користувача з тенанту (не можна видалити останній).

**Ролі:** superadmin

**Response 200:** Array of remaining tenants.

Разом із членством видаляються **всі гранти на точки цього тенанта** (`user_sites`) — інакше вони
пережили б видалення членства і знову ожили б при повторному додаванні користувача.

### `DELETE /users/:id/sessions`
Закрити всі сесії користувача (заблокований співробітник, загублений телефон).

**Ролі:** admin (користувач своєї організації або її член; superadmin недоторканний), superadmin — будь-хто.

**Response 200:** `{ "data": { "revoked": 1 } }`. Аудит: `user.sessions_revoke`.

### `DELETE /users/:id/mfa`
Скинути другий фактор користувачеві, що втратив застосунок і резервні коди. Разом із фактором
закриваються всі його сесії.

**Ролі:** superadmin

**Response 200:** `{ "data": { "mfa_enabled": false, "sessions_revoked": 1 } }`. Аудит: `user.mfa_reset`.

### `GET /users/:id/sites`
Точки, до яких користувач має доступ.

**Ролі:** admin

**Response 200:**
```json
{
  "data": [
    { "id": "uuid", "name": "АТБ №142", "city": "Львів", "device_count": 10,
      "granted_at": "2026-08-23T09:00:00Z" }
  ]
}
```

### `POST /users/:id/sites`
Надати доступ до всіх пристроїв точки.

**Ролі:** admin

```json
{ "site_id": "uuid" }
```

Точка перевіряється на приналежність тенанту **цільового користувача**, а не тенанту адміна: інакше
superadmin, що діє в тенанті A, видав би користувачу тенанта B доступ до чужої точки. Чужа точка →
**400** `invalid_site`. Дія пишеться в аудит.

### `DELETE /users/:id/sites/:siteId`
Відкликати доступ до точки.

**Ролі:** admin

### `POST /users/invite`
Запросити email до організації (admin — у власну; superadmin може передати `tenant_id`). Створює
одноразове посилання на 72 години і надсилає лист (Resend), якщо пошта налаштована; посилання
завжди повертається адміністратору, щоб онбординг працював і без пошти. Для email, який уже має
акаунт, прийняття додає цей акаунт до організації (`existing_user: true`). Повторне запрошення тієї
самої адреси відкликає попереднє. `409`, якщо користувач уже є учасником.

```json
{ "email": "new.tech@example.com", "role": "technician", "tenant_id": "uuid (лише superadmin)", "lang": "uk" }
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid", "email": "new.tech@example.com", "role": "technician", "tenant_id": "uuid",
    "existing_user": false, "email_sent": false,
    "invite_url": "https://modesp.com.ua/#/invite/<64 hex>",
    "created_at": "…", "expires_at": "…"
  }
}
```

### `GET /users/invitations`
Відкриті (не прийняті, не відкликані, не протерміновані) запрошення організації; superadmin — усі або
`?tenant_id=`.

### `DELETE /users/invitations/:id`
Відкликати запрошення. `404`, якщо його нема, воно вже прийняте або належить іншій організації.

---

## Per-Device RBAC (Phase 7a) + Per-Site RBAC (Phase 14)

Всі ендпоінти пристроїв перевіряють доступ до конкретного пристрою:

**Правила:**
- `superadmin` — бачить всі пристрої всіх тенантів, cross-tenant bypass
- `admin` — бачить всі пристрої свого тенанту, без обмежень
- `technician` / `viewer` — бачить `user_devices` **∪** пристрої точок з `user_sites`
- `AUTH_ENABLED=false` — всі перевірки вимкнені (backward compatible)

**Об'єднання двох джерел доступу (з фази 14).** Грант на точку («АТБ №142») дає доступ до всіх
пристроїв цієї точки, включно з доданими пізніше. Гранти зберігаються в `user_sites` і завжди несуть
власний `tenant_id`, тому грант, отриманий у тенанті B, **нічого не дає** під час роботи в тенанті A —
це важливо, бо один користувач може належати кільком тенантам і перемикатися між ними без
перелогіну. Порожній набір доступу означає «жодного пристрою», а не «без обмежень».

Межа набору доступу — 5000 пристроїв (підвищено з 500 у фазі 14: одна точка мережі магазинів легко
дає сотні пристроїв). При досягненні межі набір детерміновано обрізається і в лог пишеться
попередження — авторизаційний набір не обрізається мовчки.

**List endpoints** (використовують `filterDeviceAccess`):
- `GET /devices` — фільтрує по набору доступу
- `GET /alarms` — фільтрує по device_id
- `GET /alarms/stats` — фільтрує по device_id
- `GET /fleet/summary` — рахує тільки доступні devices
- `GET /sites`, `GET /sites/:id` — точка без жодного видимого пристрою не показується
- `GET /map/devices`, `GET /map/filters`, `GET /map/alarm-heatmap`, `POST /map/route`
- `GET /stats/geo`, `GET /stats/geo/export.csv`

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

Самообслуговування каналів живе на `/api/profile` (див. «Профіль користувача»):
`POST/DELETE /profile/telegram-link` (код прив'язки бота) і `POST/DELETE /profile/push-subscription`
(Web Push підписка браузера). Адміністратор генерує код прив'язки для іншого користувача через
`POST /users/:id/telegram-link`. Підписки на сповіщення організації — `/api/notifications`.

---

## Партнерський план (plan epic 2.5)

Усі маршрути під `/api/partner` вимагають функцію плану `partner` у **поточній** організації
(інакше `402 plan_feature`) і роль `admin` у ній. Кожен запит обмежений `parent_tenant_id = <партнер>`:
партнер А не бачить клієнтів партнера Б, адмін клієнта не бачить інших клієнтів.

### `GET /partner/clients`
Клієнтські організації партнера з лічильниками: `device_count, online_count, site_count, member_count,
active_alarms, critical_alarms, open_orders, open_hints, my_role` (роль того, хто питає, у клієнті — `null`,
якщо він там не член).

### `POST /partner/clients`
`{ name, slug, plan?: free|basic|pro }` → `201`, організація з `parent_tenant_id` = партнер, `status: active`,
мова й часовий пояс партнера, спільний `billing_account_id`; той, хто створив, стає `admin` клієнта.
`409` — slug зайнятий, `400` — план `partner`/`enterprise` або зарезервований slug.

### `PATCH /partner/clients/:id`
`{ name?, plan? }` (лише free/basic/pro). Чужий клієнт — `404`.

### `GET /partner/clients/:id/members` · `POST …/members` · `DELETE …/members/:userId`
Хто є в організації клієнта (`partner_staff: true` — люди партнера). `POST { user_id, role }` ставить
активного члена партнерської організації в клієнта з роллю (`400`, якщо це не людина партнера);
`DELETE` прибирає лише людей партнера разом із їхніми грантами на точки клієнта.

### `GET /partner/overview`
`{ totals: { clients, devices, online, active_alarms, open_orders, open_hints }, alarms[≤50], work_orders[≤50], hints[≤50] }`
по всіх клієнтах, кожен рядок із `tenant_id`/`tenant_name`.

### `GET /partner/sites`
Точки клієнтів із координатами: `id, name, city, latitude, longitude, tenant_id, tenant_name, device_count,
online_count, active_alarms` — крос-тенантна карта.

### Роль на членство
`user_tenants.role` — роль, яку людина має в конкретній організації. `POST /auth/login`,
`/auth/select-tenant`, `/auth/switch-tenant` і `/auth/refresh` видають токен із роллю **тієї організації**
(`user.role` / `role` у відповіді); список `tenants` у відповідях несе `role`, `plan`, `features`,
`parent_tenant_id`. `PUT /users/:id { role }` змінює роль у поточній організації (домашню роль теж, якщо
це домашня організація); для людини з іншої домашньої організації адмін клієнта може змінити лише роль
(`403` на email/active). `POST /users/:id/tenants { tenant_id, role? }` (superadmin) додає членство з роллю.
Запрошення дає роль, на яку запрошували, і наявному акаунту.

### Брендування
`PATCH /tenants/:id/settings { brand_name?, brand_logo_url?, brand_url? }` — лише з функцією плану `branding`
(`402` інакше; superadmin завжди). `GET /public/site` віддає `brand: { name, logo_url, url } | null` —
власний бренд організації або бренд партнера, що її обслуговує; HACCP PDF показує «Обслуговує: …».
`GET /tenants` віддає `parent_tenant_id`, `parent_name`, `billing_account_id`, `client_count`;
`PATCH /tenants/:id { parent_tenant_id }` (superadmin) з перевіркою одного рівня.

## Білінг (plan epic 2.2)

Усі маршрути під `/api/billing` — роль `admin` поточної організації; `/api/billing/admin/*` — superadmin.
Карткові платежі (WayForPay / LiqPay, Checkbox) не реалізовані: оплата банківським переказом, статус ставить
superadmin.

### `GET /billing/summary`
`{ tenant: { plan, plan_name, status, trial_expires_at, legal_name, tax_id, billing_email, price_* , max_* },
estimate, seller, plan_request, open_invoices[] }`. `estimate` — оцінка поточного місяця з живого парку:
`{ period, payer, billed_via_partner, members[], lines[], amount, currency }`; для клієнта партнера — лише
`{ billed_via_partner: true, payer, period }` (суми партнера він не бачить); `null` — план без рахунків або
організація поза статусами `active`/`past_due`. `seller` — реквізити постачальника (`seller_name`, `seller_iban`,
`seller_bank`, `seller_tax_id`, `seller_address`, `seller_email`, `due_days`, `invoice_note`).

### `GET /billing/usage?months=2`
Денні знімки `usage_snapshots` організації за останні N місяців (superadmin: `&tenant_id=`).

### `GET /billing/invoices` · `GET /billing/invoices/:id` · `GET /billing/invoices/:id/pdf`
Рахунки платника (поточна організація; superadmin: `?tenant_id=`), `overdue: true` для прострочених. Чужий
рахунок — `404`. PDF (`application/pdf`, `Content-Disposition: attachment; filename="MC-000012.pdf"`) мовою
організації або `?lang=`.

### `PATCH /billing/identity`
`{ legal_name?, tax_id?, billing_email? }` — платіжні дані організації, які друкуються на рахунку; порожній
`billing_email` = листи адміністраторам.

### `POST /billing/plan-request` · `DELETE /billing/plan-request`
`{ plan, message? }` → `201` заявка на зміну плану (`400` — той самий або невідомий план, `409` — заявка вже
є); `DELETE` скасовує очікувану. Лист засновнику на `PILOT_REQUEST_EMAIL`, якщо пошта налаштована.

### `GET /billing/admin/invoices?status=issued|overdue|paid|void&tenant_id=&limit=`
Усі рахунки з `tenant_name`, `tenant_slug`, `tenant_status`, `dunning_stage`, `sent_at`.

### `POST /billing/admin/invoices/:id/pay` · `…/void` · `…/send`
`pay { paid_at?, note? }` → `status: paid`, у відповіді `restored[]` — організації, яким повернуто `active`;
`void { note? }` — анулювати (теж відновлює); `send` — (пере)надіслати лист із PDF (`503` без пошти, `409` без
одержувача). `409`, якщо рахунок уже не `issued`.

### `POST /billing/admin/run`
`{ job: snapshot|invoices|dunning|all, period?: 'YYYY-MM', tenant_id?, send?: true }` — запуск завдань вручну
(ті самі, що виконує щогодинний таймер `BILLING_INTERVAL_MIN`). `invoices` без `period` = попередній місяць;
незавершений період → `skipped: period_not_over`, незаповнені реквізити продавця → `skipped:
seller_not_configured` (жодного рахунку не створено). `dunning` віддає `{ past_due[], reminded[],
suspended[], held[] }`; `held` — рахунки з порожнім `sent_at`, які зупинені на стадії «прострочено» і не
призупиняють організацію, доки їх не надішлють.

### `GET|PUT /billing/admin/settings`
Реквізити постачальника і `due_days` (1–90), `invoice_note` — друкуються на кожному рахунку.
`seller_iban` перевіряється як у банку: структура (2 літери коду країни, 2 контрольні цифри, далі
алфавітно-цифрові), довжина за реєстром ISO 13616 (для України 29) і контрольна сума MOD 97-10.
Невалідне значення → `400` з причиною (`format`, `length`, `checksum`); валідне зберігається
нормалізованим (без пробілів, у верхньому регістрі), тож `ua21 3223 …` і `UA213223…` дають один рядок.

### `GET /billing/admin/plan-requests?status=pending` · `POST …/:id/approve` · `POST …/:id/reject`
Заявки на зміну плану; `approve { note? }` міняє `tenants.plan` (і скидає індивідуальну ретенцію), `reject`
лише закриває.

## Онбординг (plan epic 2.1)

Чек-ліст «Перші кроки» на панелі адміністратора організації (роль `admin`). Кроки читаються з даних:
`site` — є торгова точка; `device` — є активний контролер; `team` — друга людина в організації або
відкрите запрошення; `telegram` — хтось із членів прив'язав Telegram або є Telegram-підписник; `report` —
є запис у `report_exports`. Перший раз, коли крок побачено виконаним, його час записується в
`tenant_settings.onboarding.steps`.

### `GET /onboarding`
**Response 200:**
```json
{
  "data": {
    "steps": [ { "key": "site", "done": true, "done_at": "…" }, { "key": "device", "done": false, "done_at": null }, "…" ],
    "done_count": 2, "total": 5, "completed": false,
    "dismissed_at": null,
    "trial": { "status": "trial", "trial_expires_at": "…", "days_left": 9 }
  }
}
```

### `POST /onboarding/dismiss`
Сховати картку (`tenant_settings.onboarding.dismissed_at`). Відповідь — як `GET`.

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

**Життєвий цикл (plan epic 2.10).** `status: "closed"` ставить `closed_at` (тригер `trg_tenants_track_closed`;
повернення в `active` очищує його). Закрита організація лишається відкритою для входу, але **лише на
читання**: будь-який `POST/PATCH/PUT/DELETE` від її користувачів відповідає `423 organisation_closed`,
крім `/auth/*`, `/profile` і експорту даних; superadmin не обмежений. Топіки брокера для неї закриті,
як і для `suspended`. Вхід віддає в `tenant` поля `closed_at`, `purged_at` і `read_only_until`
(`closed_at + CLOSED_RETENTION_DAYS`, типово 30 днів). Коли цей термін минає, сторож
`services/tenant-lifecycle.js` виконує purge: телеметрія, аварії, події, звіти, наряди, підказки,
прошивки, моделі, точки й експорти видаляються, контролери повертаються в чергу очікування
(`__system__`, `status = pending`, облікові дані збережені, `_set_tenant pending` на старий префікс);
організація, її користувачі, рахунки, знімки використання й аудит лишаються, `purged_at` заповнюється.
`GET /tenants` віддає `closed_at`, `purged_at`, `purge_after`.

### `POST /tenants/:id/export` · `GET /tenants/:id/exports` · `GET /tenants/:id/exports/:exportId/download`
Експорт даних організації (plan epic 2.10). **Ролі:** admin своєї організації або superadmin. Дозволено
й для закритої організації.

`POST` створює запит і відповідає `202` з рядком `tenant_exports` (`status: pending`); архів збирається
у фоні. `409 export_in_progress`, поки готується попередній. Zip містить CSV на кожну таблицю
організації (`sites`, `devices`, `device_models`, `users`, `alarms`, `events`, `service_records`,
`work_orders`, `maintenance_hints`, `notification_subscribers`, `notification_log`, `invoices`,
`usage_snapshots`, `report_schedules`, `report_exports`, `audit_log`, `telemetry_hourly`, `telemetry`;
UTF-8 з BOM, ISO-8601, JSON у комірках) без паролів, других факторів, токенів і збережених файлів,
плюс `reports/haccp_<точка>.pdf` за останній рік на кожну точку з обладнанням, `manifest.json`
(кількість рядків) і `README.txt`.

```json
{ "data": [ { "id": "uuid", "status": "ready", "file_name": "modesp_morozko_2026-09-08_1a2b3c4d.zip", "bytes": 4813355,
              "sha256": "…", "manifest": { "tables": { "telemetry": 412000 }, "reports": [ { "site": "Магазин №1", "code": "ABCD-…" } ] },
              "created_at": "…", "completed_at": "…", "expires_at": "…" } ],
  "meta": { "ttl_days": 7 } }
```
`download` віддає `application/zip` із заголовком `X-Export-Sha256`; `409 export_not_ready`,
`410 export_expired` (після `EXPORT_TTL_DAYS` файл видаляється, рядок лишається). Файли живуть у
`EXPORT_DIR`.

### `POST /tenants/:id/approve` · `POST /tenants/:id/reject`
Superadmin, plan epic 2.1. Організація, що зареєструвалася сама при `REGISTRATION_MODE=approve`, чекає
зі статусом `suspended` (`GET /tenants` віддає `registered_at`, `approved_at`, `awaiting_approval`).
`approve` ставить `trial` з `trial_expires_at` через `REGISTRATION_TRIAL_DAYS`, записує `approved_by` і
пише адміністратору листа; `reject` видаляє організацію разом з її користувачами. Обидва відповідають
`409 not_awaiting_approval`, якщо організація не чекає на схвалення.

### `DELETE /tenants/:id`
Повне видалення організації спільною процедурою `services/tenant-delete.js`: спочатку purge (як вище),
далі аудит-лог псевдонімізується (`audit_log_detach_tenant`), користувачі та сама організація видаляються.
Контролери переходять у чергу очікування.

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

### `GET /tenants/plans`
Каталог планів (`plan_limits`): `max_devices`, `max_sites`, `max_users` (`null` — без обмежень),
`retention_days`, `sampling_sec`, `features`. Використання проти ліміту повертають `GET /tenants` і
`GET /tenants/:id` (`device_count` — лише активні, `pending_count`, `site_count`, `user_count`, `max_*`).

Перевищення ліміту при призначенні контролера, створенні/запрошенні користувача або створенні точки —
`402 plan_limit` з `resource`, `limit`, `current`, `plan`. Функції плану (`reports` — PDF HACCP,
`energy` — енергозвіт, `geo` — ізохрони) — `402 plan_feature`; superadmin проходить завжди.

### Стан організації (`tenants.status`)
`trial` | `active` | `past_due` | `suspended` | `closed`. Перші три — «відкриті»: вхід, оновлення сесії,
перемикання організації і топіки брокера працюють. `suspended`/`closed`: `401 tenant_suspended` при вході
та оновленні токена, пристрої організації не отримують жодного топіка (CONNECT проходить, облікові дані
зберігаються — після реактивації зв'язок відновлюється сам). Поле `active` лишається дзеркалом статусу.
`PATCH /tenants/:id` (superadmin) приймає `status`, `plan` (у т.ч. `partner`), `trial_expires_at`,
`billing_email`, `legal_name`, `tax_id`, `billing_currency`, `contract_started_at`.

### `GET /tenants/:id/settings` · `PATCH /tenants/:id/settings`
Налаштування організації — адміністратор власної організації або superadmin. `null` скидає перевизначення
до значення платформи (`defaults` у відповіді).

```json
{ "timezone": "Europe/Kyiv", "locale": "uk", "electricity_rate": 7.5, "electricity_currency": "UAH",
  "door_alarm_delay_ms": 600000, "pulldown_alarm_delay_ms": 300000,
  "offline_threshold_ms": 90000, "offline_alarm_delay_ms": 120000, "ack_escalation_min": 15,
  "raw_retention_days": 400 }
```

`raw_retention_days` (7–1100, `null` — за планом) змінює лише superadmin (інакше `403`); це
перевизначення зберігання сирої телеметрії над `plan_limits.retention_days` (grandfathering для
організацій, що існували до появи ретенції за планом). Відповідь містить і `retention_days` —
чинне значення. Явна зміна `plan` через `PATCH /tenants/:id` скидає перевизначення.

### `DELETE /tenants/bulk`
`{ "ids": [...] }` — масове видалення (superadmin) тією самою процедурою, що й `DELETE /tenants/:id`
(раніше мало власний, неповний перелік таблиць і падало на `device_models`). Маршрут оголошено перед
`DELETE /tenants/:id`.

---

## Firmware (OTA)

Маршрути `/firmware/*` і `/ota/*` доступні адміністратору й техніку (переглядач — `403`). Технік
розгортає лише на пристрої зі своїх грантів (`user_devices` ∪ `user_sites`); адміністратор — на будь-який
пристрій організації. API-ключ (епік 2.6) працює як організація.

### Бібліотека прошивок (plan epic 2.8)
Прошивка належить організації (`tenant_id`) **або платформі** (`tenant_id IS NULL`, `global: true`).
Платформенну прошивку завантажує лише superadmin; вона видима всім організаціям (`visibility: all`)
або лише обраним (`visibility: selected` + `firmware_visibility`). Список організації = власні +
платформенні, опубліковані для неї; superadmin бачить усі платформенні. Кожен рядок містить
`global`, `visibility`, `uploaded_by_email`, `job_count`, `active_job_count`, `visible_to_count`.

### `POST /firmware/upload`
**Ролі:** admin (власна), superadmin (платформенна).

**Content-Type:** multipart/form-data
**Fields:** `file` (.bin, ≤ 4MB), `version`, `notes` (optional), `board_type` (optional — модель плати;
порожньо — універсальна), `global` (`true` — платформенна, лише superadmin), `visibility` (`all` |
`selected`), `tenant_ids` (JSON-масив id організацій для `selected`).

Версія унікальна в межах організації і окремо — в межах платформи (`409 duplicate_version`).

**Response 201:**
```json
{
  "data": {
    "id": "uuid", "tenant_id": null, "global": true, "visibility": "selected",
    "version": "1.4.2", "filename": "global_1.4.2_1757370000000.bin", "original_name": "modesp_1.4.2.bin",
    "size_bytes": 1548288, "checksum": "sha256:a1b2c3d4...", "board_type": "ModESP-VM4", "notes": "Fix sensor calibration",
    "uploaded_by": "uuid", "uploaded_by_email": "root@modesp.com.ua", "created_at": "2026-09-08T10:00:00Z",
    "job_count": 0, "active_job_count": 0, "visible_to_count": 1,
    "visible_to": [{ "tenant_id": "uuid", "name": "Морозко", "slug": "morozko" }]
  }
}
```

### `GET /firmware` · `GET /firmware/:id`
Видимі прошивки (власні + платформенні для цієї організації), платформенні першими. `GET /:id` для
superadmin і платформенної прошивки додає `visible_to`.

### `PATCH /firmware/:id`
`{ "notes" }` — власник; `{ "visibility": "all" | "selected", "tenant_ids": [...] }` — лише superadmin і лише
для платформенної прошивки (`403 forbidden` адміністратору, `400` при спробі задати видимість власній).

### `DELETE /firmware/:id`
Адміністратор — власну, superadmin — платформенну. `409 firmware_in_use` (з `active_jobs`,
`active_rollouts`), поки є завдання `queued`/`sent` або розгортання `running`/`paused`. Після видалення
завершені завдання й розгортання зберігають `firmware_version` (`firmware_id` стає NULL,
`firmware_deleted: true`).

### Перевірки перед OTA (plan epic 2.8)
Перед командою пристрій має бути **онлайн**; без `force` — також не в розморожуванні
(`defrost.active`), без активної критичної аварії і всередині вікна оновлень організації
(`tenant_settings.ota_window_from/to`, хвилини від місцевої півночі, вікно може переходити через північ).
Порушення — `409 precheck_failed`:
```json
{ "error": "precheck_failed", "status": 409, "reasons": ["defrost", "outside_window"], "forceable": true,
  "window": { "timezone": "Europe/Kyiv", "from": 1320, "to": 360 } }
```
`forceable: true` означає, що адміністратор може повторити запит із `"force": true` (техніку `force`
ігнорується); `offline` не обходиться ніколи. Завдання із `force` позначене `forced: true`.

### `POST /ota/deploy`
**Ролі:** admin, technician (свої пристрої).

```json
{ "firmware_id": "uuid", "device_id": "F27FCD", "force": false }
```

**Response 201:**
```json
{ "data": { "job_id": "uuid", "device_id": "F27FCD", "firmware_version": "1.2.3", "status": "sent",
            "kind": "deploy", "forced": false, "overridden": [] } }
```
`400 board_mismatch` (плата прошивки ≠ модель пристрою), `404 firmware_not_found` (у т.ч. платформенна,
не опублікована для організації), `404 device_not_found`, `409 ota_in_progress`, `409 precheck_failed`.

### `GET /ota/rollback?device_id=` · `POST /ota/rollback`
Відкат до версії, яку пристрій мав до останнього успішного оновлення (`pre_ota_version` останнього
завдання `succeeded`). `GET` — попередній перегляд:
```json
{ "data": { "device_id": "F27FCD", "current_version": "1.4.2", "previous_version": "1.3.9",
            "last_update": { "job_id": "uuid", "version": "1.4.2", "completed_at": "…", "kind": "deploy" },
            "firmware": { "id": "uuid", "version": "1.3.9", "board_type": "ModESP-VM4", "global": false },
            "available": true } }
```
`POST { "device_id", "force" }` — ті самі ролі й перевірки, що `/deploy`; створює завдання `kind: rollback`.
`404 rollback_unavailable` (немає успішного оновлення або версії вже немає в бібліотеці — з
`previous_version`), `409 already_on_version`.

### `POST /ota/rollout`
Груповий OTA rollout з batching. **Ролі:** admin.

```json
{ "firmware_id": "uuid", "device_ids": ["F27FCD", "A4CF12"], "batch_size": 2, "batch_interval_s": 300, "fail_threshold_pct": 50 }
```
`batch_size` 1–100 (5), `batch_interval_s` 30–86400 (300), `fail_threshold_pct` 1–100 (50). Несумісні
плати виключаються (`skipped_incompatible`). Пристрій, що не проходить перевірки на момент пакета,
**відкладається** на наступний пакет (`deferrals`, `defer_reason`), після `OTA_MAX_DEFERRALS` (12)
завдання завершується `failed` з `error: "precheck: …"`. Поза вікном оновлень розгортання чекає
(опитування не рідше ніж раз на 5 хв), нічого не відкладаючи.

Автопауза: коли частка невдач серед завершених ≥ `fail_threshold_pct` — `status: paused`,
`paused_reason: failures`; адміністраторам іде сповіщення (Telegram / e-mail / web push), вебхукам —
`ota.rollout_paused`. `resume` приймає наявні невдачі (`acked_failures`) — поріг спрацьовує знову лише
на нових. Завершення — сповіщення і `ota.rollout_completed`. Ручна пауза — `paused_reason: manual`.

**Response 201:**
```json
{ "data": { "rollout_id": "uuid", "firmware_version": "1.2.3", "total_devices": 2, "skipped_incompatible": 1,
            "batch_size": 2, "batch_interval_s": 300, "fail_threshold_pct": 50, "status": "running" } }
```

### `GET /ota/jobs`
Query: `?status=sent&rollout_id=uuid&device_id=F27FCD&limit=100`. Рядок: `id, device_id, rollout_id, status,
kind (deploy|rollback), forced, deferrals, defer_reason, actor (e-mail або apikey:<назва>), queued_at, sent_at,
completed_at, error, pre_ota_version, firmware_id, firmware_version, firmware_deleted`.

### `GET /ota/rollouts`
Список з лічильниками `queued, deferred, sent, succeeded, failed, cancelled`, `paused_reason`,
`created_by_email`, `firmware_deleted`.

### `GET /ota/rollouts/:id`
Деталі з переліком завдань (`kind`, `deferrals`, `defer_reason`).

### `POST /ota/rollouts/:id/pause` · `/resume` · `/cancel`
**Ролі:** admin. `pause` ставить `paused_reason: manual`; `resume` знімає причину і приймає невдачі, що вже
сталися; `cancel` переводить `queued` завдання в `cancelled`.

---

## Device Self-Registration

### `POST /devices/register`
Самореєстрація нового пристрою. Публічний endpoint (без JWT), захищений bootstrap key.
Створює pending пристрій у БД з MQTT credentials для go-auth на порту 8883.

**Авторизація:** `X-Bootstrap-Key` header або `bootstrap_key` в body (= `MQTT_BOOTSTRAP_PASSWORD`)

**Body:**
```json
{
  "device_id": "A4CF12"
}
```

`device_id` — 6-12 hex символів (MAC-based ID пристрою).

**Response 201 (створено):**
```json
{
  "data": {
    "device_id": "A4CF12",
    "username": "device_A4CF12",
    "broker": "modesp.com.ua",
    "port": 8883,
    "prefix": "modesp/v1/pending/A4CF12",
    "status": "pending",
    "created": true
  }
}
```

**Response 200 (pending, вже існує — ідемпотентно):**
```json
{
  "data": {
    "device_id": "A4CF12",
    "username": "device_A4CF12",
    "broker": "modesp.com.ua",
    "port": 8883,
    "prefix": "modesp/v1/pending/A4CF12",
    "status": "pending",
    "created": false
  }
}
```

**Response 200 (active device re-registering — auto-reset):**
Якщо пристрій зі статусом `active` повторно реєструється, це означає, що він
втратив provisioned credentials. Сервер автоматично скидає його до pending з
bootstrap credentials, щоб пристрій зміг підключитися знову.
```json
{
  "data": {
    "device_id": "A4CF12",
    "username": "device_A4CF12",
    "broker": "modesp.com.ua",
    "port": 8883,
    "prefix": "modesp/v1/pending/A4CF12",
    "status": "pending",
    "created": false,
    "reset": true
  }
}
```
`reset: true` вказує, що пристрій було скинуто до pending (RBAC очищено, tenant → SYSTEM).

**Помилки:**
- `401` — невірний bootstrap key
- `400` — невалідний device_id (не hex або < 6 символів)
- `503` — MQTT_BOOTSTRAP_PASSWORD не налаштований

**Flow:** register → connect MQTT → publish state → appears in PendingDevices → admin assigns tenant

---

## Auto-discovery (Pending Devices)

### `GET /devices/pending`
Черга очікування. Адміністратор організації бачить **лише пристрої, які його організація додала за
кодом** (`POST /devices/claim`); superadmin бачить усю чергу разом із `claim_code` і
`claimed_by_tenant_id`.

### `POST /devices/claim`
Додати pending-контролер до своєї організації за кодом, надрукованим на ньому (6–12 символів; пробіли,
дефіси й регістр ігноруються). `404` — коду нема серед pending; `409` — пристрій уже додала інша
організація. Далі його можна призначити через `POST /devices/pending/:mqttId/assign`.

```json
{ "claim_code": "ABCD-2345" }
```

**Response 200:** `{ "data": { "id": "uuid", "mqtt_device_id": "A4CF12", "online": true, "claimed": true } }`

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

### `DELETE /devices/pending/:mqttId`
Видалити pending пристрій. Дозволяє повторну реєстрацію.

**Ролі:** admin

**Response 200:**
```json
{
  "data": { "deleted": true, "mqtt_device_id": "A4CF12" }
}
```

### `DELETE /devices/:id`
Видалити пристрій (admin: свій тенант, superadmin: будь-який).
Видаляє пов'язані записи: alarms, telemetry, events, service_records, user_devices.

**Ролі:** admin, superadmin

**Response 200:**
```json
{
  "data": { "deleted": true, "mqtt_device_id": "A4CF12" }
}
```

### `DELETE /devices/bulk`
Масове видалення пристроїв. Видаляє пов'язані записи для кожного пристрою.
Часткові помилки не зупиняють обробку — відповідь містить списки видалених і проблемних.

**Ролі:** admin, superadmin

**Body:**
```json
{ "ids": ["uuid-or-mqtt-id-1", "uuid-or-mqtt-id-2"] }
```

**Response 200:**
```json
{
  "data": {
    "deleted": 2,
    "failed": 1,
    "devices": [
      { "id": "uuid-1", "mqtt_device_id": "A4CF12" },
      { "id": "uuid-2", "mqtt_device_id": "B5DG23" }
    ],
    "errors": [
      { "id": "invalid-id", "error": "Device not found" }
    ]
  }
}
```

### `POST /devices/:id/reset-pending`
Скинути пристрій до стану pending з bootstrap credentials.
Використовується коли пристрій не зберіг нові MQTT credentials після assign (stuck device).

Переносить пристрій в SYSTEM tenant, відновлює bootstrap password hash, очищує RBAC (user_devices).

**Ролі:** admin, superadmin

**Response 200:**
```json
{
  "data": {
    "reset": true,
    "mqtt_device_id": "A4CF12",
    "status": "pending"
  }
}
```

---

## CSV-імпорт мережі (plan epic 2.12)

Адміністратор завантажує один CSV на всю мережу: контролери й торгові точки разом. Запит перевіряє файл
і план, а роботу виконує фонова задача (`imports`), за якою стежить сторінка «Очікування».

### `GET /devices/pending/template.csv`
Шаблон із усіма колонками і одним прикладом (UTF-8 BOM для Excel). Колонки: `mqtt_device_id`, `name`
(обов'язкові), `serial_number`, `location`, `model`, `comment`, `manufactured_at` (`ДД-ММ-РРРР` або
`РРРР-ММ-ДД`), `site_name`, `country` (ISO-код `UA` або назва), `region`, `city`, `address_line`, `postal_code`.
Заголовки-синоніми: `device id`/`device_id`, `serial`, `site`, `address`, `postal`/`zip`.

### `POST /devices/pending/batch`
**Ролі:** admin (superadmin — з `tenant_id` для іншої організації). `multipart/form-data`, поле `file`
(.csv, ≤ 2 МБ, до `IMPORT_MAX_ROWS` = 2 000 рядків). Ліміт 30 запитів/хв (як інші маршрути з
геокодуванням).

Перевірки в запиті: `400 empty_file` / `parse_error` / `too_many_rows` (з `limit`) / `invalid_file_type` /
`file_too_large`; `400 validation_failed` з `errors: [{ row, field, message }]` (довжини колонок збігаються з
DDL, дублікати `mqtt_device_id` у файлі); `402 plan_limit` для `devices` (скільки буде призначено) і `sites`
(скільки точок буде створено); `409 import_in_progress` з `import_id`, поки попередній імпорт організації не
завершено.

**Response 202** — задача:
```json
{ "data": { "id": "uuid", "status": "pending", "file_name": "merezha.csv", "total_rows": 120, "processed_rows": 0,
            "assigned": 0, "pre_registered": 0, "skipped": 0, "failed_rows": 0, "sites_created": 0, "devices_with_site": 0,
            "geocode_queued": 0, "geocoded": 0, "geocode_failed": 0, "credentials_available": false,
            "forecast": { "assign": 96, "pre_register": 20, "skip": 4, "new_sites": 11 },
            "summary": { "total": 120, "processed": 0, "...": "..." } } }
```

Що робить задача з кожним рядком: контролер у черзі очікування (`pending`, системна організація) —
**призначається** організації (облікові дані MQTT надсилаються контролеру, пауза `IMPORT_MQTT_PACE_MS` = 300 мс
між контролерами, `site_id` за `site_name`); невідомий — **попередньо реєструється** в черзі очікування (без
точки); уже активний — **пропускається**. Невідома точка створюється з адресою (без правки наявних) і
геокодується через bulk-чергу геокодера, якщо `GEOCODER_BULK_ENABLED=true`; результат рахується в
`geocoded` / `geocode_failed`. Помилка одного рядка (`failed_rows`) не зупиняє імпорт. Лічильники оновлюються
кожні 5 рядків; після рестарту сервера незавершена задача позначається `failed` (`interrupted by a restart`),
а ті, що ще в черзі, запускаються знову.

### `GET /imports` · `GET /imports/:id`
**Ролі:** admin. Список (20 останніх, `meta.max_rows`) і одна задача з `summary`, `results`
(`[{ row, mqtt_device_id, name, status: assigned | pre_registered | skipped | failed, site_id, site_name, error }]` —
без паролів), `requested_by_email`, `credentials_available`, `credentials_downloaded_at`, `error`.

### `GET /imports/:id/credentials.csv`
Паролі MQTT призначених контролерів — **один раз**: файл `mqtt_device_id, name, username, password,
mqtt_host, mqtt_port, sent_via_mqtt`, після чого зашифрований блок видаляється (`410 credentials_gone` при
повторній спробі, `409 no_credentials`, якщо ніхто не був призначений). Аудит `import.credentials`.

### `POST /imports/:id/cancel`
Задача в черзі завершується одразу (`cancelled`), та, що виконується, — після поточного рядка;
`409 not_active` для завершеної.

---

## Інтеграції: API-ключі та вебхуки (plan epic 2.6)

Адміністратор організації на плані з функцією `api` (Про, Мережа, Партнер; `402 plan_feature` інакше — наявні
записи лишаються видимими). Сторінка «Інтеграції» (`#/integrations`).

### API-ключі

Ключ `modesp_<43 символи base64url>` передається в тому самому заголовку, що й токен людини:
`Authorization: Bearer modesp_…`. У базі зберігається лише SHA-256 (`api_keys.key_hash`) і префікс для
впізнавання; повний ключ є лише у відповіді на створення. Ключ представляє організацію цілком: бачить усі її
пристрої (без грантів `user_devices`/`user_sites`), а роль випливає зі `scope` — `read` → переглядач,
`write` → технік, `admin` → адміністратор. Заборонена поверхня для будь-якого ключа: `/auth/*` (з
автентифікацією), `/profile`, `/api-keys`, `/webhooks`, `/users`, `/tenants`, `/billing`, `/audit-log`, `/pilot-requests`,
`/partner`, `/onboarding`, `/ws-ticket` — `403 api_key_scope`. Відкликаний або прострочений ключ, а також
ключ організації без функції `api` — `401 invalid_key` / `402 plan_feature`; у закритій організації ключ
читає, але не пише (`423 organisation_closed`), у призупиненій — `401`. `last_used_at` оновлюється не частіше
ніж раз на хвилину. У `audit_log` дії ключа підписані `user_email = apikey:<назва>`, `user_id = NULL`.

#### `GET /api-keys`
Ключі організації: `id, name, prefix, scope, created_by, created_at, last_used_at, expires_at, revoked_at,
active`. Секрету у відповіді немає ніколи.

#### `POST /api-keys`
```json
{ "name": "CMMS", "scope": "write", "expires_in_days": 90 }
```
`scope` — `read` (типово) | `write` | `admin`; `expires_in_days` 1–3650, без нього ключ безстроковий.
`201` з рядком ключа плюс `key` — повний ключ, показаний один раз. До 20 активних ключів (`409 limit_reached`).
Аудит `api_key.create`.

#### `DELETE /api-keys/:id`
Відкликання (`revoked_at`); системи, що ним користувалися, отримують `401 invalid_key` негайно. Аудит
`api_key.revoke`.

### Вебхуки

Вебхук — HTTP POST на адресу клієнта на кожну підписану подію. Події: `alarm.raised`, `alarm.cleared`,
`alarm.acknowledged`, `device.offline`, `device.online`, `work_order.created|updated|assigned|started|closed|cancelled`,
`hint.opened`; `*` — усі. Тіло:

```json
{ "id": "7781e93b-…", "event": "alarm.acknowledged", "created_at": "2026-09-08T20:53:29.4Z",
  "tenant_id": "cfe3f6f4-…",
  "data": { "device_id": "E00118", "device_uuid": "af9b98f9-…", "device_name": "Бонета морозильна",
            "site_id": "4f897f69-…", "site_name": "Морозко №212",
            "alarm_id": 173, "alarm_code": "high_temp_alarm", "acknowledged_by": "apikey:CMMS", "note": "Заявка #4471" } }
```

Заголовки: `X-ModESP-Event`, `X-ModESP-Delivery` (id доставки — той самий при повторі), `X-ModESP-Timestamp`
(unix-секунди), `X-ModESP-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`,
`User-Agent: ModESP-Cloud-Webhooks/1`. Одержувач перевіряє підпис і відкидає мітки, старіші за 5 хвилин.
Відповідь 2xx протягом 10 с — успіх; редиректи не виконуються. Невдача → повтор через 1 хв, 5 хв, 30 хв,
2 год, 12 год, після п'ятої спроби доставка `dead`. Десять невдач підряд вимикають вебхук
(`enabled = false`, `disabled_reason = failures`); повторне увімкнення скидає лічильник. Адреса — лише
публічний http(s) без облікових даних: приватні, loopback та link-local адреси (і за DNS) відхиляються
`400 invalid_url` (`WEBHOOK_ALLOW_PRIVATE=true` лише для тестів). Черга обробляється одразу після події і
таймером `WEBHOOK_INTERVAL_SEC` (30; 0 вимикає, для тестів).

#### `GET /webhooks`
`data`: `id, name, url, events, enabled, failures, disabled_at, disabled_reason, last_delivery_at, last_status,
created_by, created_at, updated_at, pending, dead` (лічильники черги); `meta.events` — перелік подій.

#### `POST /webhooks`
```json
{ "name": "CMMS", "url": "https://cmms.example.com/modesp", "events": ["alarm.raised", "alarm.cleared"], "enabled": true }
```
`secret` (16–128 символів) можна задати, інакше генерується; у базі він зашифрований, у відповіді `201` —
один раз. До 10 вебхуків (`409 limit_reached`). Аудит `webhook.create`.

#### `PATCH /webhooks/:id`
Будь-яке з `name, url, events, enabled`. Вимкнення вручну ставить `disabled_reason = manual`; увімкнення
скидає `failures`, `disabled_at`, `disabled_reason`. Аудит `webhook.update`.

#### `DELETE /webhooks/:id`
Разом із журналом доставок. Аудит `webhook.delete`.

#### `POST /webhooks/:id/test`
Надсилає подію `ping` негайно: `{ "ok": true, "status_code": 200, "error": null, "duration_ms": 3 }`.

#### `POST /webhooks/:id/rotate-secret`
Новий секрет у відповіді один раз; старий перестає діяти негайно. Аудит `webhook.rotate_secret`.

#### `GET /webhooks/:id/deliveries?limit=50&status=`
Останні доставки: `id, event, status (pending|ok|failed|dead), attempts, next_attempt_at, status_code, error,
duration_ms, created_at, delivered_at, payload`.

#### `POST /webhooks/:id/deliveries/:did/redeliver`
`202` — копія доставки в черзі (`payload.redelivery_of` — id оригіналу), працює для `ok`, `failed` і `dead`.

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
- 2026-03-10 — Device self-registration: POST /devices/register (public, bootstrap key auth), closes go-auth chicken-and-egg gap.
- 2026-03-10 — Device deletion: DELETE /devices/pending/:mqttId, DELETE /devices/:id (admin/superadmin), PendingDevices UI delete button.
- 2026-03-10 — Device re-registration auto-reset: POST /devices/register auto-resets active devices to pending with bootstrap creds when they re-register (lost credentials recovery). POST /devices/:id/reset-pending manual reset endpoint.
- 2026-03-15 — Phase 11: Events API (GET /devices/:id/events), HACCP Export (CSV telemetry/devices/alarms + PDF report), severity filter on GET /alarms (?severity=critical,warning), rate-limited export endpoints (10/min/user).
- 2026-03-24 — Phase 13: Device Models CRUD (GET/POST/PATCH/DELETE /device-models), Energy summary (GET /devices/:id/energy/summary), PATCH /devices/:id accepts model_id and power_overrides.
- 2026-03-31 — Device map: devices отримали latitude/longitude (migration 018); GET /devices, GET /devices/:id повертають координати; PATCH /devices/:id приймає latitude/longitude (null = прибрати з карти).
- 2026-08-23 — Phase 14 (Sites & Geo): Sites CRUD (`/sites`) з геокодуванням, погодою, найближчими техніками та публічними посиланнями; геокодер-проксі (`/geo/search`, `/geo/reverse`); карта (`/map/devices`, `/map/filters`, `/map/alarm-heatmap`, `/map/isochrones`, `POST /map/route`); гео-статистика (`/stats/geo` + `export.csv`); профіль з домашньою базою (`/profile`); гранти на точки (`/users/:id/sites`); неавтентифікована публічна сторінка статусу (`/api/public/site` + заголовок `X-Site-Token`); `site_id` у PATCH /devices/:id і `site_*` поля у видачі пристроїв; нові колонки CSV-імпорту; окремий rate limiter 30/хв на користувача для ендпоінтів із зовнішніми сервісами.
- 2026-09-02 — HACCP (епік 1.9): `GET /devices/:id/telemetry/export.pdf` перероблено (локалізація uk/en/pl/de, реквізити організації і точки, місцевий час, підпис, код перевірки й SHA-256, погодинний архів для старих періодів), новий `GET /sites/:id/export.pdf`, публічна перевірка `GET /api/public/report/:code`, інвентаризація переїхала на `GET /devices/export/inventory.csv`; усі експорти пишуться в `audit_log`.
- 2026-09-02 — Епік 1.10: showcase-посилання без ліміту переглядів (`rate_limit_exempt`); `DELETE /tenants/:id` виконує спільну з `purge-demo.js` процедуру (`services/tenant-delete.js`).
- 2026-09-02 — Епік 1.11: `GET /api/public/plans`, `POST /api/public/pilot-request`, `GET /api/pilot-requests`; `GET /api/public/site` додає `organisation` і `link_expires_at` (сторінка каже, чия вона, і попереджає за тиждень до закінчення посилання).
- 2026-09-02 — Епік 1.2: `GET /sites/:id/weather`, `GET /sites/:id/weather/history` і `POST /map/route` відповідають `402 plan_feature` поза планами з функціями `weather`/`routing`.
- 2026-09-08 — Самореєстрація (епік 2.1): `GET /auth/registration`, `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/resend-verification`; `401 email_not_verified | pending_approval` на вході; `POST /tenants/:id/approve | reject` і поля `registered_at/approved_at/awaiting_approval` у `GET /tenants`; чек-ліст `GET /onboarding`, `POST /onboarding/dismiss`; `trial_expires_at` у `tenant` відповідей входу.
- 2026-09-08 — Сесії і другий фактор (епік 2.9): refresh-токен у httpOnly-cookie `modesp_rt` + `csrf_token`/`X-CSRF-Token` для браузера (тіло `refresh_token` для API-клієнтів лишається), одноразові refresh-токени з `401 token_reused`, `sid` у access-токені; `POST /auth/mfa/verify`, `GET /auth/mfa`, `POST /auth/mfa/setup | enable | disable | backup-codes`; `GET/DELETE /auth/sessions`, `DELETE /auth/sessions/:id`; `DELETE /users/:id/sessions`, `DELETE /users/:id/mfa`.
- 2026-09-08 — Планові звіти (епік 2.7): `GET/POST /reports/schedules`, `PATCH/DELETE /reports/schedules/:id`, `POST /reports/schedules/:id/run`; архів `GET /reports` і `GET /reports/:code/download`; типи `haccp | alarms | energy`, щотижня/щомісяця, лист з PDF у вкладенні.
- 2026-09-08 — Життєвий цикл організації та експорт даних (епік 2.10): `closed` = вхід лише на читання (`423 organisation_closed` на зміни), `read_only_until` у `tenant` відповіді входу, purge через `CLOSED_RETENTION_DAYS`; `POST /tenants/:id/export`, `GET /tenants/:id/exports`, `GET /tenants/:id/exports/:exportId/download`; `DELETE /tenants/bulk` через спільну процедуру; `DELETE /users/:id` псевдонімізує аудит-лог.
- 2026-09-08 — Інтеграції (epic 2.6): API-ключі `GET/POST/DELETE /api-keys` (Bearer `modesp_…`, scope read|write|admin, заборонена поверхня `403 api_key_scope`), вебхуки `GET/POST/PATCH/DELETE /webhooks`, `POST /webhooks/:id/test|rotate-secret`, `GET /webhooks/:id/deliveries`, `POST /webhooks/:id/deliveries/:did/redeliver`; підпис `X-ModESP-Signature v1=HMAC-SHA256`.
- 2026-09-08 — OpenAPI 3.1 інтеграційної поверхні: `GET /api/docs` (Swagger UI), `GET /api/docs/openapi.json`, `docs/openapi.json` з перевіркою в CI (`npm run openapi:check`).
- 2026-09-08 — Прошивки (epic 2.8): платформенна бібліотека (`global`, `visibility`, `PATCH /firmware/:id`), перевірки перед OTA (`409 precheck_failed`, `force`), `GET/POST /ota/rollback`, відкладання в розгортанні, `paused_reason`, `acked_failures`, `kind/forced/actor` у завданнях, безпечне `DELETE /firmware/:id`, вікно оновлень у `tenants/:id/settings` (`ota_window_from/to`).
- 2026-09-08 — CSV-імпорт мережі (epic 2.12): `POST /devices/pending/batch` → `202` із задачею `imports`, `GET /devices/pending/template.csv`, `GET /imports`, `GET /imports/:id`, `GET /imports/:id/credentials.csv` (один раз), `POST /imports/:id/cancel`; до 2 000 рядків, перевірка плану, геокодування нових точок.
