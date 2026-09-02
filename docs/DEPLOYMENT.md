# Розгортання ModESP Cloud (VPS)

## Вимоги до сервера

| Параметр | Мінімум (старт) | Рекомендовано (100+ пристроїв) |
|----------|-----------------|-------------------------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 2 GB | 4 GB |
| Диск | 20 GB SSD | 50 GB SSD |
| ОС | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |
| Провайдери | Hetzner CX22 (~4$/міс), DigitalOcean, Vultr | |

---

## Стек компонентів

```
Ubuntu 24.04
├── Nginx           (reverse proxy, HTTPS)
├── Mosquitto       (MQTT брокер, порти 1883/8883)
├── Node.js 22      (бекенд сервіс)
├── PostgreSQL 16   (база даних)
└── systemd         (управління процесами)
```

---

## Структура портів

| Порт | Сервіс | Доступ |
|------|--------|--------|
| 80 | Nginx (redirect → 443) | публічний |
| 443 | Nginx HTTPS | публічний |
| 1883 | Mosquitto (plain MQTT) | закритий (тільки localhost) |
| 8883 | Mosquitto (MQTT over TLS) | публічний (тільки ESP32) |
| 3000 | Node.js API | тільки localhost (через Nginx) |
| 5432 | PostgreSQL | тільки localhost |

---

## Структура на сервері

```
/opt/modesp-cloud/
├── backend/
│   ├── src/
│   │   ├── index.js                 # точка входу
│   │   ├── db/
│   │   │   ├── schema.sql           # повна схема
│   │   │   └── migrations/
│   │   │       ├── 002_notification_tables.sql
│   │   │       ├── 003_ota_tables.sql
│   │   │       ├── 004_ota_pre_version.sql
│   │   │       ├── 005_device_model_comment.sql
│   │   │       ├── 006_device_rbac.sql
│   │   │       ├── 007_firmware_board_type.sql
│   │   │       ├── 008_mqtt_auth.sql
│   │   │       ├── 009_superadmin_role.sql
│   │   │       ├── 010_user_tenants.sql
│   │   │       ├── 011_mqtt_bootstrap.sql
│   │   │       ├── 012_telegram_linking.sql
│   │   │       ├── 013_refresh_token_tenant.sql
│   │   │       ├── 014_push_subscriptions.sql
│   │   │       ├── 015_audit_log.sql
│   │   │       ├── 016_password_reset.sql
│   │   │       ├── 018_device_geo.sql
│   │   │       ├── 018_soft_delete_devices.sql
│   │   │       ├── 019_energy_monitoring.sql
│   │   │       ├── 020_telegram_id_unique.sql
│   │   │       └── 021_sites.sql        # торгові точки + гео (фаза 14)
│   │   └── ...
│   ├── scripts/
│   │   ├── grant-all-devices.js     # backward compat RBAC migration
│   │   ├── cleanup-telemetry.js     # retention: видаляє партиції >TELEMETRY_RETENTION_DAYS
│   │   ├── cleanup-weather.js       # retention: weather_observations >WEATHER_RETENTION_DAYS
│   │   ├── cleanup-aux.js           # retention: events, notification_log, alarms, refresh_tokens
│   │   └── provision-mqtt-creds.js  # генерує MQTT credentials для існуючих пристроїв
│   ├── .env                         # конфігурація (не в git!)
│   └── package.json
├── webui/
│   ├── dist/                        # збілджений SPA (Nginx serve)
│   ├── .env                         # VITE_MAP_TILE_URL / VITE_MAP_ATTRIBUTION (не в git!)
│   └── package.json
└── infra/
    ├── setup.sh                     # первинне налаштування VPS
    ├── backup.env.example           # шаблон → infra/backup.env (не в git!)
    ├── scripts/
    │   ├── backup-postgres.sh       # щоденний архів: дамп БД + конфіги + прошивки
    │   ├── alert-telegram.sh        # алерт у Telegram про збій юніта (modesp-alert@)
    │   └── tls-deploy-hook.sh       # certbot deploy hook: сертифікат → Mosquitto, reload
    ├── journald/modesp.conf         # ліміти журналу (500 MB / 30 днів)
    ├── systemd/
    │   ├── modesp-backend.service
    │   ├── modesp-alert@.service                        # OnFailure= кожного юніта нижче
    │   ├── modesp-backup.service / .timer               # 02:00 щодня
    │   ├── modesp-telemetry-partition.service / .timer  # 25-го, 03:00
    │   └── modesp-retention-cleanup.service / .timer    # 03:30 щодня
    ├── nginx/                       # modesp.conf + ratelimit.conf
    └── mosquitto/
```

---

## Ліцензування третіх сторін — прочитати ДО продакшну

ModESP Cloud — комерційний продукт. Гео-функціонал спирається на п'ять зовнішніх сервісів, які зараз
увімкнені на їхніх **безкоштовних / некомерційних** умовах, бо це демо-розгортання.

| Сервіс | Що дає | Потрібно до продакшну | Змінна |
|---|---|---|---|
| Nominatim (OSM) | геокодування адрес, автодоповнення | self-hosted Nominatim або платний геокодер | `GEOCODER_URL` |
| Open-Meteo | зовнішня погода, таймзони точок | платний план або self-hosted | `WEATHER_PROVIDER` |
| OSRM | маршрути, оптимізація обʼїзду | **обовʼязково** self-hosted: `router.project-osrm.org` це community demo-сервер, прямо не призначений для продакшну | `OSRM_URL` |
| OpenRouteService | ізохрони доїзду | API-ключ + платний план, або self-hosted | `ORS_API_KEY` |
| Тайли OpenStreetMap | сама карта | платний провайдер тайлів або власні тайли | `VITE_MAP_TILE_URL` |

Повний чекліст, варіанти по кожному сервісу і зобовʼязання щодо атрибуції —
**[`docs/THIRD_PARTY_LICENSING.md`](THIRD_PARTY_LICENSING.md)**. Це блокер продакшну, а не побажання.

Кожен із них вимикається однією змінною оточення і деградує у **робочий вимкнений стан**: платформа не
ламається, зникає лише відповідна функція (детально — у тому ж файлі). Атрибуцію
`© OpenStreetMap contributors` прибирати не можна за жодних умов — цього вимагає ліцензія ODbL,
незалежно від того, безкоштовний у вас провайдер тайлів чи платний.

---

## Кроки розгортання

### 1. Базове налаштування сервера

```bash
# Оновлення системи
apt update && apt upgrade -y

# Встановлення базових утиліт
apt install -y curl git ufw fail2ban

# Firewall
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw allow 8883/tcp # MQTT TLS
ufw enable
```

### 2. PostgreSQL

```bash
apt install -y postgresql-16

# Створити БД і користувача
sudo -u postgres psql <<EOF
CREATE USER modesp_cloud WITH PASSWORD 'STRONG_PASSWORD_HERE';
CREATE DATABASE modesp_cloud OWNER modesp_cloud;
\q
EOF

# Застосувати схему
sudo -u postgres psql -d modesp_cloud \
  -f /opt/modesp-cloud/backend/src/db/schema.sql
```

**Застосування міграцій** (завжди через `sudo -u postgres`):

```bash
cd /opt/modesp-cloud

# Застосувати всі міграції по порядку
sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/002_notification_tables.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/003_ota_tables.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/004_ota_pre_version.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/005_device_model_comment.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/006_device_rbac.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/007_firmware_board_type.sql

sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/008_mqtt_auth.sql
```

**Після міграції 006** (RBAC) — призначити всі пристрої існуючим юзерам:

```bash
cd /opt/modesp-cloud/backend
node scripts/grant-all-devices.js          # dry-run (перегляд)
node scripts/grant-all-devices.js --apply  # виконати
```

**Після міграції 008** (MQTT Auth) — згенерувати MQTT credentials для існуючих пристроїв:

```bash
cd /opt/modesp-cloud/backend
node scripts/provision-mqtt-creds.js          # dry-run (перегляд)
node scripts/provision-mqtt-creds.js --apply  # генерує паролі
```

Решта міграцій (`009_superadmin_role.sql` … `020_telegram_id_unique.sql`) застосовуються так само —
по порядку номерів, тією ж командою. Повний перелік — у розділі «Структура на сервері» вище.

**Міграція 021** (торгові точки / гео, фаза 14) — як і всі DDL-міграції, виконується **від власника
схеми**:

```bash
cd /opt/modesp-cloud
sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/021_sites.sql
```

Що вона робить:
- створює `sites`, `geocode_cache`, `user_sites`, `weather_observations`, `site_public_links`
- додає `devices.site_id` і `users.base_latitude` / `base_longitude` / `base_address`
- переносить наявні значення `devices.location` у торгові точки (backfill) і проставляє `site_id`
- видає права ролі застосунку (GRANT)

Міграція **ідемпотентна**: повторний запуск безпечний і ніколи не перезаписує `site_id`, проставлений
вручну після першого прогону.

**Перевірте ім'я ролі в GRANT-ах.** Файл видає права ролі `modesp_cloud`. Якщо ваш `DB_USER` інший —
відредагуйте ці пʼять рядків перед запуском або виконайте їх окремо:

```bash
sudo -u postgres psql -d modesp_cloud <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON geocode_cache TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON weather_observations TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_public_links TO modesp_cloud;
SQL
```

Без цих прав `/api/sites`, `/api/map` і `/api/stats/geo` у продакшні повертають
`permission denied for table sites`. Тести цього не ловлять — тестовий раннер міграцій GRANT-и
коментує.

**Перевірка після застосування:**

```bash
# 5 нових таблиць існують (має повернути 5 рядків)
sudo -u postgres psql -d modesp_cloud -c \
  "SELECT tablename FROM pg_tables WHERE tablename IN ('sites','geocode_cache','user_sites','weather_observations','site_public_links');"

# backfill відпрацював: скільки точок створено
sudo -u postgres psql -d modesp_cloud -c "SELECT count(*) FROM sites;"

# скільки пристроїв з локацією лишилися без точки (очікується 0)
sudo -u postgres psql -d modesp_cloud -c \
  "SELECT count(*) FROM devices WHERE location IS NOT NULL AND btrim(location) <> '' AND site_id IS NULL AND status NOT IN ('deleted','pending') AND deleted_at IS NULL;"

# права видані (від імені ролі застосунку)
PGPASSWORD=... psql -h localhost -U modesp_cloud -d modesp_cloud -c "SELECT count(*) FROM sites;"
```

### 3. Mosquitto + mosquitto-go-auth

#### Встановити Mosquitto

```bash
apt install -y mosquitto mosquitto-clients
```

#### Build mosquitto-go-auth plugin

```bash
apt install -y golang-go libmosquitto-dev pkg-config git
cd /tmp && git clone https://github.com/iegomez/mosquitto-go-auth.git
cd mosquitto-go-auth && make
sudo cp go-auth.so /usr/lib/mosquitto/go-auth.so
```

#### Створити PostgreSQL read-only user для plugin

```bash
sudo -u postgres psql -d modesp_cloud <<EOF
CREATE USER modesp_mqtt_ro WITH PASSWORD 'STRONG_RO_PASSWORD';
GRANT CONNECT ON DATABASE modesp_cloud TO modesp_mqtt_ro;
GRANT USAGE ON SCHEMA public TO modesp_mqtt_ro;
GRANT SELECT ON devices, tenants TO modesp_mqtt_ro;
EOF
```

#### Конфіг Mosquitto

Скопіювати з repo `infra/mosquitto/mosquitto.conf` → `/etc/mosquitto/conf.d/modesp.conf`.

Ключові моменти:
- `per_listener_settings true` — auth plugin тільки на порті 8883
- Listener 1883 (localhost) — anonymous, для backend
- Listener 8883 (TLS) — auth через mosquitto-go-auth → PostgreSQL
- ACL: read/write розділені (subscribe `cmd/+`, publish `state/+`, `status`, `heartbeat`)
- Cache: 300s auth, 60s ACL

Замінити в конфігу:
- `auth_opt_pg_password` — пароль `modesp_mqtt_ro`

#### TLS сертифікати (Let's Encrypt)

```bash
# Отримати сертифікат (зупинити nginx щоб звільнити порт 80)
apt install -y certbot
systemctl stop nginx
certbot certonly --standalone -d YOUR_DOMAIN
systemctl start nginx

# Копіювати для Mosquitto
mkdir -p /etc/mosquitto/certs
cp /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem /etc/mosquitto/certs/server.crt
cp /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem /etc/mosquitto/certs/server.key
chown mosquitto:mosquitto /etc/mosquitto/certs/*
chmod 600 /etc/mosquitto/certs/server.key
```

**Важливо:** `certfile` має бути `fullchain.pem` (не `cert.pem`), щоб клієнти могли перевірити ланцюжок сертифікатів. `cafile` не потрібен (не mutual TLS).

#### Auto-renewal hook

Хук лежить у репозиторії — `infra/scripts/tls-deploy-hook.sh`. Він копіює сертифікат у
`/etc/mosquitto/certs`, робить `systemctl reload mosquitto` (Mosquitto 2.x перечитує сертифікати за
SIGHUP, сесії пристроїв не рвуться), **перевіряє через `openssl s_client`, що брокер справді віддає
новий сертифікат**, і лише якщо ні — робить `restart`. Потім `reload nginx`.

```bash
cp /opt/modesp-cloud/infra/scripts/tls-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh

# Перший запуск вручну (і перевірка після кожного оновлення хука)
RENEWED_LINEAGE=/etc/letsencrypt/live/modesp.com.ua /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
certbot renew --dry-run
```

ESP32 firmware автоматично включає TLS при порті 8883 (`esp_crt_bundle_attach` — вбудований CA bundle включає Let's Encrypt).

```bash
systemctl enable mosquitto
systemctl start mosquitto
```

#### Верифікація auth

```bash
# ✅ Правильний пароль + TLS
mosquitto_pub -h YOUR_DOMAIN -p 8883 \
  --cafile /etc/ssl/certs/ca-certificates.crt \
  -u device_A4CF12 -P correct_pass \
  -t "modesp/v1/acme/A4CF12/status" -m "online"

# ❌ Неправильний пароль
mosquitto_pub -h YOUR_DOMAIN -p 8883 \
  --cafile /etc/ssl/certs/ca-certificates.crt \
  -u device_A4CF12 -P wrong_pass \
  -t "modesp/v1/acme/A4CF12/status" -m "online"
# → Connection Refused

# ✅ Backend на localhost (без auth)
mosquitto_pub -h localhost -p 1883 -t "test" -m "ok"
```

### 4. Node.js

```bash
# Встановити Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Створити системного користувача
useradd -r -s /usr/sbin/nologin -d /opt/modesp-cloud modesp

# Розгорнути код
mkdir -p /opt/modesp-cloud
cd /opt/modesp-cloud
git clone https://github.com/Zapadenec1982/ModESP_Cloud.git .
chown -R modesp:modesp /opt/modesp-cloud

# Встановити залежності бекенду
cd backend
npm install --production

# Створити .env файл
cp .env.example .env
nano .env

# Зібрати WebUI
cd ../webui
cp .env.example .env    # адреса тайлів карти; за замовчуванням — публічні тайли OSM
npm install
npm run build
```

`webui/.env` (шаблон — `webui/.env.example`):

```bash
VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
VITE_MAP_ATTRIBUTION=© OpenStreetMap contributors
```

> **Зміна тайл-хоста вимагає трьох синхронних правок**, інакше браузер заблокує тайли по CSP:
> `VITE_MAP_TILE_URL` тут, `img-src` у helmet (`backend/src/index.js`) і **обидва** заголовки
> Content-Security-Policy у `infra/nginx/modesp.conf`. Змінні `VITE_*` вшиваються під час
> `npm run build` — після зміни WebUI треба перезібрати.

`.env` файл (`/opt/modesp-cloud/backend/.env`):

```bash
NODE_ENV=production
PORT=3000

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=modesp_cloud
DB_USER=modesp_cloud
DB_PASS=STRONG_PASSWORD_HERE

# MQTT (бекенд читає лише MQTT_URL; MQTT_HOST/MQTT_PORT не використовуються)
MQTT_URL=mqtt://localhost:1883
MQTT_USER=modesp_backend
MQTT_PASS=MQTT_BACKEND_PASSWORD

# JWT
JWT_SECRET=LONG_RANDOM_SECRET_HERE
JWT_EXPIRES_IN=900
JWT_REFRESH_EXPIRES_IN=2592000

# Auth (true для production, false для розробки без логіну)
AUTH_ENABLED=true

# MQTT Bootstrap (shared password for new ESP32 devices)
MQTT_BOOTSTRAP_PASSWORD=shared_bootstrap_password_here
MQTT_PUBLIC_HOST=modesp.com.ua

# Firebase FCM (опціонально) — шлях до JSON сервісного акаунта, не server key
FCM_SERVICE_ACCOUNT_PATH=/opt/modesp-cloud/backend/fcm-service-account.json

# Telegram (опціонально)
TELEGRAM_BOT_TOKEN=your_bot_token

# --- Гео-сервіси (фаза 14) ---
# ДЕМО-конфігурація. Політики і що треба купити/розгорнути до продакшну:
# docs/THIRD_PARTY_LICENSING.md і розділ «Ліцензування третіх сторін» вище.
# Усі таймаути мають лишатися нижче nginx `proxy_read_timeout 30s` для location /api/.

# Геокодування (Nominatim). Порожнє або none = вимкнено повністю
GEOCODER_PROVIDER=nominatim
GEOCODER_URL=https://nominatim.openstreetmap.org
GEOCODER_USER_AGENT=ModESP-Cloud/1.0 (admin@your-domain.tld)
GEOCODER_EMAIL=admin@your-domain.tld
GEOCODER_RATE_LIMIT_MS=1100
GEOCODER_CACHE_TTL_DAYS=180
GEOCODER_TIMEOUT_MS=8000
GEOCODER_NEGATIVE_TTL_MIN=360
GEOCODER_BULK_ENABLED=false

# Зовнішня погода (Open-Meteo). Порожнє або none = вимкнено
WEATHER_PROVIDER=open-meteo
WEATHER_URL=https://api.open-meteo.com/v1
WEATHER_CACHE_TTL_MIN=30
WEATHER_POLL_INTERVAL_MIN=60
WEATHER_TIMEOUT_MS=8000
WEATHER_RETENTION_DAYS=395

# Маршрутизація (OSRM). Порожнє = планувальник обʼїзду деградує до прямих ліній
OSRM_URL=https://router.project-osrm.org
OSRM_TIMEOUT_MS=10000

# Ізохрони (OpenRouteService). Порожній ключ = наближені кільця прямої відстані
ORS_URL=https://api.openrouteservice.org
ORS_API_KEY=
ORS_TIMEOUT_MS=10000
```

Що важливо знати про ці змінні:

| Змінна | Наслідок |
|---|---|
| `GEOCODER_PROVIDER=` / `none` | геокодування вимкнено: автодоповнення адреси зникає з UI, координати вводяться вручну |
| `GEOCODER_USER_AGENT` | політика OSM **вимагає** ідентифікованого User-Agent з робочим контактом. Дефолтний або підроблений UA — привід для блокування |
| `GEOCODER_RATE_LIMIT_MS` | не опускати нижче 1100 для публічного Nominatim — це його ліміт 1 запит/с |
| `GEOCODER_BULK_ENABLED` | вмикати **тільки** для self-hosted Nominatim: політика OSM забороняє систематичні масові запити незалежно від темпу |
| `WEATHER_PROVIDER=` | погода вимкнена: віджети погоди і накладення зовнішньої температури ховаються, таймзони точок задаються вручну |
| `WEATHER_RETENTION_DAYS` | глибина `weather_observations`; чистить таймер `modesp-retention-cleanup.timer` (розділ «Таймери systemd») |
| `OSRM_URL=` | планувальник обʼїзду лишається робочим: порядок рахується по прямій, deep-link Google Maps працює завжди |
| `ORS_API_KEY=` | ізохрони стають наближеними кільцями і **видимо позначаються** такими в UI. Гейт стоїть саме на ключі, не на `ORS_URL` |

Створити адміністратора:

```bash
cd /opt/modesp-cloud/backend
node src/db/seed-admin.js --email admin@example.com --password '<мінімум 15 символів>' --role superadmin
```

### 5. systemd юніт для Node.js

```bash
# Скопіювати всі юніти з репо (бекенд + 4 таймери з їхніми сервісами)
cp infra/systemd/modesp-*.service /etc/systemd/system/
cp infra/systemd/modesp-*.timer   /etc/systemd/system/

# Директорія архівів і конфіг бекапу (секрети — лише root)
mkdir -p /var/backups/modesp && chmod 750 /var/backups/modesp && chgrp modesp /var/backups/modesp
cp infra/backup.env.example infra/backup.env && chmod 600 infra/backup.env
#   → відредагувати infra/backup.env: BACKUP_PASSPHRASE, BACKUP_REMOTE

systemctl daemon-reload

# Бекенд — автозапуск
systemctl enable modesp-backend
systemctl start modesp-backend

# Таймери: бекап, партиції (+6 місяців), ретенція (погодинний архів, партиції, рядки)
for t in modesp-backup modesp-telemetry-partition modesp-retention-cleanup; do
  systemctl enable --now "$t.timer"
done

# Партиції на пів року вперед одразу (таймер спрацює лише 25-го)
sudo -u modesp node /opt/modesp-cloud/backend/src/scripts/ensure-partitions.js

# Перший бекап вручну і перевірка маркера
systemctl start modesp-backup.service && cat /var/backups/modesp/last-success
systemctl list-timers 'modesp-*'
```

Усі таймери, крім бекапу, працюють від користувача `modesp` з обліковими даними `DB_USER` із
`backend/.env`: функції `create_telemetry_partition()` і `drop_telemetry_partition()` з міграції 023
виконуються з правами власника схеми (`SECURITY DEFINER`), тому доступ `postgres` їм не потрібен.
Бекап працює від root (читає `/etc/letsencrypt`, `/etc/mosquitto`, `backend/.env`), а `pg_dump`
запускає від ОС-користувача `postgres` через `runuser` — пароль БД ніде не зберігається.

Зміст `/etc/systemd/system/modesp-backend.service`:

```ini
[Unit]
Description=ModESP Cloud Backend
Documentation=https://github.com/Zapadenec1982/ModESP_Cloud
After=network.target postgresql.service mosquitto.service
# Wants, not Requires: a broker or database restart (package upgrade, certbot
# hook) must not stop the backend — its MQTT client and pg pool reconnect on
# their own, and with Requires= systemd would stop the backend and never start
# it again.
Wants=postgresql.service mosquitto.service
OnFailure=modesp-alert@%n.service

[Service]
Type=simple
User=modesp
Group=modesp
WorkingDirectory=/opt/modesp-cloud/backend
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5s

# Environment
EnvironmentFile=/opt/modesp-cloud/backend/.env

# Limits
LimitNOFILE=65536
MemoryHigh=384M
MemoryMax=512M

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/modesp-cloud/backend
PrivateTmp=true

# Logging (journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=modesp-backend

[Install]
WantedBy=multi-user.target
```

### 6. Nginx (HTTPS)

```bash
apt install -y nginx
```

Скопіювати конфіг з репо та налаштувати:

```bash
# Скопіювати конфіг
cp /opt/modesp-cloud/infra/nginx/modesp.conf /etc/nginx/sites-available/modesp

# Увімкнути сайт, прибрати default
ln -s /etc/nginx/sites-available/modesp /etc/nginx/sites-enabled/modesp
rm -f /etc/nginx/sites-enabled/default

# Додати rate limit zone в nginx.conf (http block)
# Якщо ще немає:
grep -q "limit_req_zone" /etc/nginx/nginx.conf || \
  sed -i '/http {/a \    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' /etc/nginx/nginx.conf

# Створити symlink для WebUI статики
mkdir -p /var/www/modesp
ln -s /opt/modesp-cloud/webui/dist /var/www/modesp/webui

# Перевірити і запустити
nginx -t && systemctl reload nginx
```

Повний конфіг: `infra/nginx/modesp.conf` (HTTP→HTTPS redirect, TLS, API proxy, WebSocket, rate limiting).

**Важливо:** Nginx використовує той самий Let's Encrypt сертифікат, що й Mosquitto. Шляхи до сертифікатів — напряму з `/etc/letsencrypt/live/YOUR_DOMAIN/`.

---

## Оновлення (deploy update)

Стандартна процедура після `git push` з локальної машини:

```bash
cd /opt/modesp-cloud

# 1. Підтягнути код
git pull origin main

# 2. Застосувати нові міграції (якщо є). Раннер веде таблицю schema_migrations
#    і пропускає вже застосовані файли; DDL має виконувати власник схеми,
#    тому підключаємось як postgres через сокет (явні DB_* мають пріоритет над .env).
sudo -u postgres env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME=modesp_cloud DB_USER=postgres DB_PASS= \
  node backend/src/scripts/migrate.js --dry-run     # що буде застосовано
sudo -u postgres env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME=modesp_cloud DB_USER=postgres DB_PASS= \
  node backend/src/scripts/migrate.js
#    Перший запуск на БД, яку мігрували вручну: спочатку `--baseline`, щоб записати
#    вже застосовані файли без виконання, і лише потім звичайний запуск.
#    Якщо міграція створює нові таблиці — перевірити GRANT-и для modesp_cloud (як у 021).

# 3. Оновити залежності бекенду (якщо змінився package.json)
cd backend
npm install --production

# 4. Перезібрати WebUI (якщо змінився webui/)
cd ../webui
npm install
npm run build

# 5. Перезапустити бекенд
sudo systemctl restart modesp-backend

# 6. Перевірити
sudo systemctl status modesp-backend
curl -s http://localhost:3000/api/health | jq .
```

---

## Таймери systemd

Cron не використовується. Усі періодичні задачі — таймери systemd з `Persistent=true`
(пропущений запуск виконується після рестарту сервера), логи в journald.

| Таймер | Розклад | Сервіс виконує | Від кого |
|---|---|---|---|
| `modesp-backup.timer` | щодня 02:00 | `infra/scripts/backup-postgres.sh` — архів `modesp_backup_<UTC>.tar[.gpg]` у `/var/backups/modesp`, off-site копія, маркер `last-success` | root (`pg_dump` через `runuser -u postgres`) |
| `modesp-telemetry-partition.timer` | 25-го, 03:00 | `src/scripts/ensure-partitions.js` — партиції телеметрії на `PARTITION_MONTHS_AHEAD` (6) місяців уперед | modesp |
| `modesp-retention-cleanup.timer` | щодня 03:30 | `scripts/cleanup-telemetry.js --apply` (згортає сирі вимірювання за останні `DOWNSAMPLE_LOOKBACK_DAYS` (3) у `telemetry_hourly`, видаляє сирі рядки старші за `plan_limits.retention_days` організації, скидає партиції старші за найдовшу ретенцію планів, чистить архів старший за `HOURLY_RETENTION_DAYS` (1095)), потім `cleanup-weather.js --apply` і `cleanup-aux.js --apply` — `weather_observations`, `events`, `notification_log`, неактивні `alarms`, протерміновані `refresh_tokens` | modesp |

Ретенція сирої телеметрії береться з плану організації (`plan_limits.retention_days`);
`TELEMETRY_RETENTION_DAYS` — лише запасне значення для організацій без плану. Інші значення
задаються в `backend/.env` (блок «Data retention» у `.env.example`); `0` вимикає окремий sweep.
`audit_log` і `report_exports` незмінні й не чистяться. `drop_telemetry_partition()` відмовляється
видаляти партицію, що закрилася менш ніж 7 днів тому, незалежно від налаштувань.

Після першого розгортання епіка 1.9 архів треба наповнити історією один раз:
`sudo -u modesp node backend/scripts/cleanup-telemetry.js --apply --backfill-days 400`.

```bash
# Стан і наступні запуски
systemctl list-timers 'modesp-*'

# Запустити задачу зараз і подивитися лог
systemctl start modesp-retention-cleanup.service
journalctl -u modesp-retention-cleanup -n 50 --no-pager

# Dry-run будь-якого скрипта (без --apply нічого не видаляє)
sudo -u modesp node /opt/modesp-cloud/backend/scripts/cleanup-telemetry.js
sudo -u modesp node /opt/modesp-cloud/backend/scripts/cleanup-aux.js
```

---

## Моніторинг

Три шари: зовнішній проб (дізнатися про збій раніше за клієнта), алерти про збої юнітів у
Telegram (від самого сервера) і розширений `/api/health` для діагностики.

### 1. Зовнішній проб (UptimeRobot / Better Stack, безкоштовний рівень)

| Монітор | Налаштування | Що ловить |
|---|---|---|
| HTTPS keyword | `https://modesp.com.ua/api/health`, інтервал 1 хв, alert якщо **немає** `"status":"ok"` | nginx, бекенд, БД, з'єднання бекенду з брокером (відповідь 503 при `degraded`) |
| HTTPS keyword | той самий URL, alert якщо **немає** `"platform":"ok"` | бекап старший за 48 год, партиції телеметрії закінчуються, диск < 10 % |
| Port | `modesp.com.ua:8883` TCP | брокер недоступний для контролерів |
| SSL expiry | у налаштуваннях HTTPS-монітора, попередження за 14 днів | зламане автопродовження Let's Encrypt |

Сповіщення пробу — в окремий Telegram-чат «platform-alerts» (інтеграція Telegram є в обох сервісах)
і на email. Публічну статус-сторінку монітора можна показати в футері WebUI:
`VITE_STATUS_PAGE_URL` у `webui/.env` (потрібен `npm run build`).

### 2. Алерти про збої юнітів (`modesp-alert@.service`)

Кожен юніт ModESP має `OnFailure=modesp-alert@%n.service`: бекенд (crash loop), бекап, партиції,
обидва очищення. Юніт викликає `infra/scripts/alert-telegram.sh`, який надсилає назву юніта, хост і
останні 15 рядків його журналу в Telegram-групу.

```bash
# backend/.env: бот той самий, що й для аварій; додайте його в групу platform-alerts
PLATFORM_ALERT_CHAT_ID=-1001234567890

# Перевірка каналу (текст надсилається як є)
systemctl start 'modesp-alert@smoke-test.service'
journalctl -u 'modesp-alert@smoke-test' -n 5 --no-pager

# Імітація збою: зупинити брокер → бекенд лишається працювати (Wants=), /api/health → 503 → проб
systemctl stop mosquitto && sleep 90 && curl -s localhost:3000/api/health; systemctl start mosquitto
```

Без `PLATFORM_ALERT_CHAT_ID` скрипт пише попередження в журнал і виходить з кодом 0 — збій
основного юніта не маскується.

### 3. Healthcheck

```
GET /api/health            # публічний, для пробу
GET /api/health/details    # лише superadmin (JWT), цифри
```

```json
{
  "status": "ok",            "db": "ok",  "mqtt": "ok",  "uptime": 86400,
  "platform": "ok",
  "checks": { "backup": "ok", "partitions": "ok", "disk": "ok" }
}
```

| Поле | `ok` | інакше |
|---|---|---|
| `status` | БД відповідає і бекенд під'єднаний до брокера | `degraded`, HTTP 503 |
| `checks.backup` | маркер `/var/backups/modesp/last-success` молодший за `BACKUP_MAX_AGE_HOURS` (48) | `stale`; `unknown` — маркера ще нема |
| `checks.partitions` | є партиція телеметрії щонайменше на наступний місяць | `low` |
| `checks.disk` | на файловій системі сховища прошивок вільно ≥ `DISK_MIN_FREE_PCT` (10 %) | `low` |
| `platform` | жодна перевірка не `stale`/`low` | `attention` (HTTP лишається 200) |

`/api/health/details` додає версію, пам'ять, `mqtt.broker.clients_connected`
(`$SYS/broker/clients/connected`), вік і розмір останнього архіву, кількість партицій і місяців
запасу, вільне місце, статистику доставки по каналах (`sent`/`failed`/`last_error`) і стан
Telegram-бота (`getMe`, останній polling error).

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}' | jq -r .data.accessToken)
curl -s localhost:3000/api/health/details -H "Authorization: Bearer $TOKEN" | jq .data
```

### 4. Журнали і сервіси

```bash
systemctl status modesp-backend mosquitto nginx postgresql
journalctl -u modesp-backend -f                 # live
journalctl -u modesp-backend --no-pager -n 100
journalctl -u modesp-backup -u modesp-telemetry-partition -u modesp-retention-cleanup --since -7d
tail -f /var/log/mosquitto/mosquitto.log
sudo -u postgres psql -d modesp_cloud -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'modesp_cloud';"
systemctl list-timers 'modesp-*'
```

Журнал обмежений drop-in-ом `infra/journald/modesp.conf` (`SystemMaxUse=500M`,
`MaxRetentionSec=30day`; ставить `setup.sh`). Пакетні повідомлення бекенду («Telemetry sampled»,
«Batch state write», «StateMap sweep», «Backfill ingested») пишуться на рівні `debug`, тож у
продакшні (`info`) журнал містить лише події і помилки.

---

## Backup

Щоденний архів робить `modesp-backup.timer` (02:00) скриптом `infra/scripts/backup-postgres.sh`.
Один файл `modesp_backup_<UTC-мітка>.tar` (або `.tar.gpg`) містить:

| Член архіву | Вміст |
|---|---|
| `manifest.txt` | хост, коміт, розмір БД, версія `pg_dump`, перелік файлів, sha256 кожного члена |
| `globals.sql` | `pg_dumpall --globals-only`: ролі `modesp_cloud`, `modesp_mqtt_ro` з паролями |
| `db.dump` | `pg_dump --format=custom --no-owner` бази `modesp_cloud` (стиснений, для `pg_restore`) |
| `files.tar.gz` | `backend/.env`, `webui/.env`, сховище прошивок, ключ FCM, `/etc/mosquitto`, `/etc/letsencrypt`, конфіг nginx, юніти systemd, `infra/backup.env` |

Налаштування — `infra/backup.env` (шаблон `infra/backup.env.example`, лише root, `chmod 600`):

| Змінна | Призначення | Дефолт |
|---|---|---|
| `BACKUP_PASSPHRASE` | симетричне шифрування архіву GPG AES-256; **зберігати поза сервером** | вимкнено |
| `BACKUP_REMOTE` | rsync-over-ssh призначення off-site копії (наприклад, Hetzner Storage Box) | вимкнено |
| `BACKUP_SSH_OPTS` | `-o` опції ssh/sftp: порт, ключ | — |
| `BACKUP_RETENTION_DAYS` / `BACKUP_REMOTE_RETENTION_DAYS` | скільки днів зберігати локально / off-site | 14 / 30 |
| `BACKUP_DB_HOST/USER/PASSWORD` | лише для БД на іншому хості; за замовчуванням `runuser -u postgres` через сокет | — |

```bash
# Перший запуск і перевірка
systemctl start modesp-backup.service
journalctl -u modesp-backup -n 20 --no-pager
cat /var/backups/modesp/last-success        # timestamp, archive, archive_bytes, db_size_bytes, offsite

# Переконатися, що архів читається (без відновлення)
tar -xOf /var/backups/modesp/modesp_backup_*.tar manifest.txt | head
tar -xOf /var/backups/modesp/modesp_backup_*.tar db.dump | pg_restore --list | head

# Off-site: перед першим запуском прийняти host key від root
rsync -e "ssh -o Port=23" /var/backups/modesp/last-success u123456@u123456.your-storagebox.de:modesp/
```

Відновлення на чистому сервері, разом із заміряними RTO/RPO і датою останньої репетиції —
`docs/runbooks/restore.md`. Ціль: RPO ≤ 24 год (добовий архів), RTO ≤ 4 год.

---

## Changelog

- 2026-03-07 — Створено. Повний гайд розгортання: PostgreSQL, Mosquitto, Node.js, Nginx, systemd, backup.
- 2026-03-08 — Оновлено. Виправлені шляхи і команди за результатами реального розгортання: systemd юніт `modesp-backend` (не modesp-cloud), міграція `006_device_rbac.sql` (не user_devices), скрипти в `backend/scripts/` (не src/db), PostgreSQL auth через `sudo -u postgres`, додано секцію "Оновлення", cron задачі, структуру файлів на сервері.
- 2026-03-09 — Phase 4 (MQTT Auth): mosquitto-go-auth setup (build, PG read-only user, config), міграція 008, provision-mqtt-creds.js script, MQTT_BOOTSTRAP_PASSWORD/MQTT_PUBLIC_HOST env vars.
- 2026-03-09 — TLS: Let's Encrypt cert setup, auto-renewal hook, cert path fixes (fullchain.pem, no cafile), superquery/aclquery SQL fixes from production deploy.
- 2026-03-09 — HTTPS: Nginx section rewritten with real production setup (symlink, rate limit zone, WebUI dist symlink), renewal hook includes nginx reload.
- 2026-09-02 — HACCP і погодинний архів: міграція 028 (`report_exports`, `telemetry_hourly`); `cleanup-telemetry.js` тепер щодня в `modesp-retention-cleanup` (згортання в архів, ретенція сирих даних за планом, партиції, архів на 3 роки), окремий `modesp-telemetry-cleanup.timer` вилучено — після оновлення виконати `systemctl disable --now modesp-telemetry-cleanup.timer` і разовий `--backfill-days`; наявні організації отримують `tenant_settings.raw_retention_days = 400` (grandfathering, скидається явною зміною плану); `EMAIL_APP_URL` потрапляє в URL перевірки звіту.
- 2026-09-02 — Плани і стан організації: міграція 027 (`plan_limits`, `tenants.status` з тригером-дзеркалом `active`, `tenant_settings`); `infra/mosquitto/mosquitto.conf` — ACL не видає топіків активним пристроям призупинених організацій (перевстановити конфіг брокера через `backend/scripts/deploy-mqtt-auth.sh`); міграції 024–026 (запрошення, коди контролерів, налаштування сповіщень і підтвердження аварій).
- 2026-09-02 — Моніторинг і рестарти: розділ «Моніторинг» переписано (зовнішній проб з двома keyword-моніторами, `modesp-alert@.service` + `alert-telegram.sh`, `/api/health` з `platform`/`checks` і `/api/health/details` для superadmin, journald drop-in); `modesp-backend.service` — `Wants=` замість `Requires=`, `OnFailure=`; хук certbot винесено в `infra/scripts/tls-deploy-hook.sh` з перевіркою сертифіката після reload; бекенд при зупинці скидає стан пристроїв у БД, а при старті знову зводить таймери дверних/pulldown-аварій.
- 2026-09-02 — Бекапи і ретенція: `backup-postgres.sh` збирає один архів (дамп + ролі + конфіги + прошивки) з маніфестом і маркером `last-success`, `infra/backup.env`; три таймери systemd замість cron (`modesp-backup`, `modesp-telemetry-partition` на +6 місяців, `modesp-retention-cleanup`); міграція 023 (`SECURITY DEFINER` функції партицій, таймери працюють від `modesp`); `cleanup-aux.js`; оновлення через `migrate.js`; `setup.sh` ставить усі юніти, `ratelimit.conf` і домен `modesp.com.ua`; runbook `docs/runbooks/restore.md`.
- 2026-08-23 — Phase 14 (гео): розділ «Ліцензування третіх сторін» перед кроками розгортання (посилання на docs/THIRD_PARTY_LICENSING.md); міграція 021 з окремим блоком GRANT-ів під `DB_USER` і перевірками після застосування; блок env-змінних гео-сервісів (Nominatim / Open-Meteo / OSRM / OpenRouteService) з таблицею наслідків; `webui/.env` для тайлів карти і попередження про потрійну синхронізацію CSP; cron-задача `cleanup-weather.js`.
