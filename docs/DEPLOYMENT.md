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
│   │   │       └── 008_mqtt_auth.sql
│   │   └── ...
│   ├── scripts/
│   │   ├── grant-all-devices.js     # backward compat RBAC migration
│   │   ├── cleanup-telemetry.js     # retention: видаляє партиції >90 днів
│   │   └── provision-mqtt-creds.js  # генерує MQTT credentials для існуючих пристроїв
│   ├── .env                         # конфігурація (не в git!)
│   └── package.json
├── webui/
│   ├── dist/                        # збілджений SPA (Nginx serve)
│   └── package.json
└── infra/
    ├── systemd/
    │   ├── modesp-backend.service
    │   ├── modesp-telemetry-partition.service
    │   └── modesp-telemetry-partition.timer
    ├── nginx/
    └── mosquitto/
```

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

```bash
cat > /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh << 'EOF'
#!/bin/bash
# Mosquitto TLS certs
cp /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem /etc/mosquitto/certs/server.crt
cp /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem /etc/mosquitto/certs/server.key
chown mosquitto:mosquitto /etc/mosquitto/certs/*
systemctl restart mosquitto
# Nginx picks up new certs automatically, just reload
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
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
npm install
npm run build
```

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

# MQTT
MQTT_HOST=localhost
MQTT_PORT=1883
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

# Firebase FCM (опціонально)
FCM_SERVER_KEY=your_fcm_server_key

# Telegram (опціонально)
TELEGRAM_BOT_TOKEN=your_bot_token
```

Створити адміністратора:

```bash
cd /opt/modesp-cloud/backend
node src/db/seed-admin.js
```

### 5. systemd юніт для Node.js

```bash
# Скопіювати юніт файли з репо
cp infra/systemd/modesp-backend.service /etc/systemd/system/
cp infra/systemd/modesp-telemetry-partition.service /etc/systemd/system/
cp infra/systemd/modesp-telemetry-partition.timer /etc/systemd/system/

systemctl daemon-reload

# Бекенд — автозапуск
systemctl enable modesp-backend
systemctl start modesp-backend

# Таймер партицій телеметрії — створює партицію на 2 місяці вперед, 25-го числа
systemctl enable modesp-telemetry-partition.timer
systemctl start modesp-telemetry-partition.timer
```

Зміст `/etc/systemd/system/modesp-backend.service`:

```ini
[Unit]
Description=ModESP Cloud Backend
Documentation=https://github.com/Zapadenec1982/ModESP_Cloud
After=network.target postgresql.service mosquitto.service
Requires=postgresql.service mosquitto.service

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
MemoryMax=256M

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

# 2. Застосувати нові міграції (якщо є)
#    Перевірити які міграції вже застосовані і запустити нові
sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/NNN_new_migration.sql

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

## Cron задачі

```bash
# Редагувати crontab для користувача modesp
sudo crontab -u modesp -e
```

```cron
# Очистка старих партицій телеметрії (>90 днів), щодня о 3:00
0 3 * * * cd /opt/modesp-cloud/backend && /usr/bin/node scripts/cleanup-telemetry.js >> /var/log/modesp-cleanup.log 2>&1
```

**Примітка:** партиції на наступні місяці створюються автоматично через systemd timer `modesp-telemetry-partition.timer` (25-го числа кожного місяця о 3:00).

---

## Моніторинг

```bash
# Перевірка статусу всіх сервісів
systemctl status modesp-backend mosquitto nginx postgresql

# Логи бекенду (live)
journalctl -u modesp-backend -f

# Логи бекенду (останні 100 рядків)
journalctl -u modesp-backend --no-pager -n 100

# Логи Mosquitto
tail -f /var/log/mosquitto/mosquitto.log

# Кількість з'єднань PostgreSQL
sudo -u postgres psql -d modesp_cloud \
  -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'modesp_cloud';"

# Статус таймерів
systemctl list-timers modesp-*
```

### Healthcheck endpoint

```
GET /api/health
```
```json
{
  "status": "ok",
  "db": "ok",
  "mqtt": "ok",
  "uptime": 86400
}
```

---

## Backup

```bash
# Щоденний backup PostgreSQL (cron для root)
sudo crontab -e
```

```cron
# Backup БД щодня о 2:00, зберігати 30 днів
0 2 * * * pg_dump -U postgres modesp_cloud | gzip > /backup/modesp_$(date +\%Y\%m\%d).sql.gz
30 2 * * * find /backup -name "modesp_*.sql.gz" -mtime +30 -delete
```

```bash
# Створити директорію для бекапів
mkdir -p /backup
```

---

## Changelog

- 2026-03-07 — Створено. Повний гайд розгортання: PostgreSQL, Mosquitto, Node.js, Nginx, systemd, backup.
- 2026-03-08 — Оновлено. Виправлені шляхи і команди за результатами реального розгортання: systemd юніт `modesp-backend` (не modesp-cloud), міграція `006_device_rbac.sql` (не user_devices), скрипти в `backend/scripts/` (не src/db), PostgreSQL auth через `sudo -u postgres`, додано секцію "Оновлення", cron задачі, структуру файлів на сервері.
- 2026-03-09 — Phase 4 (MQTT Auth): mosquitto-go-auth setup (build, PG read-only user, config), міграція 008, provision-mqtt-creds.js script, MQTT_BOOTSTRAP_PASSWORD/MQTT_PUBLIC_HOST env vars.
- 2026-03-09 — TLS: Let's Encrypt cert setup, auto-renewal hook, cert path fixes (fullchain.pem, no cafile), superquery/aclquery SQL fixes from production deploy.
- 2026-03-09 — HTTPS: Nginx section rewritten with real production setup (symlink, rate limit zone, WebUI dist symlink), renewal hook includes nginx reload.
