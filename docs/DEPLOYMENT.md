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
psql -U modesp_cloud -d modesp_cloud -f /opt/modesp-cloud/docs/schema.sql
```

### 3. Mosquitto

```bash
apt install -y mosquitto mosquitto-clients

# Конфіг: /etc/mosquitto/conf.d/modesp.conf
```

```ini
# /etc/mosquitto/conf.d/modesp.conf

# Заборонити анонімний доступ
allow_anonymous false
password_file /etc/mosquitto/passwd

# ACL файл
acl_file /etc/mosquitto/acl

# Plain MQTT тільки localhost (для бекенду)
listener 1883 127.0.0.1

# MQTT over TLS для ESP32
listener 8883
cafile   /etc/letsencrypt/live/cloud.example.com/chain.pem
certfile /etc/letsencrypt/live/cloud.example.com/fullchain.pem
keyfile  /etc/letsencrypt/live/cloud.example.com/privkey.pem

# Persistence для QoS 1
persistence true
persistence_location /var/lib/mosquitto/

# Logging
log_dest file /var/log/mosquitto/mosquitto.log
log_type error warning notice
```

```bash
# Додати бекенд користувача
mosquitto_passwd -c /etc/mosquitto/passwd modesp_backend

systemctl enable mosquitto
systemctl start mosquitto
```

### 4. Node.js

```bash
# Встановити Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Розгорнути бекенд
mkdir -p /opt/modesp-cloud
cd /opt/modesp-cloud
git clone https://github.com/youruser/ModESP_Cloud.git .
cd backend
npm install --production

# .env файл
cp .env.example .env
nano .env
```

```bash
# /opt/modesp-cloud/backend/.env
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

# Firebase FCM
FCM_SERVER_KEY=your_fcm_server_key

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
```

### 5. systemd юніт для Node.js

```ini
# /etc/systemd/system/modesp-cloud.service
[Unit]
Description=ModESP Cloud Backend
After=network.target postgresql.service mosquitto.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/modesp-cloud/backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/modesp-cloud/backend/.env

# Обмеження ресурсів
MemoryLimit=512M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable modesp-cloud
systemctl start modesp-cloud
```

### 6. Nginx

```bash
apt install -y nginx certbot python3-certbot-nginx

# Отримати SSL сертифікат
certbot --nginx -d cloud.example.com
```

```nginx
# /etc/nginx/sites-available/modesp-cloud
server {
    listen 443 ssl;
    server_name cloud.example.com;

    ssl_certificate     /etc/letsencrypt/live/cloud.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cloud.example.com/privkey.pem;

    # Статичний Svelte WebUI
    root /opt/modesp-cloud/webui/dist;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket proxy
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600;
    }
}

server {
    listen 80;
    server_name cloud.example.com;
    return 301 https://$host$request_uri;
}
```

```bash
ln -s /etc/nginx/sites-available/modesp-cloud /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Моніторинг

```bash
# Перевірка статусу сервісів
systemctl status modesp-cloud mosquitto nginx postgresql

# Логи бекенду
journalctl -u modesp-cloud -f

# Логи Mosquitto
tail -f /var/log/mosquitto/mosquitto.log

# Heap і з'єднання PostgreSQL
psql -U modesp_cloud -c "SELECT count(*) FROM pg_stat_activity;"
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
# Щоденний backup PostgreSQL (cron)
0 2 * * * pg_dump -U modesp_cloud modesp_cloud | gzip > /backup/modesp_$(date +%Y%m%d).sql.gz

# Зберігати останні 30 днів
find /backup -name "modesp_*.sql.gz" -mtime +30 -delete
```

---

## Changelog

- 2026-03-07 — Створено. Повний гайд розгортання: PostgreSQL, Mosquitto, Node.js, Nginx, systemd, backup.
