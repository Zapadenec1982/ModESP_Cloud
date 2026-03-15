# ModESP Cloud

**Multi-tenant IoT platform for centralized fleet management of industrial ESP32 refrigeration controllers**

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![Svelte](https://img.shields.io/badge/Svelte-4-FF3E00?logo=svelte)](https://svelte.dev/)
[![License](https://img.shields.io/badge/License-PolyForm%20NC-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-130%2B-brightgreen)](backend/test)

> **Production-deployed** on Hetzner VPS — managing real ESP32 controllers via MQTT over TLS.

---

## What It Does

ModESP Cloud transforms standalone ESP32 refrigeration controllers ([ModESP_v4](https://github.com/Zapadenec1982/ModESP_v4)) into a unified, remotely managed fleet with cloud monitoring, push notifications, OTA firmware updates, and analytics.

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Real-time monitoring** | 48 parameters per controller via WebSocket — temperature, compressor state, alarms |
| **Push notifications** | FCM + Telegram Bot + Web Push — alarm triggers, clearances, device offline alerts |
| **Telemetry & analytics** | Server-side sampled temperature data with time-series charts (uPlot) |
| **Fleet OTA updates** | Batch firmware rollout with board compatibility checks and auto-pause on failure |
| **Multi-tenancy** | Full data isolation between organizations at MQTT, DB, and API layers |
| **Per-device RBAC** | Admin / Technician / Viewer roles with per-device access control (M:N) |
| **Auto-discovery** | Zero-touch ESP32 onboarding — pending → assign → auto-reconnect |
| **Telegram Bot** | User auth, RBAC, bilingual (UA/EN), persistent keyboard, interactive device status |
| **HACCP data export** | CSV + PDF reports for temperature logs, alarm history, device inventory — HACCP compliance ready |
| **Event tracking** | Compressor cycles, defrost events, alarm transitions — overlay on telemetry charts |
| **Audit logging** | Immutable append-only log of all mutations — who did what, when, with before/after changes |
| **Internationalization** | Ukrainian & English (WebUI + Telegram Bot), light/dark theme |

---

## Architecture

```
ESP32 (ModESP_v4)
    │ MQTT over TLS (port 8883)
    ▼
Mosquitto Broker ── mosquitto-go-auth + PostgreSQL ACL
    │
    ▼
Node.js Backend (port 3000)
├── MqttService       → subscribe to all topics, state aggregation, alarm detection
├── DbService         → PostgreSQL connection pool (30 connections)
├── WsService         → WebSocket real-time delta broadcasts
├── ApiService        → Express REST API (60+ mutation + query endpoints)
├── PushService       → FCM + Telegram Bot + Web Push orchestrator
├── OtaService        → Fleet firmware deployment with rollback
├── AuditMiddleware   → Automatic mutation logging (fire-and-forget)
└── AuthService       → JWT access/refresh tokens, multi-tenant sessions
    │
    ├── PostgreSQL 16 (partitioned telemetry, 15 tables)
    └── Svelte SPA (static via Nginx)

Nginx → HTTPS (Let's Encrypt), reverse proxy, SPA fallback
```

### MQTT Protocol Design

ESP32 devices publish **48 individual state keys as separate MQTT topics** with scalar payloads (not JSON bundles) — a design constraint driven by the 80KB free RAM on ESP32. The cloud acts as an **adapter**, aggregating individual keys into structured device state, sampling telemetry server-side (every 5 min), and detecting alarm transitions.

```
modesp/v1/{tenant}/{device}/state/{key}    → "-2.50", "true"  (scalar, QoS 0)
modesp/v1/{tenant}/{device}/status         → "online"/"offline" (LWT)
modesp/v1/{tenant}/{device}/heartbeat      → JSON metadata (30s interval)
modesp/v1/{tenant}/{device}/cmd/{key}      ← scalar command (QoS 1)
modesp/v1/pending/{device}/...             ← auto-discovery namespace
```

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 22 |
| API Framework | Express.js | 4.21 |
| Database | PostgreSQL | 16 |
| MQTT Broker | Mosquitto + go-auth | 2.x |
| WebSocket | ws | 8.18 |
| Frontend | Svelte | 4.18 |
| Bundler | Vite | 5.4 |
| Charts | uPlot | 1.6 |
| Push (mobile) | Firebase Admin SDK | 13.7 |
| Push (web) | web-push (VAPID) | 3.6 |
| Push (messenger) | Telegram Bot API | 0.67 |
| Auth | JWT (jsonwebtoken) | 9.0 |
| Validation | Zod | 3.24 |
| Logging | Pino (structured JSON) | 9.6 |
| Testing | Vitest + Supertest | 3.2 |
| Reverse Proxy | Nginx | — |
| OS | Ubuntu | 24.04 LTS |

---

## Project Structure

```
ModESP_Cloud/
├── backend/
│   ├── src/
│   │   ├── index.js                # Entry point, service initialization
│   │   ├── config/
│   │   │   └── state_meta.json     # 48 state keys from ModESP_v4 firmware
│   │   ├── services/               # Business logic
│   │   │   ├── db.js               # PostgreSQL connection pool
│   │   │   ├── mqtt.js             # MQTT client, state aggregation, alarm detection
│   │   │   ├── mqtt-auth.js        # MQTT credential lifecycle (go-auth integration)
│   │   │   ├── ws.js               # WebSocket server (delta broadcasts)
│   │   │   ├── push.js             # Notification orchestrator (alarm/cleared/offline)
│   │   │   ├── telegram.js         # Telegram Bot (auth, RBAC, i18n, persistent keyboard)
│   │   │   ├── fcm.js              # Firebase Cloud Messaging
│   │   │   ├── webpush.js          # Web Push (VAPID)
│   │   │   ├── ota.js              # OTA deployment scheduler
│   │   │   └── auth.js             # JWT token lifecycle
│   │   ├── routes/                  # REST API endpoints (13 routers)
│   │   │   ├── auth.js             # login, refresh, logout, select/switch tenant
│   │   │   ├── devices.js          # CRUD, commands, service records, MQTT credentials
│   │   │   ├── telemetry.js        # Time-series queries + bucketed stats
│   │   │   ├── alarms.js           # Fault log + frequency analysis
│   │   │   ├── users.js            # User management + device assignment + tenant membership
│   │   │   ├── tenants.js          # Organization CRUD (superadmin)
│   │   │   ├── firmware.js         # Upload/list/delete firmware binaries
│   │   │   ├── ota.js              # Deploy, rollout, jobs, pause/resume/cancel
│   │   │   ├── fleet.js            # Fleet summary
│   │   │   ├── notifications.js    # Push subscriber management
│   │   │   ├── export.js           # HACCP data export (CSV + PDF)
│   │   │   └── audit.js            # Audit log queries (superadmin)
│   │   ├── middleware/
│   │   │   ├── auth.js             # JWT verification, role checks, tenant extraction
│   │   │   ├── device-access.js    # Per-device RBAC (filter + check)
│   │   │   ├── tenant.js           # Tenant context middleware
│   │   │   ├── audit.js            # Automatic mutation audit logging
│   │   │   └── validate.js         # Zod schema validation
│   │   └── db/
│   │       ├── schema.sql          # Full DB schema (15 tables)
│   │       ├── seed-admin.js       # Create first admin user
│   │       └── migrations/         # 002–015 (incremental)
│   ├── test/                        # 130+ tests across 15 test files
│   │   ├── helpers/                 # Test app, factories, migration runner
│   │   ├── auth.test.js            # JWT, login/logout, RBAC
│   │   ├── tenant-isolation.test.js # Cross-tenant data leak prevention
│   │   ├── device-access.test.js   # Per-device RBAC
│   │   └── ...                     # users, devices, tenants, alarms, fleet, OTA, audit...
│   ├── scripts/
│   │   ├── grant-all-devices.js    # Backward-compat RBAC migration
│   │   ├── cleanup-telemetry.js    # Retention: drop partitions >90 days
│   │   └── provision-mqtt-creds.js # Generate MQTT credentials for existing devices
│   ├── package.json
│   └── .env.example
│
├── webui/
│   ├── src/
│   │   ├── App.svelte              # Hash-based routing + admin route guards
│   │   ├── pages/                  # 10 pages (Dashboard, DeviceDetail, AuditLog, ...)
│   │   ├── components/             # 25+ UI components (layout, forms, charts)
│   │   └── lib/                    # API client, stores, i18n, WebSocket, theme, icons
│   ├── dist/                       # Production build (served by Nginx)
│   └── package.json
│
├── infra/
│   ├── systemd/                    # modesp-backend.service, telemetry partition timer
│   ├── nginx/                      # HTTPS, reverse proxy, SPA fallback, rate limiting
│   └── mosquitto/                  # go-auth config, TLS, ACL queries
│
├── docs/
│   ├── ARCHITECTURE.md             # System components, data flows, security model
│   ├── MQTT_PROTOCOL.md            # v1 protocol, topics, message formats
│   ├── DATABASE.md                 # Schema, partitioning, indexes
│   ├── API_REFERENCE.md            # 60+ REST endpoints with examples
│   ├── DEPLOYMENT.md               # VPS setup, migrations, cron jobs
│   └── ROADMAP.md                  # Development phases & progress
│
└── LICENSE                         # PolyForm Noncommercial License
```

---

## REST API

60+ endpoints with JWT authorization, per-device RBAC, and Zod validation.

| Group | Key Endpoints | Description |
|-------|--------------|-------------|
| **Auth** | `POST /auth/login, /refresh, /logout, /select-tenant, /switch-tenant` | JWT access + refresh tokens, multi-tenant session |
| **Devices** | `GET/PATCH /devices/:id`, `POST .../command`, `POST .../mqtt-credentials` | CRUD, commands, service records, credential lifecycle |
| **Telemetry** | `GET /devices/:id/telemetry[/stats]` | Raw data + bucketed aggregation (5m/15m/1h/6h/1d) |
| **Alarms** | `GET /alarms`, `/alarms/stats` | Fleet-wide fault log + frequency analysis |
| **Fleet** | `GET /fleet/summary` | Device count, online status, active alarms |
| **Users** | `GET/POST/PUT/DELETE /users`, `/users/:id/devices`, `/users/:id/tenants` | CRUD + device assignment + tenant membership |
| **Organizations** | `GET/POST/PATCH/DELETE /tenants` | Organization management (superadmin) |
| **Firmware** | `POST /firmware/upload`, `GET /firmware` | Upload/list/delete firmware binaries |
| **OTA** | `POST /ota/deploy`, `/ota/rollout`, rollout lifecycle | Single + batch deployment with board validation |
| **Discovery** | `GET /devices/pending`, `POST .../assign`, `POST /devices/register` | Zero-touch onboarding with bootstrap provisioning |
| **Events** | `GET /devices/:id/events` | Compressor cycles, defrost events, alarm transitions |
| **Export** | `GET .../export.csv`, `GET .../export.pdf` | HACCP CSV/PDF reports (telemetry, alarms, devices) |
| **Notifications** | `GET/POST/DELETE /notifications/subscribers` | FCM + Telegram + Web Push subscriptions |
| **Audit** | `GET /audit-log` | Immutable audit trail (superadmin, filterable) |

Full documentation: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)

---

## WebUI

10-page Svelte SPA with real-time WebSocket updates, i18n (UA/EN), and light/dark theme:

| Page | Description |
|------|-------------|
| **Dashboard** | Fleet overview, device list with search, online/offline status, health indicators |
| **Device Detail** | Live state (48 parameters), commands, telemetry charts, alarm history, service records |
| **Alarms** | Fleet-wide alarm journal with severity badges and filtering |
| **Firmware** | Firmware library, deploy to single device or group, board compatibility |
| **Users** | User management, per-device assignment, multi-tenant membership (admin) |
| **Organizations** | Tenant CRUD, device count, user count (superadmin) |
| **Pending Devices** | Auto-discovery onboarding — accept/reject new controllers |
| **Notifications** | FCM / Telegram / Web Push subscription management |
| **Audit Log** | Immutable activity log — who, what, when, before/after changes (superadmin) |
| **Login** | JWT authentication with multi-tenant picker |

---

## Security

| Layer | Mechanism |
|-------|-----------|
| ESP32 → Mosquitto | MQTT over TLS (port 8883), unique credentials per device via go-auth |
| Browser → Nginx | HTTPS (Let's Encrypt), HSTS, rate limiting |
| WebUI → API | JWT Bearer token (15 min access + 30 day refresh with rotation) |
| API → DB | Prepared statements (parameterized queries, no string concatenation) |
| Multi-tenancy | `tenant_id` in every SQL query + PostgreSQL RLS |
| Per-device RBAC | `user_devices` table, middleware on all device endpoints |
| Passwords | bcrypt (12 rounds) |
| Audit trail | Immutable append-only log with UPDATE/DELETE trigger protection |
| Secrets | `.env` file, never committed to git |

---

## Testing

**130+ integration tests** across 15 test suites, powered by **Vitest + Supertest** against a real PostgreSQL instance:

| Suite | Tests | Coverage |
|-------|-------|----------|
| Auth & JWT | ~15 | Login, logout, refresh, RBAC roles, token rejection |
| Tenant Isolation | ~12 | Cross-tenant data leak prevention |
| Per-device RBAC | ~10 | Technician/viewer device access restrictions |
| Users CRUD | ~10 | Create, update, delete, role escalation prevention |
| Devices CRUD | ~10 | CRUD, commands, pending device assignment |
| Organizations | ~8 | CRUD, superadmin-only access |
| Alarms | ~8 | Alarm queries, filtering, stats |
| Telemetry | ~8 | Time-series queries, stats aggregation |
| Fleet | ~5 | Summary endpoint, device counting |
| OTA & Firmware | ~10 | Upload, deploy, rollout lifecycle |
| Notifications | ~5 | Subscriber management |
| Audit Log | ~5 | Audit entry creation, superadmin-only access |
| + Legacy | 20 | MQTT topic parsing unit tests |

```bash
npm test              # Run Vitest integration tests
npm run test:legacy   # Run MQTT parsing unit tests
npm run test:all      # Run both
npm run test:coverage # Coverage report
```

---

## Quick Start (Development)

```bash
# 1. Clone
git clone https://github.com/Zapadenec1982/ModESP_Cloud.git
cd ModESP_Cloud

# 2. Backend
cd backend
cp .env.example .env    # Configure: DB, MQTT, JWT_SECRET
npm install
node src/db/seed-admin.js   # Create admin user
node src/index.js            # Start on :3000

# 3. WebUI
cd ../webui
npm install
npm run dev              # Vite dev server on :5173
```

**Requirements:** Node.js 22, PostgreSQL 16, Mosquitto (or `AUTH_ENABLED=false` for development without MQTT).

---

## Production Deployment

Deployed on **Hetzner VPS** (Ubuntu 24.04 LTS) — detailed guide: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

```bash
# On VPS
cd /opt/modesp-cloud
git pull origin main

# Apply new migrations
for f in backend/src/db/migrations/*.sql; do
  sudo -u postgres psql -d modesp_cloud -f "$f"
done

# Build WebUI
cd webui && npm install && npm run build

# Restart
sudo systemctl restart modesp-backend
```

**Minimum VPS requirements:** 1 vCPU, 2 GB RAM, 20 GB SSD (~$4/month on Hetzner).

---

## Project Status

**All core phases complete and production-deployed ✅**

| Phase | Name | Status |
|-------|------|--------|
| 1 | Cloud Foundation (MQTT, DB, State Aggregation) | ✅ Complete |
| 2 | REST API, WebSocket, Svelte WebUI | ✅ Complete |
| 3 | Push Notifications (FCM + Telegram + Web Push) | ✅ Complete |
| 4 | Auth, User Management, Dynamic MQTT Auth (go-auth) | ✅ Complete |
| 5 | History & Analytics (Telemetry, Alarm Stats, Charts) | ✅ Complete |
| 6 | Fleet OTA (Upload, Deploy, Rollout, Board Compatibility) | ✅ Complete |
| 6.5 | WebUI Polish (i18n UA/EN, Dark/Light Theme, Metadata) | ✅ Complete |
| 7 | Per-Device RBAC, Scalability, Frontend RBAC | ✅ Complete |
| 8a | Organization Management (superadmin, CRUD, device reassign) | ✅ Complete |
| 8b | Multi-Tenant Users (M:N memberships, tenant picker/switcher) | ✅ Complete |
| 8c | Telegram Bot Redesign (auth, RBAC, i18n, persistent keyboard) | ✅ Complete |
| 9 | Audit Logging (immutable log, middleware, before/after changes) | ✅ Complete |
| 10 | Test Infrastructure (Vitest, 130+ tests, 15 test suites) | ✅ Complete |
| 11 | Platform Hardening (Events API, HACCP Export, Password Change, Alarm Severity) | ✅ Complete |
| — | VPS Production Deployment | ✅ Production |

**Next phases:** Energy Monitoring & Health Score, Fleet Benchmarking & Anomaly Detection, Webhooks & OpenAPI, PWA.

Full roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) | [`docs/ROADMAP_NEXT.md`](docs/ROADMAP_NEXT.md)

---

## Documentation

| Document | Description |
|----------|-------------|
| [**`docs/FEATURES.md`**](docs/FEATURES.md) | **All platform capabilities at a glance** ([🇺🇦 Українською](docs/FEATURES_UA.md)) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System components, data flows, security model |
| [`docs/MQTT_PROTOCOL.md`](docs/MQTT_PROTOCOL.md) | MQTT v1 protocol, topics, message formats |
| [`docs/DATABASE.md`](docs/DATABASE.md) | DB schema (15 tables), partitioning, indexes |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | 60+ REST endpoints with request/response examples |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | VPS deployment guide, migrations, monitoring |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Development phases & progress |
| [`docs/ROADMAP_NEXT.md`](docs/ROADMAP_NEXT.md) | Future roadmap (Energy, Anomaly Detection, SaaS) |

---

## Technical Highlights

### For Reviewers & Hiring Managers

This project demonstrates production-grade skills across the full IoT stack:

**Backend Architecture:**
- Multi-tenant SaaS with complete data isolation (MQTT + DB + API layers)
- Custom MQTT protocol design for constrained embedded devices (80KB RAM)
- Server-side telemetry aggregation — cloud adapts to firmware, not vice versa
- Fire-and-forget audit middleware with immutable append-only PostgreSQL table
- JWT auth with refresh token rotation, multi-tenant sessions, and 4-tier RBAC

**Database Design:**
- 15 normalized tables with PostgreSQL partitioning for time-series data
- Row-Level Security (RLS) as defense-in-depth for multi-tenancy
- 14 incremental migrations — schema evolution without downtime

**Frontend Engineering:**
- Svelte SPA with real-time WebSocket updates (delta broadcasts, not polling)
- Custom inline SVG icon system (no external icon library dependency)
- Full i18n system with reactive locale switching
- Responsive design with mobile sidebar, light/dark themes

**IoT & Embedded:**
- Designed MQTT v1 protocol for ESP32 (individual scalar keys, not JSON bundles)
- Zero-touch device provisioning: auto-discovery → assign → credential rotation → reconnect
- Fleet OTA with board compatibility validation, batch rollout, and auto-pause on failure
- mosquitto-go-auth integration for dynamic per-device ACL from PostgreSQL

**DevOps & Testing:**
- Production VPS deployment with systemd, Nginx (HTTPS/WSS), Let's Encrypt auto-renewal
- 130+ integration tests against real PostgreSQL (not mocks)
- Structured JSON logging (Pino), rate limiting, security headers (Helmet)

---

## License

This project is licensed under the [**PolyForm Noncommercial License 1.0.0**](LICENSE).

You are free to view, learn from, and use this code for personal and non-commercial purposes.
**Commercial use requires written permission** from the author.

For commercial licensing inquiries, contact: [github.com/Zapadenec1982](https://github.com/Zapadenec1982)

---

## Author

**Yurii Tepliuk** — Full-Stack IoT Engineer, Ukraine

- Multi-tenant IoT cloud platforms (Node.js + PostgreSQL + MQTT)
- ESP32 firmware development (ESP-IDF, C++, FreeRTOS)
- Svelte / React frontends with real-time data visualization
- Production deployment & DevOps (Linux, Nginx, systemd, Docker)

[![GitHub](https://img.shields.io/badge/GitHub-Zapadenec1982-181717?logo=github)](https://github.com/Zapadenec1982)
