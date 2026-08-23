# Схема бази даних ModESP Cloud

## Принципи

- `tenant_id` присутній в **кожній** таблиці — мультитенантність закладена з першого дня
  (єдиний свідомий виняток — `geocode_cache`, глобальний кеш публічних відповідей геокодера)
- Телеметрія партиціонується по місяцях — запити по часовому діапазону залишаються швидкими при зростанні даних
- UUID для всіх первинних ключів — безпечно для розподіленого середовища
- `TIMESTAMPTZ` для всіх часових полів — зберігається в UTC

---

## Таблиці

### `tenants` — організації

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(128) NOT NULL,
  slug        VARCHAR(64)  UNIQUE NOT NULL,  -- для URL та MQTT topics: acme, frigo-service
  plan        VARCHAR(16)  NOT NULL DEFAULT 'free',  -- free | pro | enterprise
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  active      BOOLEAN      NOT NULL DEFAULT true
);
```

> **slug** використовується в MQTT топіках: `modesp/v1/{slug}/{device_id}/...`
> Формат: 4-32 chars, lowercase, alphanumeric + hyphen. Unique constraint обов'язковий.

### `devices` — зареєстровані контролери

```sql
CREATE TABLE devices (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  mqtt_device_id   VARCHAR(16)  NOT NULL,          -- MAC-based ID з прошивки (A4CF12)
  serial_number    VARCHAR(64),                     -- заводський серійний номер
  name             VARCHAR(128),                    -- назва об'єкту ("Холодильник #3")
  location         VARCHAR(256),                    -- фізична адреса
  firmware_version VARCHAR(16),                     -- з heartbeat.fw
  proto_version    SMALLINT     NOT NULL DEFAULT 1,
  last_seen        TIMESTAMPTZ,
  last_state       JSONB,                           -- накопичений стан (48 keys)
  online           BOOLEAN      NOT NULL DEFAULT false,
  status           VARCHAR(16)  NOT NULL DEFAULT 'pending', -- pending | active | disabled
  mqtt_password_hash VARCHAR(256),                  -- bcrypt hash пароля MQTT
  latitude         DOUBLE PRECISION,                -- геокоордината для карти (migration 018)
  longitude        DOUBLE PRECISION,                -- геокоордината для карти (migration 018)
  site_id          UUID REFERENCES sites(id) ON DELETE SET NULL,  -- торгова точка (migration 021)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, mqtt_device_id)
);

CREATE UNIQUE INDEX idx_devices_mqtt_id ON devices(mqtt_device_id);
CREATE INDEX idx_devices_tenant        ON devices(tenant_id);
CREATE INDEX idx_devices_online        ON devices(tenant_id, online);
CREATE INDEX idx_devices_status        ON devices(status) WHERE status = 'pending';
```

**mqtt_device_id** — те що з'являється в MQTT топіках. Генерується прошивкою з MAC-адреси.
Глобально унікальний (unique index), бо MAC-адреса унікальна.

**serial_number** — заводський серійний номер. Вводиться вручну адміном.
Не використовується в MQTT — тільки для asset management в UI.

**last_state** — JSONB dump всіх 48 state keys. Оновлюється батчем (debounced).
Дозволяє відобразити повний стан пристрою без звернення до telemetry table.

**status**:
- `pending` — пристрій з'явився через auto-discovery, ще не призначений tenant
- `active` — нормальна робота
- `disabled` — вимкнений адміном

**latitude / longitude** — координати пристрою для інтерактивної карти (сторінка «Карта»).
NULL = пристрій не розміщено на карті. CHECK-обмеження: lat ∈ [-90, 90], lng ∈ [-180, 180].
Задаються вручну через PATCH /devices/:id або кліком на карті.

Після migration 021 це **необов'язковий override** над координатами точки: ефективні координати
пристрою на карті = `COALESCE(d.latitude, s.latitude)`. Важливо: `GET /devices` і `GET /devices/:id`
повертають **сирі** `latitude`/`longitude` пристрою і **не** застосовують до них COALESCE — координати
точки приходять окремими полями `site_latitude` / `site_longitude`. Інакше `PATCH {latitude: null}`
(«прибрати з карти») повертав би координати точки, і кнопка виглядала б зламаною.

**site_id** — торгова точка, до якої належить пристрій (migration 021). NULL = не прив'язаний.
`ON DELETE SET NULL`: видалення точки не видаляє пристрої. Кожна операція, що переносить пристрій в
інший тенант (м'яке видалення, масове видалення, `reset-pending`, `assign`, `reassign`), зобов'язана
дописати `site_id = NULL` — інакше пристрій лишиться вказувати на точку старого тенанта.

**location** лишається вільним текстом і після 021 — це «місце всередині точки» («Зал, ряд 3»), а не
адреса. Адреса живе в `sites`.

### `users` — користувачі

```sql
CREATE TABLE users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id),
  email        VARCHAR(256) NOT NULL,
  password_hash VARCHAR(256) NOT NULL,
  role         VARCHAR(16) NOT NULL DEFAULT 'viewer',  -- admin | technician | viewer
  push_token   VARCHAR(256),                            -- FCM token
  telegram_id  BIGINT,                                  -- Telegram user ID
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login   TIMESTAMPTZ,
  active       BOOLEAN     NOT NULL DEFAULT true,
  password_reset_code    VARCHAR(32),       -- hex code, 30-min TTL (migration 016)
  password_reset_expires TIMESTAMPTZ,       -- expiry timestamp
  base_latitude  DOUBLE PRECISION,          -- домашня база техніка (migration 021)
  base_longitude DOUBLE PRECISION,          -- домашня база техніка (migration 021)
  base_address   VARCHAR(256),              -- текстова адреса бази (migration 021)

  UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
```

**base_latitude / base_longitude / base_address** — звідки технік виїжджає на об'єкт. Використовуються
`GET /api/sites/:id/nearest-technicians`. Деталі й CHECK-обмеження — у розділі «Гео-таблиці».

### `user_devices` — доступ користувачів до пристроїв

```sql
CREATE TABLE user_devices (
  user_id    UUID REFERENCES users(id)   ON DELETE CASCADE,
  device_id  UUID REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, device_id)
);
```

> Починаючи з migration 021 це **не єдине** джерело доступу: ефективний набір пристроїв техніка =
> `user_devices ∪ (пристрої точок з user_sites)`. Дивись `user_sites` у розділі «Гео-таблиці».

### `alarms` — аварії

```sql
CREATE TABLE alarms (
  id           BIGSERIAL   PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  device_id    VARCHAR(16) NOT NULL,          -- mqtt_device_id
  alarm_code   VARCHAR(32) NOT NULL,          -- protection key без prefix
  severity     VARCHAR(8)  NOT NULL,          -- critical | warning | info
  active       BOOLEAN     NOT NULL DEFAULT true,
  value        FLOAT,                         -- значення що викликало аварію
  limit_value  FLOAT,                         -- межа яка була перевищена
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at   TIMESTAMPTZ,

  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_alarms_tenant_device ON alarms(tenant_id, device_id);
CREATE INDEX idx_alarms_active        ON alarms(tenant_id, active) WHERE active = true;
CREATE INDEX idx_alarms_time          ON alarms(tenant_id, triggered_at DESC);
```

> **Як створюються записи:** Cloud детектує transition protection.*_alarm false→true
> з individual MQTT keys. При true→false — оновлює `cleared_at`.
> Severity маппінг визначається в cloud config (state_meta.json).

### `telemetry` — часові ряди температур

```sql
-- Батьківська таблиця з партиціонуванням по місяцях
CREATE TABLE telemetry (
  time       TIMESTAMPTZ NOT NULL,
  tenant_id  UUID        NOT NULL,
  device_id  VARCHAR(16) NOT NULL,           -- mqtt_device_id
  channel    VARCHAR(16) NOT NULL,           -- air | evap | cond | setpoint | humidity
  value      FLOAT       NOT NULL
) PARTITION BY RANGE (time);

-- Партиції створюються автоматично (cron або pg_partman)
CREATE TABLE telemetry_2026_03
  PARTITION OF telemetry
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE INDEX idx_telemetry_lookup
  ON telemetry(tenant_id, device_id, channel, time DESC);
```

> **Семплування:** Cloud кожні 5 хвилин зберігає snapshot temperature channels
> з in-memory accumulated state. ESP32 НЕ надсилає telemetry bundles —
> семплування виконується server-side.

> **Майбутнє:** замінити на TimescaleDB hypertable при досягненні 10М+ рядків.

### `events` — події компресора і відтайки

```sql
CREATE TABLE events (
  id         BIGSERIAL   PRIMARY KEY,
  tenant_id  UUID        NOT NULL,
  device_id  VARCHAR(16) NOT NULL,           -- mqtt_device_id
  event_type VARCHAR(32) NOT NULL,           -- compressor_on/off, defrost_start/end, ...
  time       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_lookup ON events(tenant_id, device_id, time DESC);
```

> **Як створюються записи:** Cloud детектує state transitions:
> `equipment.compressor` false→true = `compressor_on`, тощо.

### `refresh_tokens` — JWT refresh токени

```sql
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(256) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked     BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
```

---

## Гео-таблиці (migration 021)

Migration `021_sites.sql` додає **п'ять нових таблиць** (`sites`, `geocode_cache`, `user_sites`,
`weather_observations`, `site_public_links`) і **чотири нові колонки** (`devices.site_id`,
`users.base_latitude`, `users.base_longitude`, `users.base_address`). Файл ідемпотентний — кожен
statement це `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING`.

### `sites` — торгові точки

```sql
CREATE TABLE sites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(256) NOT NULL,      -- назва точки, напр. "АТБ №142"
  country_code  CHAR(2),                    -- ISO 3166-1 alpha-2: 'UA'
  country       VARCHAR(64),
  region        VARCHAR(128),               -- область
  city          VARCHAR(128),
  address_line  VARCHAR(256),               -- вулиця, будинок
  postal_code   VARCHAR(16),
  latitude      DOUBLE PRECISION CHECK (latitude  >= -90  AND latitude  <= 90),
  longitude     DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180),
  geo_source    VARCHAR(16) NOT NULL DEFAULT 'none'
                CHECK (geo_source IN ('none','geocoded','manual','failed')),
  geo_precision VARCHAR(16),                -- house | street | city | region | country
  geocoded_at   TIMESTAMPTZ,
  geo_attempts  SMALLINT NOT NULL DEFAULT 0,   -- діагностика невдалого геокодування
  geo_last_attempt_at TIMESTAMPTZ,
  geo_error     TEXT,
  osm_type      VARCHAR(16),
  osm_id        BIGINT,
  timezone      VARCHAR(64),                -- IANA, напр. 'Europe/Kyiv'
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id)   -- ціль композитного FK для дочірніх таблиць
);

CREATE UNIQUE INDEX uq_sites_tenant_name ON sites (tenant_id, lower(btrim(name)));
CREATE INDEX idx_sites_tenant  ON sites (tenant_id);
CREATE INDEX idx_sites_city    ON sites (tenant_id, city);
CREATE INDEX idx_sites_region  ON sites (tenant_id, region);
CREATE INDEX idx_sites_country ON sites (tenant_id, country_code);
CREATE INDEX idx_sites_coords  ON sites (tenant_id, latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX idx_sites_geocode_pending ON sites (tenant_id) WHERE geo_source = 'none';
```

**name — VARCHAR(256), не 128.** `devices.location` це `VARCHAR(256)`, а backfill копіює `location` в
`name`. При 128 символах рядок з довгою локацією впав би на `22001` і відкотив усю міграцію — і тільки
на продакшн-даних.

**Унікальність назви — функціональний індекс, не `UNIQUE (tenant_id, name)`.** `lower(btrim(name))`
означає, що «АТБ №142», «атб №142» і « АТБ №142 » — це одна точка. `UNIQUE (tenant_id, id)` — окреме
обмеження, воно потрібне як ціль композитних FK у `user_sites`, `weather_observations` і
`site_public_links`.

**`tenant_id ... ON DELETE CASCADE`** — обов'язковий. `routes/tenants.js` видаляє тенанта, вручну
перелічуючи дочірні таблиці; без каскаду кожне видалення тенанта падало б на `23503`.

**geo_source:**

| Значення | Що означає |
|---|---|
| `none` | адреса є, координат ще немає — черга на геокодування |
| `geocoded` | координати від провайдера (Nominatim) |
| `manual` | координати задані людиною (перетягування маркера / ручний ввід) |
| `failed` | 3+ невдалі спроби; причина в `geo_error` |

**Координати ніколи не перезаписуються при невдачі.** Невдале геокодування інкрементує `geo_attempts`,
пише `geo_last_attempt_at` і `geo_error` — а `latitude`, `longitude`, `geo_source`, `geo_precision`,
`geocoded_at` лишаються як були. Виправлення друкарської помилки в адресі під час недоступності
Nominatim не має стирати точку з карти.

> **`updated_at` не має тригера.** У `backend/src/db/` немає функції `set_updated_at()`, і ця міграція
> її не додає. Тому **кожен** `UPDATE sites ...` у коді зобов'язаний дописати `updated_at = NOW()` до
> свого SET-списку: PATCH-хендлер, запис результату геокодування, автозаповнення таймзони.

### `geocode_cache` — кеш відповідей геокодера

```sql
-- Свідомо ГЛОБАЛЬНА таблиця (без tenant_id): ключ — нормалізований публічний рядок адреси,
-- значення — публічна відповідь OSM/Nominatim. Нічого похідного від тенанта не зберігається.
CREATE TABLE geocode_cache (
  query_hash  CHAR(64) PRIMARY KEY,        -- sha256 нормалізованого запиту
  query_text  TEXT NOT NULL,
  provider    VARCHAR(24) NOT NULL,
  result      JSONB,                       -- NULL = негативний кеш (провайдер відповів, збігів немає)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_geocode_cache_expires ON geocode_cache (expires_at);
```

Це **єдина таблиця в схемі без `tenant_id`**, і це свідоме рішення, а не недогляд: у ній немає жодного
поля, яке належить тенанту.

**`expires_at` розділяє два різні терміни життя:**

| Що сталося | Що записується | TTL |
|---|---|---|
| HTTP 200 + збіг | `result` = JSONB | `GEOCODER_CACHE_TTL_DAYS` (180 днів) |
| HTTP 200 + порожній масив | `result` = NULL | `GEOCODER_NEGATIVE_TTL_MIN` (6 годин) |
| Timeout / 429 / 5xx / transport error | **нічого** | — |

Без цього розділення один збій Nominatim робив би адресу негеокодовною на 180 днів, і відрізнити збій
від справжньої відсутності збігу було б неможливо. Прострочені рядки видаляються фоновим sweep-ом раз
на 6 годин — інакше `/api/geo/search` перетворюється на автентифікований примітив заповнення диска.

### `devices.site_id` — прив'язка пристрою до точки

```sql
ALTER TABLE devices ADD COLUMN site_id UUID REFERENCES sites(id) ON DELETE SET NULL;
CREATE INDEX idx_devices_site ON devices (site_id) WHERE site_id IS NOT NULL;
```

**Композитного FK `(tenant_id, site_id) → sites (tenant_id, id)` свідомо НЕМАЄ.** П'ять наявних шляхів
коду переносять пристрій у системний тенант, не чіпаючи `site_id` (м'яке видалення, масове видалення,
`reset-pending`, `reassign`, видалення тенанта) — композитний FK перетворив би кожен із них на runtime
`23503`. Узгодженість тенанта натомість тримається на трьох речах: каскаді від `sites.tenant_id`,
обов'язковому предикаті `AND s.tenant_id = d.tenant_id` у **кожному** join'і devices↔sites у коді, і
явному `site_id = NULL` у SET-списку кожної операції, що змінює тенант пристрою.

**Backfill.** Міграція створює по одній точці на кожну унікальну пару
`(tenant_id, lower(btrim(location)))` і проставляє `devices.site_id`. Виключені: системний тенант
(туди CSV-імпорт кладе ще не призначені пристрої), рядки зі `status IN ('deleted','pending')` і м'яко
видалені (`deleted_at IS NOT NULL`). UPDATE захищений умовою `d.site_id IS NULL` — **тільки заповнює,
ніколи не перезаписує**: повторний прогін міграції (а це реальний сценарій і в тестах, і в ручному
runbook'у) інакше повернув би кожен призначений адміном пристрій назад до точки, виведеної з
`location`. Наприкінці `RAISE NOTICE` друкує, скільки пристроїв із локацією лишилися без точки.

**`devices.location` не очищається.** Вона лишається вільним текстом «місце всередині точки» («Зал,
ряд 3») і використовується CSV-імпортом, Telegram-ботом і фільтрами. Дедуплікація показу (коли
`location` збігається з `site.name`) — задача UI, не бази.

### `user_sites` — доступ користувачів до точок

```sql
CREATE TABLE user_sites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id    UUID NOT NULL,
  tenant_id  UUID NOT NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_user_sites_site        ON user_sites (site_id);
CREATE INDEX idx_user_sites_user_tenant ON user_sites (user_id, tenant_id);
```

Друге покоління RBAC поряд із `user_devices`: доступ користувача = `user_devices ∪ (пристрої точок з
user_sites)`. `tenant_id` обов'язковий, і саме він робить можливим композитний FK — грант **фізично**
не може перетнути межу тенанта.

`granted_by ... ON DELETE SET NULL` теж обов'язковий: `DELETE /api/users/:id` робить hard delete і
вручну занулює лише кілька відомих йому посилань; ненульоване посилання звідси повертало б 500.

### `weather_observations` — історія зовнішньої погоди по точках

```sql
CREATE TABLE weather_observations (
  site_id      UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,       -- вирівняно по годині (Open-Meteo)
  temp_c       NUMERIC(5,2),
  humidity     SMALLINT,
  pressure_hpa NUMERIC(6,1),
  wind_ms      NUMERIC(5,2),
  weather_code SMALLINT,
  PRIMARY KEY (site_id, observed_at),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_weather_obs_time ON weather_observations (observed_at);
```

PK починається з `site_id`, тому sweep по терміну зберігання (`WHERE observed_at < ...`) потребує
власного індексу.

**Зберігання, не партиціонування.** `WEATHER_RETENTION_DAYS=395` (порівняння рік-до-року ще працює),
чистить `backend/scripts/cleanup-weather.js` за cron поряд із `cleanup-telemetry.js`. Обсяг малий:
одна точка × 24 години = 24 рядки/добу, тобто ~9 тис. рядків на точку на рік.

Запис — `INSERT ... ON CONFLICT (site_id, observed_at) DO NOTHING`, тому перезапуск бекенду в межах
тієї ж години не дублює даних.

### `site_public_links` — публічні read-only посилання на статус точки

```sql
CREATE TABLE site_public_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  site_id     UUID NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,    -- sha256(raw token)
  label       VARCHAR(128),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  revoked_at  TIMESTAMPTZ,
  view_count  INTEGER NOT NULL DEFAULT 0,
  last_viewed TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_site_public_links_site ON site_public_links (site_id);
```

**Зберігається тільки sha256 токена.** Сирий токен (32 випадкові байти, `base64url`) показується
адміну рівно один раз — у відповіді на створення — і більше ніколи; у логи він не потрапляє, в
`audit_log` не пишеться (там лише `site_id`, `label`, `expires_at`).

**`expires_at` — NOT NULL із дефолтом 90 днів.** Безстроковий публічний доступ до даних тенанта
неприйнятний, навіть попри те, що токен передається заголовком `X-Site-Token` і не потрапляє в
access-лог nginx.

Пошук завжди одна параметризована рівність по UNIQUE-колонці; відсутній, відкликаний і прострочений
токени дають **однакову 404** — підтверджувати, що токен колись існував, не можна.

### `users` — домашня база персоналу

```sql
ALTER TABLE users
  ADD COLUMN base_latitude  DOUBLE PRECISION CHECK (base_latitude  >= -90  AND base_latitude  <= 90),
  ADD COLUMN base_longitude DOUBLE PRECISION CHECK (base_longitude >= -180 AND base_longitude <= 180),
  ADD COLUMN base_address   VARCHAR(256);

CREATE INDEX idx_users_base_location ON users (tenant_id)
  WHERE base_latitude IS NOT NULL AND base_longitude IS NOT NULL;
```

Домашня база техніка — звідки він виїжджає на об'єкт. Використовується
`GET /api/sites/:id/nearest-technicians`. Технік редагує свою базу сам через `PATCH /api/profile`,
адмін може задати чужу через `PUT /api/users/:id`.

### GRANT — обов'язкові, по одному на фізичний рядок

На продакшні DDL виконується від власника схеми (`postgres`), тому роль застосунку не отримує жодних
прав на нові таблиці автоматично: `ALTER DEFAULT PRIVILEGES` у репозиторії немає, а `infra/setup.sh`
видає права лише на **базу**. Без цих рядків кожен виклик `/api/sites`, `/api/map` і `/api/stats/geo`
у продакшні повертає `permission denied for table sites` — і жоден тест цього не ловить, бо тестовий
раннер міграцій коментує GRANT-и.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON geocode_cache TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON weather_observations TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_public_links TO modesp_cloud;
```

> Ім'я ролі має збігатися з `DB_USER` у `.env`. Жоден GRANT не можна переносити на другий рядок:
> тестовий раннер міграцій коментує рядки за шаблоном `^(GRANT|REVOKE)\b.*$`, і перенесений statement
> лишив би висячий хвіст `ON sites TO ...;`, який ламає весь тестовий набір.

> **RLS на нових таблицях не вмикається** — свідомо. Шар RLS у проєкті сплячий: жоден рядок у
> `backend/src` не викликає `set_config('app.current_tenant', ...)`. Увімкнення RLS на таблицях,
> створених `postgres`, поки застосунок ходить під іншою роллю, повернуло б нуль рядків на кожен
> гео-запит у продакшні. Ізоляція тенантів тут тримається на `WHERE tenant_id = $N` у кожному запиті,
> як і в решті схеми.

---

## State Metadata Registry

Файл `backend/src/config/state_meta.json` — імпорт з `ModESP_v4/generated/state_meta.h`.

```json
[
  {"key": "thermostat.setpoint", "type": "float", "writable": true, "persist": true, "min": -50, "max": 50, "step": 0.5, "default": 4.0},
  {"key": "protection.high_limit", "type": "float", "writable": true, "persist": true, "min": -50, "max": 99, "step": 0.5, "default": 12.0},
  ...
]
```

61 запис. Використовується для:
- **Валідація команд** — перевірка type, writable, min/max перед MQTT publish
- **UI rendering** — step для слайдерів, min/max для input fields
- **Telemetry coercion** — парсинг scalar string → typed value

---

## Row-Level Security (додатковий захист)

```sql
ALTER TABLE devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarms    ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON devices
  USING (tenant_id = current_setting('app.current_tenant')::UUID);
```

---

## Партиціонування телеметрії — автоматизація

```sql
CREATE OR REPLACE FUNCTION create_telemetry_partition(year INT, month INT)
RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := format('telemetry_%s_%s', year, lpad(month::TEXT, 2, '0'));
  start_date := make_date(year, month, 1);
  end_date := start_date + INTERVAL '1 month';

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF telemetry
     FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;
```

---

## Оцінка об'єму даних

| Таблиця | Рядків/день (100 пристроїв) | Розмір/місяць |
|---------|----------------------------|---------------|
| telemetry (5хв семплування) | 28,800 | ~50 MB |
| alarms | ~100 | < 1 MB |
| events | ~500 | < 1 MB |
| weather_observations (20 точок, 1 год) | 480 | < 1 MB |
| geocode_cache | ~0 (пише лише на промах кешу) | < 1 MB |

> `last_state` JSONB в `devices` — оновлюється in-place, не генерує нових рядків.
> Повний стан пристрою (~48 keys) доступний через один SELECT з devices.

---

## Changelog

- 2026-03-07 — Створено. Початкова схема.
- 2026-03-07 — Оновлено. Нові колонки devices (mqtt_device_id, serial_number, last_state, status, mqtt_password_hash). State metadata registry. Уточнення щодо server-side семплування.
- 2026-03-15 — Migration 016: password_reset_code + password_reset_expires колонки в users (admin-generated reset codes).
- 2026-03-31 — Migration 018: latitude + longitude колонки в devices (інтерактивна карта пристроїв).
- 2026-08-23 — Migration 021 (Phase 14, гео): п'ять нових таблиць — `sites`, `geocode_cache`,
  `user_sites`, `weather_observations`, `site_public_links`; нові колонки `devices.site_id` і
  `users.base_latitude` / `base_longitude` / `base_address`; backfill точок з `devices.location`.
  Свідомі рішення на запис: немає композитного FK `devices → sites`, немає RLS на нових таблицях,
  немає тригера `updated_at`, `geocode_cache` без `tenant_id`.
