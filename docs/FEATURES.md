# ModESP Cloud — Platform Features

**Multi-tenant IoT platform for commercial refrigeration monitoring, HACCP compliance, and remote device management.**

> Built with Node.js, PostgreSQL, MQTT, Svelte — deployed on Linux VPS with TLS everywhere.

---

## At a Glance

| Metric | Value |
|--------|-------|
| API endpoints | 60+ REST |
| Real-time channels | MQTT + WebSocket |
| Device parameters | 48 per device (temperatures, alarms, settings) |
| Alarm types | 10 (critical / warning / info) |
| Test coverage | 130+ integration tests |
| Languages | Ukrainian, English |
| Deployment | Production on Hetzner VPS, TLS/HTTPS |

---

## 1. Multi-Tenancy

Complete tenant isolation at every layer — database, MQTT broker, API, and UI.

- **Tenant CRUD** — create, rename, deactivate tenants with plan tiers (free / basic / pro / enterprise)
- **Data isolation** — every SQL query scoped by `tenant_id`; MQTT topics physically separated by tenant slug
- **Cross-tenant operations** — superadmin can view all tenants, reassign devices between tenants
- **Tenant-aware RBAC** — users belong to one or more tenants; admin sees only their tenant's data
- **Tenant switching** — multi-tenant users select active tenant on login or switch mid-session

---

## 2. Device Management

Full lifecycle from factory to field — auto-discovery, assignment, monitoring, reassignment.

### Auto-Discovery & Provisioning
- ESP32 devices self-register via MQTT with a shared bootstrap key
- New devices appear in **Pending Devices** queue with online/offline status
- Admin assigns device to tenant → platform auto-generates unique MQTT credentials and delivers them over-the-air
- Zero-touch provisioning: device reconnects with new credentials automatically

### Device Properties
- Name, location, serial number, model, manufacturing date, free-text comments
- Firmware version and protocol version tracked via heartbeat
- Real-time online/offline status (90-second heartbeat threshold)

### Live State
- 48 parameters updated in real-time: temperatures (air, evaporator, condenser), setpoint, compressor state, defrost cycle, door status, protection alarms, thermostat settings
- State visible in UI with grouped categories (Equipment, Thermostat, Defrost, Protection)
- WebSocket push — UI updates instantly without polling

### Device Reassignment
- Superadmin moves device between tenants in one click
- Automatic credential rotation, RBAC cleanup, and MQTT topic migration
- 120-second grace period prevents false offline alerts during transition

---

## 3. Remote Command & Control

Send commands to devices from the cloud — REST API or Web UI.

- **Parameter editing** — change thermostat setpoint, defrost intervals, protection thresholds remotely
- **Validated commands** — only writable parameters accepted (defined in device metadata schema)
- **Full state refresh** — request device to re-publish all 48 parameters on demand
- **MQTT delivery** — commands published to device-specific MQTT topics with QoS guarantees
- **Role-based** — only admin and technician roles can send commands; viewers are read-only

---

## 4. Telemetry & Analytics

Server-side sampling with flexible queries and time-series aggregation.

### Data Collection
- 6 telemetry channels sampled every 5 minutes: air temperature, evaporator temperature, condenser temperature, setpoint, compressor (on/off), defrost (on/off)
- 30-second debouncing prevents duplicate writes from rapid state changes
- Monthly PostgreSQL partitions — automatic creation and 90-day cleanup

### Query API
- **Raw data** — up to 10,000 points per request with `X-Truncated` header if capped
- **Aggregated stats** — min / max / avg per time bucket (5m, 15m, 1h, 6h, 1d)
- **Channel filtering** — request only the channels you need
- **Flexible time range** — ISO timestamps or relative hours (default 24h, max 31 days)

### Interactive Charts
- Multi-channel line chart (uPlot) with zoom, pan, legend
- Event overlay — compressor cycles, defrost starts, alarms shown as dashed vertical lines
- Expandable event log below chart

---

## 5. HACCP Compliance & Data Export

Built-in tools for food safety compliance (Ukraine HACCP regulations).

### CSV Export
- **Telemetry CSV** — temperature logs with timestamps, UTF-8 BOM for Excel compatibility
- **Device inventory CSV** — all devices with properties (name, model, location, serial number, firmware)
- **Alarm history CSV** — filterable by severity and date range (up to 90 days)

### PDF Report
- **HACCP temperature report** — professional PDF with summary statistics, alarm timeline, hourly temperature log
- Cyrillic support (Roboto font) — ready for Ukrainian regulatory submissions
- Server-side generation (pdfmake) — no browser dependency

### Rate Limiting
- 10 exports per minute per user — prevents abuse without blocking legitimate use

---

## 6. Alarm System

10 alarm types with severity classification, nuisance delays, and multi-channel notifications.

### Alarm Types & Severity

| Severity | Alarms |
|----------|--------|
| **Critical** | High temperature, Low temperature, Sensor 1 failure, Sensor 2 failure |
| **Warning** | Door open, Continuous run, Pulldown failure |
| **Info** | Rate alarm, Short cycle, Rapid cycle |

### Smart Detection
- Boolean state transition monitoring (off→on = alarm raised, on→off = cleared)
- **Nuisance delays** — door alarm waits 2 minutes, pulldown waits 5 minutes before confirming
- Active/cleared timestamps with duration tracking

### Alarm API & UI
- Filter by severity, active/cleared, device, date range
- Alarm statistics — count and average duration per alarm code
- Severity pills in UI (All / Critical / Warning / Info) for quick triage
- Per-device RBAC — users see alarms only for assigned devices

---

## 7. Energy Monitoring

Estimated energy consumption based on equipment model power profiles.

### Energy Estimation
- Compressor runtime × rated power → estimated kWh per sampling interval
- Breakdown by component: compressor, defrost heater, fans, standby consumption
- Equipment model profiles (device_models table) with per-device power overrides
- Cost calculation with configurable electricity rate per tenant (currency-aware)

### Forward Compatibility
- Reserved MQTT key `equipment.energy_kwh` for real CT clamp energy sensors (future firmware)
- Auto-detect: if firmware publishes `equipment.energy_kwh`, sampler uses metered value instead of estimate
- `energy_source` flag: `estimated` (default) or `metered` (CT clamp)

### UI & API
- Energy tab on Device Detail page — kWh chart, cost summary, component breakdown
- Energy channel (`energy`) on telemetry chart alongside temperature channels
- `GET /api/devices/:id/energy/summary` — kWh totals, cost, breakdown by component

---

## 8. Event Tracking

Operational events beyond alarms — equipment cycles, status changes, device connectivity.

- **Event types** — compressor on/off, defrost start/end, alarm raised/cleared, device online/offline
- **Query API** — filter by event type, time range, pagination
- **Chart overlay** — events rendered as vertical markers on telemetry charts
- **Buffered writes** — 1-second flush interval with bulk INSERT for performance

---

## 9. Notifications & Alerting

Multi-channel push system — Telegram, Firebase (mobile), Web Push.

### Telegram Bot
- Full-featured bot with 7 commands: `/start`, `/devices`, `/status`, `/alarms`, `/tenant`, `/unlink`, `/help`
- **User linking** — generate 7-character code in Web UI → send to bot → account linked
- **Device status** — tap device → detailed view with temperatures, location, alarms
- **Multi-tenant** — switch active tenant via `/tenant` command
- **Bilingual** — Ukrainian and English with per-chat language toggle
- **RBAC-aware** — technicians see only assigned devices; info-severity alarms → admin only

### Firebase Cloud Messaging
- Android and web push notifications
- Automatic cleanup of stale FCM tokens

### Notification Routing
- Per-subscriber device filter — choose which devices trigger notifications
- Active/inactive toggle — soft-disable without deleting
- **Debouncing** — 5-second cooldown per device+alarm prevents duplicate pushes
- **Offline delay** — 2-minute wait before sending "device offline" (prevents flapping noise)

### Delivery Tracking
- Notification log with status, error messages, timestamps
- Test endpoint to verify subscriber connectivity

---

## 10. OTA Firmware Updates

Upload, deploy, and monitor firmware updates — single device or fleet-wide rollout.

### Firmware Library
- Upload `.bin` files (up to 4 MB) with version tag, board type, release notes
- SHA-256 checksum computed at upload, verified by device on download
- Board compatibility check — prevents deploying wrong firmware to wrong hardware

### Single Device Deploy
- One-click deploy from UI or API
- MQTT command with download URL, version, checksum
- Status tracking: queued → sent → success / failed (10-minute timeout)
- Pre-OTA version captured for reliable success detection via heartbeat

### Group Rollout
- Select firmware + device list → deploy in configurable batches
- **Batch size** — how many devices per wave
- **Batch interval** — seconds between waves (prevent network congestion)
- **Failure threshold** — auto-pause rollout if failure rate exceeds configured percentage
- Admin can resume paused rollouts
- Survives server restart — reconstructed from database on boot

### Background Monitoring
- 30-second polling: compare device firmware version with expected post-OTA version
- Automatic success/failure detection without device callback

---

## 11. User Management & Authentication

JWT-based auth with 4-tier RBAC and per-device access control.

### Authentication
- **JWT tokens** — 15-minute access token, 30-day refresh token with rotation
- **Password policy** — 15-character minimum (NIST SP 800-63B aligned, no complexity rules)
- **HaveIBeenPwned check** — client-side k-anonymity check against breached password database
- **Rate limiting** — 50 login attempts / 5 minutes / IP
- **Password change** — requires old password verification, issues new tokens

### Role-Based Access Control

| Role | Scope | Capabilities |
|------|-------|-------------|
| **Superadmin** | Platform-wide | All operations, cross-tenant access, audit log, tenant CRUD |
| **Admin** | Own tenant | Full control: devices, users, firmware, notifications |
| **Technician** | Assigned devices | View, send commands, deploy firmware, manage service records |
| **Viewer** | Assigned devices | Read-only access (no commands, no editing) |

### Per-Device Assignment
- Admin assigns specific devices to technician/viewer users
- Enforced at API level — unauthorized device access returns 403
- Bulk assign/revoke via API
- Assignment audit trail (granted_by, granted_at)

### Multi-Tenant Membership
- Users can belong to multiple tenants (M:N relationship)
- Tenant selection on login if multiple memberships exist
- Mid-session tenant switching without re-login

### Telegram Linking
- Generate linking code in Web UI → send to Telegram bot → account connected
- Bot commands respect user's RBAC role and device assignments

---

## 12. Audit Logging

Immutable, append-only audit trail for compliance and security.

- **Automatic capture** — all create/update/delete operations logged without code changes in routes
- **Logged fields** — user, action, entity type/ID, before/after changes (JSON diff), IP address, user agent, timestamp
- **Immutability** — PostgreSQL trigger prevents UPDATE/DELETE on audit log table
- **Query API** — filter by tenant, entity type, action, user, date range (superadmin only)
- **Web UI** — sortable table with filters, JSON diff viewer for before/after changes
- **Fire-and-forget** — audit writes never block the main request

---

## 13. Real-Time Communication

Dual real-time channels — MQTT for device-to-cloud, WebSocket for cloud-to-browser.

### MQTT (Device ↔ Cloud)
- Topic hierarchy: `modesp/v1/{tenant}/{device}/state/{key}` (48 individual scalar topics)
- Heartbeat every 30 seconds with firmware version, uptime, free heap, WiFi RSSI
- TLS encryption on port 8883 with Let's Encrypt certificate
- Mosquitto broker with PostgreSQL-backed ACL (go-auth plugin)

### WebSocket (Cloud → Browser)
- JWT-authenticated connection (`ws://host/ws?token=...`)
- Per-tenant scoping — clients receive updates only for their tenant's devices
- Message types: state delta (changed keys only), alarm, device status
- Per-device RBAC — subscription validated against user's device assignments
- Backpressure handling — skip messages if client buffer exceeds 64 KB

---

## 14. Web Interface

Responsive Svelte SPA with dark/light theme and full i18n.

### Pages
| Page | Description |
|------|-------------|
| **Dashboard** | Fleet summary (online/total/alarms), device grid with search and filters |
| **Device Detail** | Live state, telemetry charts, alarm history, event log, service records, controls |
| **Alarms** | Alarm table with severity filters, CSV export |
| **Firmware** | Upload, library, deploy modal, rollout monitor |
| **Notifications** | Subscriber management, test send, delivery log |
| **Pending Devices** | Unassigned device queue, batch assignment with metadata |
| **Users** | User CRUD, role assignment, device assignment modal, Telegram linking |
| **Tenants** | Tenant CRUD (superadmin), device/user counts per tenant |
| **Audit Log** | Searchable audit trail with JSON diff viewer (superadmin) |

### UX Features
- **Dark / Light mode** — CSS custom properties, toggle in settings, localStorage persistence
- **Bilingual** — Ukrainian + English, 500+ translation keys, locale-aware date/number formatting
- **Responsive** — mobile-optimized header and sidebar
- **Toast notifications** — success/error feedback for all actions
- **Connection indicator** — real-time MQTT/WebSocket status in header

---

## 15. Infrastructure & Operations

Production-ready deployment with TLS, backups, and monitoring.

### Security
- HTTPS everywhere (Let's Encrypt, auto-renewal)
- MQTT TLS on port 8883
- ESP32 validates server certificate via built-in CA bundle
- bcrypt password hashing (cost factor 12)
- CORS restricted to production domain
- Immutable audit log

### Database
- PostgreSQL 16 with connection pooling (max 30 connections)
- Statement timeout (30s) prevents runaway queries
- Monthly telemetry partitions with automatic creation and 90-day cleanup
- 18+ tables with proper indexes, foreign keys, and constraints

### Monitoring
- `GET /api/health` — database, MQTT, uptime status
- StateMap monitoring — device count, total keys, estimated memory usage (logged every 60s)
- Pino structured logging (JSON in production)

### Backups & Maintenance
- Daily PostgreSQL dump at 2:00 AM (30-day retention)
- Telemetry partition cleanup at 3:00 AM daily
- Monthly partition pre-creation (25th of each month)

### Deployment
- systemd service with automatic restart
- Nginx reverse proxy with WebSocket upgrade support
- Git-based deploy (`git pull` + `systemctl restart`)

---

## 16. Developer Experience

Clean codebase with testing infrastructure and local development tools.

- **130+ integration tests** — Vitest + Supertest against real PostgreSQL (Docker, tmpfs-backed)
- **Test suites** — auth, RBAC, tenant isolation, CRUD, audit logging, OTA, notifications
- **Vite dev server** — frontend hot-reload on port 5173
- **Dev mode** — `AUTH_ENABLED=false` bypasses JWT for rapid development
- **Structured migrations** — 15 numbered SQL migration files, applied in order
- **State metadata** — `state_meta.json` defines all 48 device parameters with types, units, groups, writable flags

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js 22, Express 4.21 |
| **Database** | PostgreSQL 16 |
| **MQTT Broker** | Mosquitto 2.0 + go-auth (PostgreSQL ACL) |
| **Frontend** | Svelte 4.18, Vite 5.4 |
| **Charts** | uPlot |
| **PDF Generation** | pdfmake (server-side, Cyrillic support) |
| **Auth** | JWT (HS256), bcrypt, express-rate-limit |
| **Testing** | Vitest 3.2, Supertest |
| **Push** | Telegram Bot API, Firebase Cloud Messaging, Web Push (VAPID) |
| **Deployment** | Linux VPS, systemd, Nginx, Let's Encrypt |
| **Firmware** | ESP-IDF 5.5, ESP32 (MQTT + TLS) |

---

## Architecture Diagram

```
┌─────────────┐     MQTT/TLS      ┌──────────────┐     PostgreSQL     ┌──────────────┐
│   ESP32      │◄────────────────►│  Mosquitto    │◄──── go-auth ────►│  PostgreSQL   │
│  (firmware)  │   8883            │  (broker)     │                   │  (16 + pool)  │
└─────────────┘                   └──────┬───────┘                   └──────▲───────┘
                                         │ localhost:1883                    │
                                         ▼                                  │
                                  ┌──────────────┐     SQL queries          │
                                  │  Node.js      │◄───────────────────────┘
                                  │  (Express)    │
                                  │               ├──── WebSocket ────►  Browser (Svelte)
                                  │  Services:    │
                                  │  · MQTT       ├──── REST API ────►  Browser / Mobile
                                  │  · Telemetry  │
                                  │  · Alarms     ├──── Telegram ────►  Telegram Bot
                                  │  · OTA        │
                                  │  · Push       ├──── FCM ─────────►  Mobile Push
                                  │  · Audit      │
                                  └──────────────┘
```

---

*ModESP Cloud — from sensor to dashboard in real time.*
