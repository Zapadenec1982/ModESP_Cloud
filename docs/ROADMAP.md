# ModESP Cloud — Roadmap

## Current Status

**Production deployed ✅ — 15 phases complete, ESP32 connected via MQTT+TLS**

Completed: Cloud Foundation, REST API, WebSocket, WebUI, Push Notifications (FCM+Telegram+WebPush), Auth (JWT), History & Analytics, Fleet OTA, i18n (UA/EN), Per-Device RBAC, Scalability, Dynamic MQTT Auth (go-auth), Tenant Management, Multi-Tenant Users, Telegram Bot Redesign, Audit Logging, Test Infrastructure (130+ tests), Platform Hardening (Events API, HACCP Export, Password Change, Alarm Severity), Energy Monitoring, Sites & Geographic Intelligence.

**Next: Phase 15 — Fleet Benchmarking + Anomaly Detection**

---

## Production Blockers

Items that must be closed before the platform serves paying customers — independent of the feature phases below.

- [ ] **Purchase or self-host the third-party geo services.** Nominatim (geocoding), Open-Meteo (weather), OSRM (routing), OpenRouteService (isochrones) and the OpenStreetMap tile server are all used under their free / non-commercial terms for the demo deployment. ModESP Cloud is a commercial product, so each one needs a paid plan or a self-hosted instance. Checklist and per-service options: `docs/THIRD_PARTY_LICENSING.md`

---

## Completed Phases

### Phase 1: Cloud Foundation ✅
Core infrastructure — ESP32 connects to cloud, data is persisted.

- Firmware changes (ModESP_v4): NVS tenant field, prefix builder, heartbeat, `_set_tenant` handler
- VPS (Ubuntu 24), Mosquitto (ACL + TLS), PostgreSQL schema
- MqttService: topic parsing, state aggregation (48 keys), alarm detector, telemetry sampler (5 min), event detector
- Nginx HTTPS, systemd services, cron backup, telemetry partitioning

### Phase 2: Remote Monitoring WebUI ✅
Technician sees all controller states from anywhere in the world.

- WebSocket (real-time delta broadcasts per tenant)
- REST API (devices, telemetry, alarms, commands)
- Svelte WebUI: Dashboard, DeviceDetail, PendingDevices
- Auto-discovery UI (pending → assign)

### Phase 3: Push Notifications ✅
Technician receives alarm notifications instantly.

- Push orchestrator with debouncing and channel registry
- FCM + Telegram Bot + Web Push (VAPID)
- REST API: subscribers CRUD, test send, delivery log
- WebUI: Notifications page

### Phase 4: Auth & User Management ✅
Multiple technicians, multiple organizations, access control.

- JWT (login, refresh token rotation, logout), 4 roles (superadmin/admin/technician/viewer)
- User CRUD, WebSocket JWT auth, WebUI Login/Users pages
- mosquitto-go-auth with PostgreSQL ACL (replaces static ACL)
- MQTT Bootstrap Provisioning: shared bootstrap → unique credentials on assign
- Stuck device auto-detection (120s grace → auto-reset)
- Device lifecycle: soft-reset (active→pending) + hard-delete

### Phase 5: History & Analytics ✅
Trend analysis, equipment degradation detection.

- Telemetry stats: bucketed aggregation (5m/15m/1h/6h/1d), alarm stats, fleet summary
- uPlot TelemetryChart, AlarmHistory table, fleet summary bar
- PostgreSQL monthly partitioning, 90-day retention

### Phase 6: Fleet OTA ✅
Firmware updates across all devices without on-site visits.

- Firmware upload (SHA256 checksum), single deploy + group rollout with batching
- Auto-pause on failure threshold, board compatibility check
- ModESP_v4 OTA handler: HTTP download → SHA256 → flash → reboot (~8s E2E)
- WebUI: Firmware page (upload, deploy, rollout monitoring)

### Phase 6.5: WebUI Polish ✅
User-friendly UI for technicians.

- i18n (UA + EN), Light/Dark theme
- Device metadata (model, comment, manufactured_at), service records
- DeviceDetail edit modal, search by all fields

### Phase 7: RBAC + Scalability ✅
Scaling to 5000+ devices, per-device access control.

- **7a:** Per-Device RBAC — filterDeviceAccess + checkDeviceAccess middleware, WebSocket per-device check
- **7b:** Scalability — DB pool (30), batch state writer, heartbeat dedup, event batching, WS backpressure (64KB)
- **7c:** Frontend RBAC — isAdmin/canWrite stores, conditional UI, route guards, device assignment modal
- **7d:** OTA Board Compatibility — firmware.board_type, deploy validation, rollout filtering

### Phase 8a: Tenant Management ✅
Superadmin role, cross-tenant operations.

- Tenants CRUD API, device reassign (MQTT creds rotation + _set_tenant via old slug)
- Tenants WebUI page, DeviceDetail "Change Tenant" modal

### Phase 8b: Multi-Tenant User Memberships ✅
One user belongs to multiple tenants (M:N).

- user_tenants junction table, pendingToken flow
- Login → tenant picker → select-tenant / switch-tenant
- WebUI: tenant switcher in sidebar, Users manage tenants modal

### Phase 8c: Telegram Bot Redesign ✅
Full-featured Telegram bot with authentication and RBAC.

- User auth via link code, 7 commands, per-device RBAC
- Multi-tenant support (/tenant switch)
- Alarm raised + cleared + device offline notifications with location
- Persistent reply keyboard, i18n UA/EN, chat cleanup

### Phase 9: Audit Logging ✅
Compliance-ready audit of all mutations.

- audit_log table (immutability trigger, 4 indexes)
- Middleware: auto-capture POST/PUT/PATCH/DELETE (fire-and-forget)
- 15 enrichment points (req.auditContext with before/after changes)
- WebUI: AuditLog page (filters, pagination, JSON diff)

### Phase 10: Test Infrastructure ✅
130+ integration tests on real PostgreSQL.

- Vitest 3.2 + Supertest + Docker Compose (PostgreSQL 5433, tmpfs)
- 15 test suites: auth, RBAC, tenant isolation, CRUD, audit, OTA, notifications
- Test helpers: app.js, factories.js, migration runner

### Phase 11: Platform Hardening & Compliance ✅
Closing gaps identified during audit — HACCP, NIST, ISA-18.2.

- **11a:** Events API + Chart Overlay (compressor/defrost/alarm events on telemetry chart)
- **11b:** HACCP Data Export — CSV (telemetry, devices, alarms) + PDF report (pdfmake, Cyrillic)
- **11c:** Password Change UI + NIST policy (15-char min, HaveIBeenPwned k-anonymity check)
- **11d:** Alarm Severity Classification (critical/warning/info, nuisance delays, severity filter)

### Phase 12: Bulk Device Import ✅ (2026-03-25)
Mass onboarding of devices via CSV upload.

- CSV import modal with drag-and-drop, preview table, target tenant selector
- Download CSV template with headers (mqtt_device_id, name, serial_number, location, model, comment, manufactured_at)
- Batch assign: find pending → set metadata → provision MQTT credentials → assign to tenant
- Result summary: assigned/skipped/errors per row
- "Batch Registration" button on PendingDevices page

### Phase 13: Energy Monitoring ✅ (2026-03-24)
Estimated energy consumption based on equipment model power profiles.

- device_models table with power profiles (compressor/defrost/fan/standby watts)
- Telemetry sampler calculates estimated kWh from compressor/defrost/fan state x rated power
- Energy telemetry channel (`energy`) stored alongside temperature channels
- Per-device power overrides (devices.power_overrides JSONB)
- Cost calculation with configurable electricity rate per tenant
- Energy summary API: `GET /devices/:id/energy/summary` (kWh, cost, breakdown)
- Device Models CRUD API: `GET/POST/PATCH/DELETE /device-models`
- Energy tab on Device Detail page + energy channel on telemetry chart
- Forward-compatible: reserved `equipment.energy_kwh` MQTT key for CT clamp sensors (auto-detect metered vs estimated)

### Phase 14: Sites & Geographic Intelligence ✅ (2026-08-23)
Trade points as first-class objects — and everything a service organisation actually does with a map.

- `sites` table (migration 021): country / region / city / street address / postal code per trade point, backfilled from `devices.location`; `devices.site_id` links devices to sites, and per-device coordinates stay an optional override on top of the site's
- Server-side geocoding proxy (Nominatim): serialized 1 req/s pacer, two-lane priority queue (interactive over bulk), persistent cache with separate lifetimes for hits and misses, and a country sanity check that rejects a result contradicting the requested country
- Fleet map rebuilt: clustered site markers, full filter bar (country / region / city / site / model / firmware / status / user / bbox), alarm heatmap layer, coverage isochrones labelled as approximate without an ORS key
- Geo Analytics page: country → region → city → site drill-down with device, alarm, temperature, uptime, energy and service-visit metrics, plus CSV export
- Service round planner: OSRM travelling-salesman ordering, route polyline, per-leg distance/duration, Google Maps hand-off — degrades to nearest-neighbour ordering when no routing server is configured
- Nearest technicians to a site by home base (`users.base_latitude` / `base_longitude`), enriched with real driving time when routing is available; technicians edit their own base via `/api/profile`
- Outdoor weather per site (Open-Meteo) with 395-day history, outdoor-temperature overlay on the telemetry chart, and automatic IANA timezone per site from the same response
- Site-level RBAC (`user_sites`): grant a whole site instead of individual devices; effective access is the union with `user_devices`, tenant-scoped on both sides
- Public read-only site status links (`site_public_links`): token stored only as sha256, delivered in a request header, mandatory expiry, revocable, and an indistinguishable 404 for revoked / expired / unknown
- CSV import extended with `site_name`, `country`, `region`, `city`, `address_line`
- All four external services are ENV-gated, called server-side only, and degrade to a working disabled state — see `docs/THIRD_PARTY_LICENSING.md`

---

## Upcoming Phases

### Phase 15: Fleet Benchmarking + Anomaly Detection
**Goal:** Compare similar equipment, automatically detect anomalies.
**Timeline:** 2-3 weeks

- [ ] Fleet baseline service: avg ± 2σ per model for duty_cycle, alarm_freq, temp_deviation
- [ ] Anomaly detector: Z-score > 2.0 → anomaly event + notification
- [ ] REST API: benchmarks, anomalies (per-device + fleet-wide)
- [ ] Fleet Analytics page (new): duty cycle chart, outliers table
- [ ] DeviceDetail: Anomalies tab

**Outcome:** "Refrigerator #7 runs 40% more than average Model X — check door seal."

---

### Phase 16: Webhooks + API Platform
**Goal:** External integrations — CMMS, ERP, automation.
**Timeline:** 1.5-2 weeks

- [ ] Webhook dispatcher: alarm/device/anomaly events, HMAC-SHA256 signature, retry + circuit breaker
- [ ] REST API: CRUD webhooks, test delivery, delivery log
- [ ] API Keys: machine-to-machine auth (alternative to JWT)
- [ ] OpenAPI 3.0 spec → `/api/docs`
- [ ] WebUI: Webhooks page, API Keys page

**Outcome:** Alarm → webhook → CMMS creates work order. Automatically.

---

### Phase 17: Advanced Reporting + PWA
**Goal:** Printable reports for customers, mobile experience.
**Timeline:** 2-3 weeks

> Basic HACCP export (CSV + PDF) already implemented in Phase 11b. This phase extends to scheduled reports and email delivery.

- [ ] New report types: Device Health Report, Fleet Overview, Energy Report
- [ ] Scheduled reports: weekly/monthly generation → email attachment
- [ ] PWA: manifest.json, Service Worker, offline device states, install prompt

**Outcome:** Customer receives PDF report weekly by email. Technician installs PWA on phone.

---

### Phase 18: Maintenance Recommendations
**Goal:** Automatic maintenance recommendations based on data.
**Timeline:** 1.5-2 weeks

- [ ] Rules engine: defrost timeouts → "check heater", duty deviation → "check door seal", compressor hours → "scheduled maintenance"
- [ ] REST API: recommendations per device, dismiss action
- [ ] Push + Webhook events for critical recommendations
- [ ] WebUI: Recommendations tab, dashboard badge

**Outcome:** Platform says: "Refrigerator #3 — clean condenser, efficiency dropped 25%."

---

### Phase 19: Tenant Self-Service + Billing
**Goal:** SaaS business model — customers register and pay independently.
**Timeline:** 4-6 weeks

- [ ] Self-registration with email verification
- [ ] Plan enforcement: max devices, max users, feature gates
- [ ] Billing integration (LiqPay / Stripe)
- [ ] Usage metering: devices, telemetry volume, API calls
- [ ] WebUI: Registration, Billing, plan comparison, invoices

| Plan | Devices | Users | Features | Price |
|------|---------|-------|----------|-------|
| Free | 3 | 2 | Monitoring, push | $0 |
| Pro | 50 | 10 | + Energy, Health Score, Reports, Webhooks | ~$49/mo |
| Enterprise | ∞ | ∞ | + Anomaly, Recommendations, API Keys, SLA | Custom |

**Outcome:** Customer registers → adds devices → pays monthly.

---

## Visual Roadmap

```
2026 Q3 (Sep)                      Q4 (Oct-Dec)                   2027 Q1
──────────────────────────────────────────────────────────────────────────────
 Phase 15: Benchmarking             Phase 16: Webhooks + API      Phase 19: Self-Service
 └── 2-3 weeks                     └── 1.5-2 weeks              └── 4-6 weeks

                                    Phase 17: Reports + PWA
                                    └── 2-3 weeks

                                    Phase 18: Recommendations
                                    └── 1.5-2 weeks
──────────────────────────────────────────────────────────────────────────────
```

---

## Competitive Position

### Positioning (shipped features only)

Compared against the two families a refrigeration service contractor actually evaluates: the controller vendor's own cloud (CAREL boss/tERA, Danfoss Alsense, Copeland/Dixell XWEB, Eliwell TelevisGo) and sensor-overlay SaaS (SmartSense, Efento, GlacierGrid, local integrators).

| Capability | OEM controller clouds | Sensor overlays | ModESP Cloud today |
|---|---|---|---|
| Data source | Controller data via a per-site supervisor box (USD 600–3,900) | Air temperature from add-on sensors | 49 controller state keys + 61 command keys, no supervisor box |
| Pricing | Quote-only, via distributors | Published per-sensor/site prices | Published UAH/EUR price list (see docs/BUSINESS_ANALYSIS_SAAS_UA.md §5) |
| Service-company model | Per-customer accounts | Per-customer accounts | One technician login across many customer tenants (M:N), per-device **and** per-site grants |
| Fleet OTA | Vendor-managed | n/a | Batch rollouts with board-type validation and auto-pause; image rollback happens on the device, cloud-side "deploy previous version" is planned (plan epic 2.8) |
| Device onboarding | Installer-configured | App pairing | Auto-discovery: pending → assign → auto-reconnect; claim codes planned (epic 1.7) |
| HACCP records | Included | Included, long retention | Per-device CSV/PDF for up to 31 days; inspection-grade localised report and 13+ month retention planned (epic 1.9) |
| Energy | Metered on some models | Rarely | Estimated kWh from power profiles, CT-clamp key reserved |
| Geo / field service | Site list | Site list | Sites, clustered map, alarm heatmap, geo drill-down, nearest technicians, service-round planner, outdoor weather overlay |
| Customer-facing status | Account required | Account required | Read-only per-site public link (hashed token, mandatory expiry, revocable) |
| Self-hosting | No | No | Possible under a separate commercial licence only (see COMMERCIAL-LICENSE.md); the public repository is PolyForm Noncommercial |

### Feature Gaps (upcoming)

| Gap | Who Already Has It | Phase |
|-----|-------------------|-------|
| Equipment Health Score | SmartSense, KLATU | Phase 15 |
| Anomaly detection | Axiom, KLATU | Phase 15 |
| Fleet benchmarking | Axiom, SmartSense | Phase 15 |
| Webhooks / API | Monnit, Tive, SmartSense | Phase 16 |
| Scheduled reports | Monnit, SmartSense | Phase 17 |
| Mobile PWA | SmartSense, Monnit | Phase 17 |
| Maintenance recommendations | KLATU, SmartSense | Phase 18 |
| SaaS self-service | All cloud competitors | Phase 19 |

---

## Changelog

- 2026-08-23 — Phase 14 complete: Sites & Geographic Intelligence (sites + geocoding, fleet map with clustering/heatmap/isochrones, geo analytics, service round planner, outdoor weather, site-level RBAC, public status links). Upcoming phases renumbered 14-18 → 15-19. Third-party geo licensing added as a production blocker.
- 2026-03-25 — Phase 12 complete: Bulk Device Import (CSV upload with drag-drop, template, batch assign).
- 2026-03-24 — Phase 13 complete: Energy Monitoring (estimated kWh, device models, cost calculation, energy tab).
- 2026-03-15 — Revision: merged ROADMAP + ROADMAP_NEXT, renumbered phases 12-18, removed internal details. Split into EN + UA versions.
- 2026-03-15 — Phase 11 complete: Events API, HACCP Export (CSV+PDF), Password Change (NIST), Alarm Severity (ISA-18.2).
- 2026-03-11 — Phase 8c: Telegram Bot Redesign + UX (auth, RBAC, i18n, persistent keyboard).
- 2026-03-10 — MQTT Auth hardening: go-auth bootstrap fallback, stuck device auto-detection.
- 2026-03-09 — Phases 8a-8b: Tenant Management + Multi-Tenant Users.
- 2026-03-08 — VPS Production Deployment. Phases 6-7 complete (OTA, RBAC, Scalability).
- 2026-03-07 — Project created. Phases 1-5 implemented (Foundation → Analytics).
