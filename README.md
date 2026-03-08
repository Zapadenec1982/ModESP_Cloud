# ModESP Cloud

**Мультитенантна IoT платформа для централізованого управління парком промислових ESP32 холодильних контролерів**

---

## Що це таке

ModESP Cloud перетворює розрізнені ESP32 контролери (ModESP_v4) в єдину керовану систему з хмарним моніторингом, push-сповіщеннями, OTA оновленнями і аналітикою.

**Зв'язаний проект:** [`ModESP_v4`](https://github.com/Zapadenec1982/ModESP_v4) — прошивка ESP32 контролерів (production)

### Ключові можливості

- **Real-time моніторинг** — 48 параметрів кожного контролера через WebSocket
- **Push-сповіщення** — FCM + Telegram Bot при аваріях
- **Телеметрія** — збереження і аналітика температурних даних з графіками
- **Fleet OTA** — масове оновлення прошивок з batching і auto-pause on failure
- **Мультитенантність** — повна ізоляція даних між організаціями
- **Per-device RBAC** — admin / technician / viewer з доступом до конкретних пристроїв
- **Auto-discovery** — автоматичне виявлення нових ESP32 в мережі
- **i18n** — українська та англійська мови інтерфейсу
- **Dark/Light theme** — перемикання теми оформлення

---

## Архітектура

```
ESP32 (ModESP_v4)
    │ MQTT over TLS (порт 8883)
    ▼
Mosquitto Broker ──── ACL per-tenant/device
    │
    ▼
Node.js Backend (порт 3000)
├── MqttService      → підписка на топіки, агрегація стану, детекція аварій
├── DbService        → PostgreSQL пул (30 з'єднань)
├── WsService        → WebSocket real-time delta broadcasts
├── ApiService       → Express REST API (30+ endpoints)
├── PushService      → FCM + Telegram Bot
├── OtaService       → Fleet firmware deployment
└── AuthService      → JWT access/refresh токени
    │
    ├── PostgreSQL 16 (партиціонована телеметрія)
    └── Svelte WebUI (статика через Nginx)

Nginx → HTTPS (Let's Encrypt), reverse proxy, SPA
```

---

## Стек технологій

| Компонент | Технологія | Версія |
|-----------|-----------|--------|
| Runtime | Node.js | 22 |
| API Framework | Express.js | 4.21 |
| База даних | PostgreSQL | 16 |
| MQTT Broker | Mosquitto | 2.x |
| WebSocket | ws | 8.18 |
| WebUI | Svelte | 4.2 |
| Bundler | Vite | 5.4 |
| Графіки | uPlot | 1.6 |
| Push (mobile) | Firebase Admin SDK | 13.7 |
| Push (messenger) | Telegram Bot API | 0.67 |
| Auth | JWT (jsonwebtoken) | 9.0 |
| Валідація | Zod | 3.24 |
| Логування | Pino | 9.6 |
| Reverse Proxy | Nginx | — |
| ОС | Ubuntu | 24.04 LTS |

---

## Структура проекту

```
ModESP_Cloud/
├── backend/
│   ├── src/
│   │   ├── index.js              # Точка входу, ініціалізація сервісів
│   │   ├── config/
│   │   │   └── state_meta.json   # 48 state keys з прошивки ModESP_v4
│   │   ├── services/             # Бізнес-логіка
│   │   │   ├── db.js             # PostgreSQL connection pool
│   │   │   ├── mqtt.js           # MQTT client, state aggregation, alarm detection
│   │   │   ├── ws.js             # WebSocket server
│   │   │   ├── push.js           # Notification orchestrator
│   │   │   ├── telegram.js       # Telegram Bot
│   │   │   ├── fcm.js            # Firebase Cloud Messaging
│   │   │   ├── ota.js            # OTA deployment scheduler
│   │   │   └── auth.js           # JWT token lifecycle
│   │   ├── routes/               # REST API endpoints
│   │   │   ├── auth.js           # login, refresh, logout
│   │   │   ├── devices.js        # CRUD, commands, service records
│   │   │   ├── telemetry.js      # Time-series queries + stats
│   │   │   ├── alarms.js         # Fault log + frequency analysis
│   │   │   ├── users.js          # User management + device assignment
│   │   │   ├── firmware.js       # Upload/list/delete firmware
│   │   │   ├── ota.js            # Deploy/rollout/jobs
│   │   │   ├── fleet.js          # Fleet summary
│   │   │   └── notifications.js  # Push subscribers
│   │   ├── middleware/
│   │   │   ├── auth.js           # JWT verification, tenant extraction
│   │   │   ├── device-access.js  # Per-device RBAC
│   │   │   └── validate.js       # Zod schema validation
│   │   └── db/
│   │       ├── schema.sql        # Повна схема БД
│   │       ├── seed-admin.js     # Створення першого адміна
│   │       └── migrations/       # 002–007 (інкрементальні)
│   ├── scripts/
│   │   ├── grant-all-devices.js  # Backward-compat RBAC міграція
│   │   └── cleanup-telemetry.js  # Retention: партиції >90 днів
│   ├── package.json
│   └── .env.example
│
├── webui/
│   ├── src/
│   │   ├── App.svelte            # Routing + admin route guards
│   │   ├── pages/                # 8 сторінок (Dashboard, DeviceDetail, ...)
│   │   ├── components/           # 20+ UI компонентів
│   │   └── lib/                  # API client, stores, i18n, WebSocket, theme
│   ├── dist/                     # Production build (Nginx serve)
│   └── package.json
│
├── infra/
│   ├── systemd/                  # modesp-backend.service, telemetry partition timer
│   ├── nginx/                    # HTTPS, reverse proxy, SPA fallback
│   └── mosquitto/                # ACL, TLS, persistence
│
├── docs/
│   ├── ARCHITECTURE.md           # Компоненти, потоки даних, безпека
│   ├── MQTT_PROTOCOL.md          # v1 протокол, топіки, формати
│   ├── DATABASE.md               # Схема, партиціонування, індекси
│   ├── API_REFERENCE.md          # 30+ REST endpoints з прикладами
│   ├── DEPLOYMENT.md             # VPS setup, міграції, cron
│   └── ROADMAP.md                # Фази розробки
│
└── CLAUDE.md                     # Повна інструкція проекту
```

---

## MQTT Протокол (v1)

ESP32 публікує 48 окремих state keys як скалярні значення (не JSON bundles — обмеження 80KB RAM).
Cloud агрегує ключі в пам'яті, семплює телеметрію server-side (5 хв), детектує аварії.

```
modesp/v1/{tenant}/{device}/state/{key}     → "-2.50", "true" (scalar, QoS 0)
modesp/v1/{tenant}/{device}/status          → "online"/"offline" (LWT)
modesp/v1/{tenant}/{device}/heartbeat       → JSON metadata (30s)
modesp/v1/{tenant}/{device}/cmd/{key}       ← scalar command (QoS 1)
modesp/v1/pending/{device}/...              ← auto-discovery
```

---

## REST API

30+ endpoints з JWT авторизацією та per-device RBAC.

| Група | Endpoints | Опис |
|-------|-----------|------|
| Auth | `POST /auth/login, /refresh, /logout` | JWT access + refresh tokens |
| Devices | `GET/PATCH /devices/:id`, `POST .../command` | CRUD, команди, сервісні записи |
| Telemetry | `GET /devices/:id/telemetry[/stats]` | Raw data + bucketed aggregation |
| Alarms | `GET /alarms`, `/alarms/stats` | Fault log + frequency analysis |
| Fleet | `GET /fleet/summary` | Total, online, alarms |
| Users | `GET/POST/PUT/DELETE /users` | CRUD + device assignment (admin) |
| Firmware | `POST /firmware/upload`, `GET /firmware` | Upload/list/delete firmware |
| OTA | `POST /ota/deploy`, `/ota/rollout` | Single + group deployment |
| Discovery | `GET /devices/pending`, `POST .../assign` | Auto-discovery onboarding |
| Notifications | `GET/POST/DELETE /notifications/subscribers` | FCM + Telegram підписки |

Детальна документація: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)

---

## WebUI

8 сторінок Svelte SPA з real-time WebSocket оновленнями:

| Сторінка | Опис |
|----------|------|
| **Dashboard** | Зведення по парку, список пристроїв з пошуком, online/offline статус |
| **DeviceDetail** | Live стан (48 параметрів), команди, графіки телеметрії, історія аварій, сервісні записи |
| **Alarms** | Fleet-wide журнал аварій з severity badges |
| **Firmware** | Бібліотека прошивок, deploy на окремий пристрій або групу, board compatibility |
| **Users** | Управління користувачами, призначення пристроїв (admin) |
| **Notifications** | Налаштування FCM / Telegram підписок |
| **PendingDevices** | Onboarding нових пристроїв (auto-discovery) |
| **Login** | JWT авторизація |

**Особливості:** i18n (UK + EN), light/dark theme, read-only режим для viewer, admin route guards.

---

## Безпека

| Шар | Механізм |
|-----|----------|
| ESP32 → Mosquitto | MQTT over TLS (порт 8883), credentials per device |
| Browser → Nginx | HTTPS (Let's Encrypt), HSTS |
| WebUI → API | JWT Bearer token (15 хв access + 30 днів refresh з ротацією) |
| API → DB | Prepared statements (параметризовані запити) |
| Multi-tenancy | `tenant_id` в кожному SQL запиті + PostgreSQL RLS |
| Per-device RBAC | `user_devices` таблиця, middleware на всіх device endpoints |
| Passwords | bcrypt (12 rounds) |
| Secrets | `.env` файл, не в git |

---

## Швидкий старт (розробка)

```bash
# 1. Клонувати
git clone https://github.com/Zapadenec1982/ModESP_Cloud.git
cd ModESP_Cloud

# 2. Backend
cd backend
cp .env.example .env    # налаштувати DB, MQTT, JWT_SECRET
npm install
node src/db/seed-admin.js   # створити адміна
node src/index.js            # запустити на :3000

# 3. WebUI
cd ../webui
npm install
npm run dev              # Vite dev server на :5173
```

**Вимоги:** Node.js 22, PostgreSQL 16, Mosquitto (або AUTH_ENABLED=false для розробки без MQTT).

---

## Розгортання (Production VPS)

Детально: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

```bash
# На VPS (Ubuntu 24.04)
cd /opt/modesp-cloud
git pull origin main

# Міграції
sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/006_device_rbac.sql
sudo -u postgres psql -d modesp_cloud \
  -f backend/src/db/migrations/007_firmware_board_type.sql

# RBAC backward-compat
cd backend && node scripts/grant-all-devices.js --apply

# Збірка WebUI
cd ../webui && npm install && npm run build

# Рестарт
sudo systemctl restart modesp-backend
```

**Мінімальні вимоги VPS:** 1 vCPU, 2 GB RAM, 20 GB SSD.

---

## Статус проекту

**Фаза 7 (RBAC + Scalability) — повністю завершена ✅**

| Фаза | Назва | Статус |
|------|-------|--------|
| 1 | Cloud Foundation (MQTT, DB, State Aggregation) | ✅ |
| 2 | REST API, WebSocket, Svelte WebUI | ✅ |
| 3 | Push Notifications (FCM + Telegram) | ✅ |
| 4 | Auth & User Management (JWT, RBAC) | ✅ |
| 5 | History & Analytics (Telemetry, Alarm Stats) | ✅ |
| 6 | Fleet OTA (Upload, Deploy, Rollout) | ✅ |
| 6.5 | WebUI Polish (i18n, Theme, Metadata) | ✅ |
| 7a | Per-Device RBAC (Backend) | ✅ |
| 7b | Backend Scalability (Batch Writes, Retention) | ✅ |
| 7c | Frontend RBAC (Conditional UI, Route Guards) | ✅ |
| 7d | OTA Board Compatibility | ✅ |
| — | VPS Deployment | ✅ Production |

**Наступні фази** (Phase 8+): ML predictive maintenance, anomaly detection, PDF reports, ERP integration.

Повний roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)

---

## Документація

| Документ | Опис |
|----------|------|
| [`CLAUDE.md`](CLAUDE.md) | Повна інструкція проекту (архітектура, правила, структура) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Компоненти системи, потоки даних, безпека |
| [`docs/MQTT_PROTOCOL.md`](docs/MQTT_PROTOCOL.md) | MQTT v1 протокол, топіки, формати повідомлень |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Схема БД, партиціонування, індекси |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | 30+ REST endpoints з прикладами |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Розгортання на VPS, міграції, cron |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Фази розробки, прогрес |

---

## Changelog

- 2026-03-07 — Створено репозиторій. Базова структура і документація.
- 2026-03-07 — Phase 1–2: Backend (MQTT, DB, API, WebSocket), Svelte WebUI.
- 2026-03-07 — Phase 3–5: Push notifications, Auth, History & Analytics.
- 2026-03-08 — Phase 6–6.5: Fleet OTA (E2E verified), i18n, dark/light theme, device metadata.
- 2026-03-08 — Phase 7a–7d: Per-device RBAC, backend scalability, frontend RBAC, OTA board compatibility.
- 2026-03-08 — Deployment docs оновлено за результатами реального VPS розгортання.
