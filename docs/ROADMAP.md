# ModESP Cloud — Roadmap

## Current Status

**Production deployed ✅ — 14 phases complete, ESP32 connected via MQTT+TLS**

Completed: Cloud Foundation, REST API, WebSocket, WebUI, Push Notifications (FCM+Telegram+WebPush), Auth (JWT), History & Analytics, Fleet OTA, i18n (UA/EN), Per-Device RBAC, Scalability, Dynamic MQTT Auth (go-auth), Tenant Management, Multi-Tenant Users, Telegram Bot Redesign, Audit Logging, Test Infrastructure (130+ tests), Platform Hardening (Events API, HACCP Export, Password Change, Alarm Severity), Energy Monitoring.

**Next: Phase 14 — Fleet Benchmarking + Anomaly Detection**

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

---

## Upcoming Phases

### Phase 14: Fleet Benchmarking + Anomaly Detection
**Goal:** Compare similar equipment, automatically detect anomalies.
**Timeline:** 2-3 weeks

- [ ] Fleet baseline service: avg ± 2σ per model for duty_cycle, alarm_freq, temp_deviation
- [ ] Anomaly detector: Z-score > 2.0 → anomaly event + notification
- [ ] REST API: benchmarks, anomalies (per-device + fleet-wide)
- [ ] Fleet Analytics page (new): duty cycle chart, outliers table
- [ ] DeviceDetail: Anomalies tab

**Outcome:** "Refrigerator #7 runs 40% more than average Model X — check door seal."

---

### Phase 15: Webhooks + API Platform
**Goal:** External integrations — CMMS, ERP, automation.
**Timeline:** 1.5-2 weeks

- [ ] Webhook dispatcher: alarm/device/anomaly events, HMAC-SHA256 signature, retry + circuit breaker
- [ ] REST API: CRUD webhooks, test delivery, delivery log
- [ ] API Keys: machine-to-machine auth (alternative to JWT)
- [ ] OpenAPI 3.0 spec → `/api/docs`
- [ ] WebUI: Webhooks page, API Keys page

**Outcome:** Alarm → webhook → CMMS creates work order. Automatically.

---

### Phase 16: Advanced Reporting + PWA
**Goal:** Printable reports for customers, mobile experience.
**Timeline:** 2-3 weeks

> Basic HACCP export (CSV + PDF) already implemented in Phase 11b. This phase extends to scheduled reports and email delivery.

- [ ] New report types: Device Health Report, Fleet Overview, Energy Report
- [ ] Scheduled reports: weekly/monthly generation → email attachment
- [ ] PWA: manifest.json, Service Worker, offline device states, install prompt

**Outcome:** Customer receives PDF report weekly by email. Technician installs PWA on phone.

---

### Phase 17: Maintenance Recommendations
**Goal:** Automatic maintenance recommendations based on data.
**Timeline:** 1.5-2 weeks

- [ ] Rules engine: defrost timeouts → "check heater", duty deviation → "check door seal", compressor hours → "scheduled maintenance"
- [ ] REST API: recommendations per device, dismiss action
- [ ] Push + Webhook events for critical recommendations
- [ ] WebUI: Recommendations tab, dashboard badge

**Outcome:** Platform says: "Refrigerator #3 — clean condenser, efficiency dropped 25%."

---

### Phase 18: Tenant Self-Service + Billing
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
2026 Q2 (Apr-May)                  Q3 (Jun-Aug)                   Q4 (Sep+)
──────────────────────────────────────────────────────────────────────────────
 Phase 14: Benchmarking             Phase 15: Webhooks + API      Phase 18: Self-Service
 └── 2-3 weeks                     └── 1.5-2 weeks              └── 4-6 weeks

                                    Phase 16: Reports + PWA
                                    └── 2-3 weeks

                                    Phase 17: Recommendations
                                    └── 1.5-2 weeks
──────────────────────────────────────────────────────────────────────────────
```

---

## Competitive Position

### Unique Advantages

| Advantage | Details | Closest Competitor |
|-----------|---------|-------------------|
| Deep edge integration | 48 state + 60 command keys, direct control | Axiom (read-only) |
| Fleet OTA with rollback | Board-type validation, batch rollout, auto-pause | Monnit (basic OTA) |
| Zero-touch auto-discovery | Pending → assign → auto-reconnect | None |
| Per-device RBAC | user_devices M:N, not just per-site | None (all per-site) |
| M:N multi-tenant users | Technician serves multiple customers | None |
| Self-hosted | Full data control, ~$20/mo on VPS | Monnit Enterprise (expensive) |
| HACCP Export | CSV + PDF with Cyrillic, regulatory-ready | SmartSense, Monnit |
| Energy Monitoring | Estimated kWh from power profiles, CT clamp ready | Axiom, KLATU, SmartSense |

### Feature Gaps (upcoming)

| Gap | Who Already Has It | Phase |
|-----|-------------------|-------|
| Equipment Health Score | SmartSense, KLATU | Phase 14 |
| Anomaly detection | Axiom, KLATU | Phase 14 |
| Fleet benchmarking | Axiom, SmartSense | Phase 14 |
| Webhooks / API | Monnit, Tive, SmartSense | Phase 15 |
| Scheduled reports | Monnit, SmartSense | Phase 16 |
| Mobile PWA | SmartSense, Monnit | Phase 16 |
| Maintenance recommendations | KLATU, SmartSense | Phase 17 |
| SaaS self-service | All cloud competitors | Phase 18 |

---

## Changelog

- 2026-03-25 — Phase 12 complete: Bulk Device Import (CSV upload with drag-drop, template, batch assign).
- 2026-03-24 — Phase 13 complete: Energy Monitoring (estimated kWh, device models, cost calculation, energy tab).
- 2026-03-15 — Revision: merged ROADMAP + ROADMAP_NEXT, renumbered phases 12-18, removed internal details. Split into EN + UA versions.
- 2026-03-15 — Phase 11 complete: Events API, HACCP Export (CSV+PDF), Password Change (NIST), Alarm Severity (ISA-18.2).
- 2026-03-11 — Phase 8c: Telegram Bot Redesign + UX (auth, RBAC, i18n, persistent keyboard).
- 2026-03-10 — MQTT Auth hardening: go-auth bootstrap fallback, stuck device auto-detection.
- 2026-03-09 — Phases 8a-8b: Tenant Management + Multi-Tenant Users.
- 2026-03-08 — VPS Production Deployment. Phases 6-7 complete (OTA, RBAC, Scalability).
- 2026-03-07 — Project created. Phases 1-5 implemented (Foundation → Analytics).
