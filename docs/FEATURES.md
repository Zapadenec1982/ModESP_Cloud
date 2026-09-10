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
- **Partner plan** (epic 2.5) — a service company on the "Partner" plan creates organisations for its
  own clients (`tenants.parent_tenant_id`), staffs them with its technicians under a per-organisation
  role, sees every client's alarms, work orders, hints and sites on one "Clients" page, and signs into
  any of them in one click. A partner's clients share its billing account (`billing_accounts`) — the
  basis for the consolidated invoice of epic 2.2. Partner A does not see partner B's clients; a client's
  admin does not see the partner's other clients
- **Branding** (plan feature `branding`) — the organisation's name, logo and website on the public site
  status pages and in HACCP reports; a client with no brand of its own shows the partner's
- **Self-registration and trial** (epic 2.1) — `#/register`: an organisation on the "Start" plan with a
  14-day trial and its first administrator, no card. `REGISTRATION_MODE=approve` (the default) holds the
  organisation suspended until a superadmin approves it on the "Organisations" page; `open` starts the
  trial straight away; `off` disables the form. With e-mail configured the administrator confirms the
  address from a link before the first sign-in. An expired trial is moved to `past_due` by the hourly
  watchdog — access and the fleet stay, a banner asks for a plan
- **The "First steps" checklist** — on the administrator's dashboard: create a site → connect a controller
  by its code → invite a technician → link Telegram → export the first HACCP report. The steps are read
  from the data; progress and dismissal live in `tenant_settings.onboarding`
- **Closing an organisation** (epic 2.10) — the `closed` status keeps sign-in but read-only (a banner with
  the date; changes answer 423); after `CLOSED_RETENTION_DAYS` (30) the watchdog deletes telemetry, alarms,
  reports, firmware and sites, returns the controllers to the pending queue with their credentials, and
  keeps the organisation, its users and its invoices
- **Data export** — an administrator orders an archive on the "Settings" page: a CSV per table of the
  organisation with no passwords or tokens, a HACCP report per site for the year, and a manifest; prepared
  in the background, the link lives `EXPORT_TTL_DAYS` (7). A customer may leave with their data
- **Audit without the person** — a deleted user leaves their actions in the audit log but not their
  identity: the e-mail becomes a stable pseudonym, IP and browser disappear; the immutability trigger is
  not switched off to do it
- **An audit log for the administrator** (epic 2.13) — the "Audit log" page is open to an organisation's
  administrator: its own records only, filters by entity, action, user, result and dates, an "support
  actions only" switch, CSV export (the export itself is audited too). A superadmin sees every
  organisation and narrows to one
- **Support sign-in as a user** (epic 2.13) — a superadmin signs in as a user from the organisation card
  or the "Users" page, and must give a reason. It is not a session but a token for `IMPERSONATION_TTL_MIN`
  minutes with no renewal; an orange banner on every page says who, where and until when, and returns to
  the engineer's own account in one click. The record with its reason lands in the audit log of the user's
  organisation, and every action carries the engineer's name beside the user's (the administrator sees a
  "support" mark). Secrets (API keys, webhooks, the MQTT passwords in all four places they are issued,
  public site tokens), account security, creating users and invitations, changing the organisation and
  exporting data are all unavailable under such a token
- **The organisation card** (epic 2.13) — a superadmin sees everything before answering a customer: the
  plan's limits and features, the recent data (controller connectivity, alarms, sign-ins, actions, open
  work orders and hints, imports, reports), the notification channels and whether they deliver, billing,
  60 days of usage, the users with a "Sign in as" button, the latest actions and support requests
- **Support** (epic 2.13) — a sidebar link for any role: contacts (`SUPPORT_EMAIL`, `SUPPORT_TELEGRAM`,
  the documentation), a form with a category, subject, message and diagnostics (organisation, page,
  browser, version, time zone), and a list of requests (own / the organisation's / all, for a superadmin,
  with status changes). The request is stored first and mailed second, with the author's `Reply-To`; it
  works in a closed organisation too

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
- **Critical limits on the equipment** — `haccp_max`/`haccp_min`, the allowed deviation and "what is
  stored" on the device card (the HACCP block of the edit form); the excursion threshold in the
  organisation's and the site's settings; with no limits the log falls back to the controller's alarm
  limits, and with neither it prints "not set"
- **Limits in bulk** — typical limits by what the equipment is for (frozen ≤ −18 ±3, ice cream, chilled
  0…6, meat 0…4, fish 0…2, dairy 2…6, vegetables 2…10, medicines 2…8 ±0; labels in four languages) as a
  starting point: a preset on the device card, the "HACCP limits" bulk action on the dashboard (by default
  only devices with no limits — what an officer typed is never overwritten), and the columns
  `haccp_preset`/`haccp_min`/`haccp_max`/`haccp_tolerance`/`haccp_product` in the network CSV import, so a
  controller arrives from the pending queue with its limits already set
- **The equipment service report** — the engineering counterpart of the HACCP log, from the same data, for
  the technician and the service company (a button next to "HACCP PDF" on the device chart, a report type
  in the site dialog): the appliance's settings from its last state (setpoint, hysteresis, alarm limits and
  delays, defrost, protections — with units), every temperature channel with min/max/average, ΔT and a
  vector chart carrying the critical-limit line, how the equipment worked (compressor duty and starts, the
  longest run, defrost cycles and their length, the door, offline, gaps, HACCP excursions), every alarm
  with its name in the report's language and its work orders, cloud connectivity, maintenance hints, work
  orders and service records, and an engineering log by interval; the same verification code, SHA-256 and
  QR; a separate type in the report archive
- Empty periods answer `404 no_data` instead of producing a blank document

### Scheduled Reports
- **A schedule per site or for the whole network** — weekly (Mon–Sun) or monthly, in the site's time zone;
  at 06:00 the day after the period the report goes to its recipients by e-mail with the PDF attached
- **Three types** — HACCP (the same document as the manual export), alarms (a summary by severity and
  equipment, time to acknowledgement, the log — a week with no alarms is a document too) and energy
  (kWh per device, compressor run time, cost at the tariff)
- **The archive** — the "Reports" page shows everything generated for the organisation: a scheduled PDF can
  be downloaded again (3 years) and every report carries a verification code; a technician and a viewer see
  only their own sites
- **No duplicates** — a schedule remembers the last period it delivered; the "Send now" button produces the
  past period immediately

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
- **Deletion without consequences** — firmware with active jobs or a running rollout cannot be deleted (409);
  finished history stays readable: a job keeps its version even when the file is gone

### Single Device Deploy
- One-click deploy from UI or API
- MQTT command with download URL, version, checksum
- Status tracking: queued → sent → success / failed (10-minute timeout)
- Pre-OTA version captured for reliable success detection via heartbeat
- **Pre-update checks** — the command will not go to a device that is offline, defrosting, carrying an
  active critical alarm, or outside the organisation's update window; the interface names the reason, and
  an administrator may knowingly pass all of them but "offline" (the job is then marked "forced")
- **The update window** — in the organisation's settings: a span of local time (it may cross midnight)
  in which OTA is allowed; empty means any time
- **Rollback** — return a controller to the version it had before the last successful update: the page
  shows the current and previous versions and whether that version is still in the library; such jobs are
  marked "rollback" in the history. Who started each job is recorded (a person or an API key)

### Group Rollout
Plan feature `ota_rollout` — "Pro", Enterprise and "Partner"; every other plan gets
`402 plan_feature`. Single-device deploy stays open to all of them.

- Select firmware + device list → deploy in configurable batches
- **Batch size** — how many devices per wave
- **Batch interval** — seconds between waves (prevent network congestion)
- **Failure threshold** — auto-pause the rollout if the failure rate exceeds the configured percentage
  (set in the form); the reason for the pause (automatic or manual) is visible in the list
- **Deferral, not failure** — a device that is offline, defrosting or in alarm when its batch comes round
  is moved to the next batch; only after 12 deferrals (`OTA_MAX_DEFERRALS`) is the job counted as failed.
  Outside the update window a rollout simply waits
- Admin can resume paused rollouts — the failures they accepted no longer stop it, and the threshold
  watches only new ones
- **Notifications to administrators** — a finished rollout and an automatic pause arrive in Telegram, by
  e-mail and by web push (with a "succeeded / failed on N" summary), and as the webhooks
  `ota.rollout_completed` / `ota.rollout_paused`
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

### Releases and environments
- Tag `vX.Y.Z` → GitHub Release with `modesp-cloud-vX.Y.Z.tar.gz` (+ SHA-256), built only after CI and the empty-database migration check pass (`.github/workflows/release.yml`)
- `infra/deploy.sh init | release | rollback | status`: releases under `/opt/modesp-releases`, secrets in `shared/`, atomic symlink switch, health gate on `/api/health` with automatic rollback; `CHANGELOG.md` is the release text
- Every green `main` is installed on the staging/demo server automatically once `STAGING_HOST` and the SSH key are configured
- Production carries no synthetic data: `purge-demo.js` removes demo organisations, the provisioning scripts refuse `NODE_ENV=production` without `--allow-production`, and a showcase status link (`rate_limit_exempt`) serves the landing page

### Geo services licensing
- Production refuses to start with the public Nominatim endpoint, the OSRM demo server, keyless Open-Meteo or public OSM tile hosts configured (`ALLOW_NONCOMMERCIAL_GEO=true` overrides knowingly); `infra/geo/` runs OSRM and Nominatim on the Ukraine extract in Docker; Open-Meteo uses a paid key on the customer host; tile hosts for the CSP come from `MAP_TILE_HOSTS`
- Weather and the service-round planner are plan features (`weather`, `routing`) of the network, enterprise and partner plans

### Landing page and public pages
- `landing/` (static, no build, own CSP) at `/`: what the controller does, three customer segments, a 30-day chart, a fine-vs-subscription calculator, prices read live from `plan_limits` (`GET /api/public/plans`), a partner page, legal pages generated from `docs/legal`, `robots.txt` and `sitemap.xml`
- Pilot request form → `POST /api/public/pilot-request` (stored in `pilot_requests`, e-mailed to the founder, honeypot-protected); superadmin reads leads at `GET /api/pilot-requests`
- The WebUI moved to `/cloud/`; old `#/…` links are redirected by the landing; the login page links to the terms, privacy policy and platform status; public site pages show the organisation, "Powered by ModESP Cloud", a warning a week before the link expires and a "I want this for my sites" call to action

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

- **900+ integration tests** — Vitest + Supertest against a real PostgreSQL (Docker, tmpfs-backed)
- **Test suites** — auth, RBAC, tenant isolation, CRUD, audit logging, OTA, notifications, billing,
  work orders, maintenance hints, reports, integrations, retention
- **Vite dev server** — frontend hot-reload on port 5173
- **Dev mode** — `AUTH_ENABLED=false` bypasses JWT for rapid development
- **Structured migrations** — 50 numbered SQL migration files, applied in order
- **State metadata** — `state_meta.json` defines all 49 device parameters with types, units, groups, writable flags
- **Checks a test cannot make** — CI also verifies things that stay green while being wrong: the parity of
  the uk/en/pl/de dictionaries and of the two feature files, that `docs/openapi.json` matches the code,
  that `docs/API_REFERENCE.md` lists the endpoints Express mounts, that the firmware upload form sends
  what the route reads, and that a migrated database and a fresh install have the same catalog

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

## 18. Maintenance Hints

The controller decides what an alarm is: it counts compressor starts, run time and defrost
timeouts itself and raises `rapid_cycle_alarm`, `continuous_run_alarm`, `high_temp_alarm` and
the rest. The cloud does not duplicate those thresholds. What the controller cannot see is
history — the same alarm on the same room for the third time this week is no longer a reason
for another acknowledgement, it is a reason for a visit. That is the whole of the single rule
(`maintenance_rules`: a platform value, an organisation override, optionally per equipment model):

| Signal | What is read | What it advises |
|---|---|---|
| A repeating alarm | the same controller alarm code on one device ≥ N times in a window (3 in 7 days by default); `device_offline` does not count | «The controller keeps raising this alarm — it needs a visit: assign a work order» |

- **One hint per device and alarm code** — opens when the counter reaches the threshold, updates
  while the window still holds that many alarms, and closes itself (`resolved`) as soon as the old
  alarms fall out of the window.
- **Lifecycle** — "take it on" (a technician with access to the device), "dismiss" (an admin; the hint
  returns within the hour if the alarms have not gone anywhere), "assign a work order" — a dialog that
  picks the assignee straight from the hint; the history sits on the device tab and in the organisation's list.
- **Notifications** go to administrators as `info` (Telegram, e-mail, web push) with the alarm name,
  the count and the window; a WebSocket `hint` refreshes the dashboard tile and the device-card badge live.
- **Thresholds** (N and the window in days) are edited by the organisation's admin in Settings; the
  platform ones by a superadmin. Plan feature `maintenance` — from the "Site" tariff up.
- **Retention** of closed hints — `MAINTENANCE_HINT_RETENTION_DAYS` (365).

The controller's own counters (`defrost.consecutive_timeouts`, `protection.compressor_starts_1h`,
`protection.compressor_duty`, running hours) are visible on the chart and in the device state — with
no server-side thresholds.

---

## 19. Work Orders

An alarm or a hint becomes a work order; the order has an assignee, a site with an address, a
priority and a schedule; closing it writes a structured service record (who, how long, which parts,
what it cost). It is this chain — alarm → order → visit → record — that lets prevented repairs be
counted, rather than notifications sent.

- **Where they come from** — the "Work order" button next to an alarm, "Create work order" on a hint,
  from the device card, or by hand on the "Work orders" page. Creating one from an alarm acknowledges
  the alarm; from a hint, the hint.
- **Who may do what** — an admin assigns anyone and cancels; a technician takes an order for themselves
  but cannot hand it to a colleague; starting and closing is the assignee or an admin; a viewer only
  sees orders on their own devices.
- **The assignee** gets a notification with the site name, the address and a Google Maps route link
  (Telegram, e-mail, web push); WebSocket keeps the lists live.
- **Closing** — work done, duration, parts (name; quantity; cost), total and currency → `service_records`
  carrying `user_id` and `work_order_id`; the device's older service-record list shows it too.
- **Statistics** — counts by status, how many came from alarms and how many from hints, and the average
  time to assignment, to start and to close over a period.

---

## 20. Billing

An invoice is built from the system's own data, not from a spreadsheet: every hour the platform
records how many controllers, sites and users each organisation has (`usage_snapshots`), and on the
1st it invoices the previous month from the average daily usage × the plan's prices. Payment is by
bank transfer; card payments arrive with the acquiring contract.

- **What is on the invoice** — the plan's subscription (prorated by the days the organisation existed
  that month), controllers at volume prices (from 100 — 80 UAH, from 500 — 60 UAH on "Network"), and
  sites on the "Network" plan. A controller that ran for a week costs a quarter of a month. Plans with
  no price (Enterprise) and zero totals (Start) are not invoiced.
- **A partner** receives one consolidated invoice: the "Partner" subscription plus a "controllers" line
  per client at the partner tariff; the client only sees "invoices go to the partner".
- **PDF and e-mail** — the invoice in the organisation's language (uk/en/pl/de) with the seller's
  details and the payment reference, attached to a letter to `billing_email` (or to the administrators).
- **Dunning** — 7 days past due the organisation becomes "past due" (in-app banner, e-mail), at 14 a
  second reminder, at 21 "suspended" (sign-in and controller data are blocked; the controllers keep
  running on their own). Payment or voiding the invoice restores access automatically.
- **The "Payment" page** for an admin: plan and prices, an estimate for the current month, how to pay,
  the organisation's payment details, invoices with PDFs, usage by month, a plan-change request.
- **"Billing"** for a superadmin: every invoice with filters and the "paid / void / send" actions,
  jobs by hand (snapshot, invoices for a period, dunning), plan-change requests, seller details.
- **Safety catches** — invoices are not issued until the seller's name and a valid IBAN are filled in
  (structure, country length and checksum are checked, so a single wrong digit does not pass), and an
  invoice that was never sent stops at "past due" and never suspends an organisation. The automation
  cannot quietly cut off a fleet over an invoice the customer never saw.

---

## 21. Integrations

Plan epic 2.6: a customer with their own CMMS, BI or ERP connects without a human in between. The
"Integrations" page is for administrators on the "Pro", "Network" and "Partner" plans (plan feature `api`).

- **API keys** — a key of the form `modesp_…` in the same `Authorization: Bearer` header people use.
  Only the hash is stored; the full key is shown once, at creation. A key represents the whole
  organisation — it sees all of its devices, not one person's grants — with "Read" (like a viewer),
  "Write" (like a technician: acknowledging alarms, commands, work orders, service records) or
  "Admin" (sites, models, firmware, OTA) rights. No key ever reaches users, other keys, webhooks,
  organisations, billing, profiles or sessions. Expiry, revocation, "last used"; in the audit log the
  actions are signed `apikey:<name>`.
- **Webhooks** — an HTTP POST to the customer's address on every subscribed event: alarm raised /
  cleared / acknowledged, device offline / online, work order created / updated / assigned / started /
  closed / cancelled, hint opened. The body carries the device, the site and the event's data; the
  headers are `X-ModESP-Event`, `X-ModESP-Delivery`, `X-ModESP-Timestamp` and the signature
  `X-ModESP-Signature: v1=HMAC-SHA256(secret, "<timestamp>.<body>")`, so the receiver can verify
  authenticity and reject replays. Public http(s) addresses only — private networks and localhost
  are refused.
- **Delivery reliability** — a non-2xx response or 10 seconds of silence counts as a failure; retries
  at 1 min, 5 min, 30 min, 2 h, 12 h, after which the delivery is marked undelivered. After 10
  consecutive failures the webhook disables itself until an administrator switches it back on. A
  "Test" button sends a `ping`, the delivery log shows state, attempts, response code and body, any
  delivery can be re-sent, and the secret rotates in one click and is shown only once.
- **Documentation for the integrator** — `GET /api/docs`: an interactive description of the integration
  surface (OpenAPI 3.1, Swagger UI, no external CDNs), including the format of every outgoing webhook
  event, the headers and the signature formula. `docs/openapi.json` is generated from the code and
  checked in CI, so it does not go stale.

---

*ModESP Cloud — from sensor to dashboard in real time.*
