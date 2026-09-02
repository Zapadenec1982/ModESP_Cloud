# ModESP Cloud — Platform Features

**Multi-tenant IoT platform for commercial refrigeration monitoring, HACCP compliance, and remote device management.**

> Built with Node.js, PostgreSQL, MQTT, Svelte — deployed on Linux VPS with TLS everywhere.

---

## At a Glance

| Metric | Value |
|--------|-------|
| API endpoints | 90+ REST |
| Real-time channels | MQTT + WebSocket |
| Device parameters | 48 per device (temperatures, alarms, settings) |
| Alarm types | 10 (critical / warning / info) |
| Test coverage | 130+ integration tests |
| Languages | Ukrainian, English, Polish, German |
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
- Site assignment — country, region, city and street address live on the site, shared by every device at that address
- Geographic coordinates (latitude/longitude) as an optional per-device override on top of the site's
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

### PDF Report (inspection-grade)
- **HACCP temperature log per device or per site** (`GET /devices/:id/telemetry/export.pdf`, `GET /sites/:id/export.pdf`, up to 50 devices in one document)
- Localised uk / en / pl / de (follows the interface language); organisation legal name and tax id, site address and time zone, timestamps in the site's local time
- Summary per channel, alarms during the period with acknowledgement marks, temperature log, sensor note with the last service record, responsible-person signature block
- **Tamper evidence:** every report gets a 12-character verification code and a SHA-256 of its data, printed in the footer; anyone can confirm it at `GET /api/public/report/:code` without logging in; every download is written to the audit log
- **Three-year history:** recent periods come from raw telemetry (up to 31 days per report); periods beyond the plan's raw retention are served from the hourly archive `telemetry_hourly` (up to a year per report, kept 1095 days)
- Cyrillic support (Roboto font), server-side generation (pdfmake) — no browser dependency
- Empty periods answer `404 no_data` instead of producing a blank document

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

## 8. Sites & Geographic Intelligence

Physical trade points as first-class objects — one address, many devices — plus everything a service
organisation actually does with a map.

### Sites (Trade Points)
- A site is one physical object (store, warehouse, workshop) with country, region, city, street address and postal code
- One device belongs to at most one site; a site holds any number of devices — a store with ten cabinets is one pin on the map, not ten
- `location` keeps its old meaning: free text for the spot **inside** the site ("Hall, row 3"), not an address
- Per-device coordinates remain an optional override on top of the site's — effective map position is the device's own coordinate first, the site's second
- Existing `location` values are backfilled into sites during migration, so an upgraded deployment starts with a populated map
- Site names are unique per tenant, compared case- and whitespace-insensitively

### Server-Side Geocoding
- Address → coordinates through a backend proxy (Nominatim). The browser never calls the geocoder directly: one identifying User-Agent, one 1 req/s pacer, one shared cache — exactly what the OSM usage policy requires
- Structured queries (street / city / country) for sites; free-form text only for the autocomplete box, where the user is typing arbitrary input
- **Country sanity check** — a result whose country contradicts the requested one is treated as no match. A mangled query fails silently and confidently: corrupted Cyrillic returns French departments with high confidence scores and no error. This one guard is what stands between a demo map and a fleet apparently located in France
- Persistent cache with two lifetimes: hits 180 days, genuine misses 6 hours, transport failures never cached — one provider blip must not make an address un-geocodable for half a year
- Address autocomplete and a draggable marker with reverse geocoding in the UI
- Fully optional: with `GEOCODER_PROVIDER=none` the autocomplete hides itself and the platform keeps working on manually entered coordinates

### Fleet Map
- Clustered markers, one per site, coloured by the worst device status inside the cluster
- Filter bar: country, region, city, site, model, firmware version, device status, assigned user, free text search, viewport bounding box
- Alarm heatmap layer, aggregated in SQL over any period
- Coverage isochrones (15 / 30 / 60 min) — real drive-time polygons with an OpenRouteService key; without one, straight-line rings that the UI **visibly labels as approximate**, so no planning decision rests on a circle mistaken for a drive-time polygon
- Click-to-place coordinates, live WebSocket status updates and the "no coordinates" worklist all carried over from the original map

### Geo Analytics
- Drill-down: country → region → city → site
- Per group: device / online / offline / alarm counts, alarms in period, average air temperature, uptime %, estimated kWh, service visits
- Sortable table plus CSV export with identical filters and identical access rules — a metric that cannot be computed cheaply returns null rather than a fabricated zero

### Service Round Planner
- Multi-select sites on the map → optimised visiting order (OSRM travelling-salesman), route polyline, per-leg distance and duration
- Hand-off to a phone as a Google Maps directions link with waypoints
- Without a routing server the planner still answers: nearest-neighbour ordering and the deep link need no upstream at all, and the result is labelled "orientation only, not drive-time optimised"
- Nearest technicians to a site, ranked by distance from their home base, enriched with real driving time when routing is configured. An admin sees id, email, home address, distance to 0.1 km and duration; a technician sees a masked label, no address, and a distance coarsened to whole kilometres — 0.1 km over three sites would trilaterate the colleague's home. Asking about a site requires the same access as reading the site itself. Never tokens, telegram ids or password hashes

### Outdoor Weather
- Current conditions and hourly forecast per site (Open-Meteo), with hourly history retained for 395 days so year-over-year comparison keeps working
- **Outdoor temperature as a second series on the device telemetry chart**, on its own right-hand axis — this is the payoff: it is what explains load spikes and COP drops that look inexplicable on the cabinet's own curves
- Site IANA timezone filled automatically from the same weather response — no extra dependency, no manual entry
- The poller batches one request per distinct rounded coordinate, not one per site

### Site-Level Access Control
- Grant a technician an entire site instead of ticking devices one by one; devices added to that site later are covered automatically
- Effective access is the union of per-device and per-site grants — the existing per-device model is unchanged
- Grants carry their own tenant, so a grant held in one tenant grants nothing while the user works in another
- Technicians edit their own home base from the sidebar user menu (`PATCH /api/profile`); admins can set it for anyone from the Users page

### Public Status Links
- Share a read-only status page for one site with a customer — no login, no account, no app
- The token is 32 random bytes, stored only as a sha256 hash, shown exactly once at creation, and sent in a request header so it never lands in a server access log or a Referer
- Expiry is mandatory (90 days by default), links are revocable, and each carries a view counter
- The page exposes only the site name, city / region / country, and per device a display label, online flag, air temperature and alarm flag — no ids, no serial numbers, no firmware versions, no tenant slug, no coordinates finer than city
- Revoked, expired and unknown tokens are indistinguishable: all three return the same 404, so the page never confirms that a token existed

### Third-Party Services — Demo Posture
Geocoding, weather, routing and isochrones are all ENV-gated, called server-side only, and degrade to a
working disabled state rather than an error. The current deployment uses their free / non-commercial
tiers **for demo purposes**. ModESP Cloud is a commercial product, so each one needs a paid plan or a
self-hosted instance before production — the checklist lives in `docs/THIRD_PARTY_LICENSING.md`.
`© OpenStreetMap contributors` attribution is rendered on every map and must not be removed.

---

## 9. Event Tracking

Operational events beyond alarms — equipment cycles, status changes, device connectivity.

- **Event types** — compressor on/off, defrost start/end, alarm raised/cleared, device online/offline
- **Query API** — filter by event type, time range, pagination
- **Chart overlay** — events rendered as vertical markers on telemetry charts
- **Buffered writes** — 1-second flush interval with bulk INSERT for performance

---

## 10. Notifications & Alerting

### Correctness and acknowledgement (plan epic 1.6)
- Recipients: organisation admins; technicians and viewers through per-device grants **or** site grants (the same rule the API uses); superadmins only when `receive_all_tenant_alerts` is set
- Per-user preferences ("My notifications", every role): on/off, minimum severity, channels, quiet hours with time zone — critical alarms and escalations always get through
- Acknowledge: `POST /alarms/:id/ack` with an optional note, button on the Alarms page, shown in device alarm history; an unacknowledged critical alarm is re-sent once to admins after `ALARM_ACK_ESCALATION_MIN` (15) minutes, tracked in the database so restarts neither lose nor duplicate it
- Offline is an alarm: `device_offline` (warning) is raised two minutes after the offline detector fires and closed by the device's next message, so outages show up in alarm lists, HACCP history and acknowledgement flows
- Every user-path delivery (Telegram, Web Push, email) is logged with user and alarm; admins see it via `GET /alarms/:id/deliveries`

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

## 11. OTA Firmware Updates

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

## 12. User Management & Authentication

JWT-based auth with 4-tier RBAC and per-device access control.

### Authentication
- **JWT tokens** — 15-minute access token, 30-day refresh token with rotation
- **Password policy** — 15-character minimum on every path (create, change, reset, invitation, seed script), NIST SP 800-63B aligned, no complexity rules
- **HaveIBeenPwned check** — client-side k-anonymity check against breached password database (allowed in CSP)
- **Rate limiting** — 50 login attempts / 5 minutes / IP; 10 reset requests / hour / IP
- **Password change** — requires old password verification
- **Invitations** — admins invite an email with a role; the invitee opens `#/invite/<token>` (72 h), accepts the terms and sets a password, or proves an existing account's password to join a second organisation; the link is always shown to the admin so onboarding works before email is configured
- **Self-service reset** — "Forgot password?" emails a `#/reset` link with a 30-minute code (same code path as the admin-generated code, which stays as the fallback)
- **Self-service router** — `/api/profile` carries own profile, email/password, Telegram link and Web Push subscription for every role; technician sessions survive a reload

### Role-Based Access Control

| Role | Scope | Capabilities |
|------|-------|-------------|
| **Superadmin** | Platform-wide | All operations, cross-tenant access, audit log, tenant CRUD |
| **Admin** | Own tenant | Full control: devices, users, firmware, notifications |
| **Technician** | Assigned devices | View, send commands, deploy firmware, manage service records |
| **Viewer** | Assigned devices | Read-only access (no commands, no editing) |

### Command safety and tenant isolation
- `POST /devices/:id/command` is admin/technician only (viewers are read-only even with device access); values are validated against `state_meta.json` (type, min/max, step); setpoint, protection limits, manual defrost and alarm reset require `confirm: true`, and the WebUI asks first
- Every command is audited as `device.command`; admins see the history per device (`GET /devices/:id/commands`, "Command history" in the parameter editor)
- WebSocket global events (alarms) are delivered only to sockets of the alarm's tenant; the superadmin sees all
- Pending controllers are claimed with the code printed on the controller (`POST /devices/claim`): an organisation sees, assigns and recovers only what it has claimed; the superadmin sees the whole queue with codes

### Plans, organisation status, settings (plan epic 1.8)
- `plan_limits` catalogue (Старт / Об'єкт / Мережа / Enterprise / Партнер): device, site and user caps, retention, sampling, features; assignment, user creation/invitation and site creation answer `402 plan_limit` at the cap, HACCP PDF / energy / isochrones answer `402 plan_feature` outside the plan; the WebUI shows usage against the limit and an upgrade hint
- `tenants.status` (trial, active, past_due, suspended, closed) with billing identity fields; a suspended organisation cannot sign in, refresh or switch, and its controllers get no broker topics while keeping their credentials, so reactivation is instant
- Organisation settings page (admins): time zone, notification language, electricity tariff and currency, door/pulldown alarm delays, offline threshold and offline-alarm delay, acknowledgement escalation — read live by the MQTT and push services

### Per-Device Assignment
- Admin assigns specific devices to technician/viewer users
- Enforced at API level — unauthorized device access returns 403
- Bulk assign/revoke via API
- Assignment audit trail (granted_by, granted_at)

### Per-Site Assignment
- Admin grants a whole site instead of ticking devices one by one; devices added to that site later are covered automatically
- Effective access is the union of per-device and per-site grants — the per-device model is unchanged
- Grants carry their own tenant, so a grant held in one tenant grants nothing while the user works in another
- Staged in the same modal as device assignment: Cancel discards both, Save applies both

### Multi-Tenant Membership
- Users can belong to multiple tenants (M:N relationship)
- Tenant selection on login if multiple memberships exist
- Mid-session tenant switching without re-login

### Telegram Linking
- Generate linking code in Web UI → send to Telegram bot → account connected
- Bot commands respect user's RBAC role and device assignments

---

## 13. Audit Logging

Immutable, append-only audit trail for compliance and security.

- **Automatic capture** — all create/update/delete operations logged without code changes in routes
- **Logged fields** — user, action, entity type/ID, before/after changes (JSON diff), IP address, user agent, timestamp
- **Immutability** — PostgreSQL trigger prevents UPDATE/DELETE on audit log table
- **Query API** — filter by tenant, entity type, action, user, date range (superadmin only)
- **Web UI** — sortable table with filters, JSON diff viewer for before/after changes
- **Fire-and-forget** — audit writes never block the main request

---

## 14. Real-Time Communication

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

## 15. Web Interface

Responsive Svelte SPA with dark/light theme and full i18n.

### Pages
| Page | Description |
|------|-------------|
| **Dashboard** | Fleet summary (online/total/alarms), device grid with search and filters |
| **Map** | Interactive OpenStreetMap fleet map — clustered site markers, filter bar, alarm heatmap, coverage isochrones, service-round planner, click-to-place coordinates, one-tap directions via Google / Apple / Waze / OSM |
| **Geo Analytics** | Country → region → city → site drill-down, metric table, CSV export |
| **Sites** | Trade point CRUD (`/sites`), address autocomplete, a geocoding-status panel with a manual sweep trigger, and public status link management (the raw token is shown exactly once). Weather and nearest technicians live on the device Location tab |
| **Device Detail** | Live state, telemetry charts, alarm history, event log, service records, controls |
| **Alarms** | Alarm table with severity filters, CSV export |
| **Firmware** | Upload, library, deploy modal, rollout monitor |
| **Notifications** | Subscriber management, test send, delivery log |
| **Pending Devices** | Unassigned device queue, batch assignment with metadata |
| **Users** | User CRUD, role assignment, device + site assignment modal, technician home base, Telegram linking |
| **Tenants** | Tenant CRUD (superadmin), device/user counts per tenant |
| **Audit Log** | Searchable audit trail with JSON diff viewer (superadmin) |
| **Public Site Status** | Read-only single-site status page for customers — no login, no sidebar, no authenticated call |

### UX Features
- **Dark / Light mode** — CSS custom properties, toggle in settings, localStorage persistence
- **Four languages** — Ukrainian (primary), English, Polish, German; 600+ translation keys, locale-aware date/number formatting
- **Responsive** — mobile-optimized header and sidebar
- **Toast notifications** — success/error feedback for all actions
- **Connection indicator** — real-time MQTT/WebSocket status in header

---

## 16. Infrastructure & Operations

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
- Monthly telemetry partitions: created 6 months ahead by `modesp-telemetry-partition.timer`; raw rows are folded into `telemetry_hourly` and purged per the organisation's plan retention by `cleanup-telemetry.js` (daily, `modesp-retention-cleanup.timer`), partitions are dropped once older than the longest plan retention; `drop_telemetry_partition()` refuses anything younger than 7 days
- 18+ tables with proper indexes, foreign keys, and constraints

### Monitoring
- `GET /api/health` — database, MQTT, uptime, plus categorical platform checks (`platform`, `checks.backup/partitions/disk`) sized for an external keyword probe (UptimeRobot / Better Stack)
- `GET /api/health/details` (superadmin) — version, memory, broker client count (`$SYS`), backup age and size, partition headroom, free disk, per-channel delivery counters, Telegram bot health
- `modesp-alert@.service` — every ModESP unit has `OnFailure=`; a failed backup, cleanup, partition run or a backend crash loop posts the unit name and its last journal lines to a Telegram group (`PLATFORM_ALERT_CHAT_ID`)
- Restart safety: `shutdown()` flushes every dirty device state to the DB, and the next start re-arms the nuisance timers of door/pulldown alarms that were pending, so a door left open across a restart still alarms
- journald capped at 500 MB / 30 days (`infra/journald/modesp.conf`); batch messages logged at `debug`
- StateMap monitoring — device count, total keys, estimated memory usage (logged every 60s)
- Pino structured logging (JSON in production)

### Backups & Maintenance
- Daily archive at 02:00 via `modesp-backup.timer` (`infra/scripts/backup-postgres.sh`): `pg_dump` custom format + roles + `.env`/firmware/TLS/broker config in one tarball with a sha256 manifest; 14-day local retention, optional GPG encryption, off-site rsync with 30-day remote pruning, `last-success` marker; restore runbook in `docs/runbooks/restore.md`
- Row retention by `modesp-retention-cleanup.timer` (`cleanup-weather.js`, `cleanup-aux.js`): weather observations, events, notification log, cleared alarms, expired refresh tokens; every script is a dry-run without `--apply`
- Monthly partition pre-creation (25th of each month)

### Deployment
- systemd service with automatic restart; `Wants=` (not `Requires=`) on PostgreSQL and Mosquitto so a broker or database restart never leaves the backend stopped
- certbot deploy hook (`infra/scripts/tls-deploy-hook.sh`) installs renewed certificates for Mosquitto, reloads instead of restarting, and verifies the served certificate before falling back to a restart
- Nginx reverse proxy with WebSocket upgrade support
- Git-based deploy (`git pull` + `systemctl restart`)

---

## 17. Developer Experience

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
| **Maps** | Leaflet 1.9 + markercluster + heat, OpenStreetMap raster tiles |
| **Geo services** | Nominatim (geocoding), Open-Meteo (weather), OSRM (routing), OpenRouteService (isochrones) — all server-side, all ENV-gated |
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
