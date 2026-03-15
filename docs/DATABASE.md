# Схема бази даних ModESP Cloud

## Принципи

- `tenant_id` присутній в **кожній** таблиці — мультитенантність закладена з першого дня
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

  UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
```

### `user_devices` — доступ користувачів до пристроїв

```sql
CREATE TABLE user_devices (
  user_id    UUID REFERENCES users(id)   ON DELETE CASCADE,
  device_id  UUID REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, device_id)
);
```

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

> `last_state` JSONB в `devices` — оновлюється in-place, не генерує нових рядків.
> Повний стан пристрою (~48 keys) доступний через один SELECT з devices.

---

## Changelog

- 2026-03-07 — Створено. Початкова схема.
- 2026-03-07 — Оновлено. Нові колонки devices (mqtt_device_id, serial_number, last_state, status, mqtt_password_hash). State metadata registry. Уточнення щодо server-side семплування.
- 2026-03-15 — Migration 016: password_reset_code + password_reset_expires колонки в users (admin-generated reset codes).
