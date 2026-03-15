# Roadmap ModESP Cloud

## Поточний стан

**Production deployed ✅ — 11 фаз завершено, ESP32 підключений через MQTT+TLS**

Завершено: Cloud Foundation, REST API, WebSocket, WebUI, Push (FCM+Telegram+WebPush), Auth (JWT), History & Analytics, Fleet OTA, i18n (UA/EN), Per-Device RBAC, Scalability, Dynamic MQTT Auth (go-auth), Tenant Management, Multi-Tenant Users, Telegram Bot Redesign, Audit Logging, Test Infrastructure (130+ тестів), Platform Hardening (Events API, HACCP Export, Password Change, Alarm Severity).

**Next: Phase 12 — Bulk Device Import**

---

## Завершені фази

### Фаза 1: Cloud Foundation ✅
Базова інфраструктура — ESP32 підключається до хмари, дані зберігаються.

- Firmware changes (ModESP_v4): NVS tenant field, prefix builder, heartbeat, `_set_tenant` handler
- VPS (Ubuntu 24), Mosquitto (ACL + TLS), PostgreSQL schema
- MqttService: topic parsing, state aggregation (48 keys), alarm detector, telemetry sampler (5хв), event detector
- Nginx HTTPS, systemd services, cron backup, telemetry partitioning

### Фаза 2: Remote Monitoring WebUI ✅
Технік бачить стан всіх контролерів з будь-якої точки світу.

- WebSocket (real-time delta broadcasts per tenant)
- REST API (devices, telemetry, alarms, commands)
- Svelte WebUI: Dashboard, DeviceDetail, PendingDevices
- Auto-discovery UI (pending → assign)

### Фаза 3: Push Notifications ✅
Технік отримує сповіщення про аварії миттєво.

- Push orchestrator з debouncing і channel registry
- FCM + Telegram Bot + Web Push (VAPID)
- REST API: subscribers CRUD, test send, delivery log
- WebUI: Notifications page

### Фаза 4: Auth & User Management ✅
Кілька техніків, кілька організацій, контроль доступу.

- JWT (login, refresh token rotation, logout), 4 ролі (superadmin/admin/technician/viewer)
- CRUD користувачів, WebSocket JWT auth, WebUI Login/Users pages
- mosquitto-go-auth з PostgreSQL ACL (замість static ACL)
- MQTT Bootstrap Provisioning: shared bootstrap → unique credentials on assign
- Stuck device auto-detection (120s grace → auto-reset)
- Device lifecycle: soft-reset (active→pending) + hard-delete

### Фаза 5: History & Analytics ✅
Аналіз трендів, виявлення деградації обладнання.

- Telemetry stats: bucketed aggregation (5m/15m/1h/6h/1d), alarm stats, fleet summary
- uPlot TelemetryChart, AlarmHistory table, fleet summary bar
- PostgreSQL partitioning по місяцях, 90-day retention

### Фаза 6: Fleet OTA ✅
Оновлення прошивки на всіх пристроях без виїзду на об'єкт.

- Firmware upload (SHA256 checksum), single deploy + group rollout з batching
- Auto-pause on failure threshold, board compatibility check
- ModESP_v4 OTA handler: HTTP download → SHA256 → flash → reboot (~8s E2E)
- WebUI: Firmware page (upload, deploy, rollout monitoring)

### Фаза 6.5: WebUI Polish ✅
Зручний UI для техніків.

- i18n (UA + EN), Light/Dark theme
- Device metadata (model, comment, manufactured_at), service records
- DeviceDetail edit modal, search by all fields

### Фаза 7: RBAC + Scalability ✅
Масштабування до 5000+ пристроїв, per-device access control.

- **7a:** Per-Device RBAC — filterDeviceAccess + checkDeviceAccess middleware, WebSocket per-device check
- **7b:** Scalability — DB pool (30), batch state writer, heartbeat dedup, event batching, WS backpressure (64KB)
- **7c:** Frontend RBAC — isAdmin/canWrite stores, conditional UI, route guards, device assignment modal
- **7d:** OTA Board Compatibility — firmware.board_type, deploy validation, rollout filtering

### Фаза 8a: Tenant Management ✅
Superadmin role, cross-tenant операції.

- Tenants CRUD API, device reassign (MQTT creds rotation + _set_tenant via old slug)
- Tenants WebUI page, DeviceDetail "Change Tenant" modal

### Фаза 8b: Multi-Tenant User Memberships ✅
Один користувач належить кільком тенантам (M:N).

- user_tenants junction table, pendingToken flow
- login → tenant picker → select-tenant / switch-tenant
- WebUI: tenant switcher в sidebar, Users manage tenants modal

### Фаза 8c: Telegram Bot Redesign ✅
Повноцінний Telegram бот з авторизацією і RBAC.

- User auth через link code, 7 команд, per-device RBAC
- Multi-tenant support (/tenant switch)
- Alarm raised + cleared + device offline notifications з location
- Persistent reply keyboard, i18n UA/EN, chat cleanup

### Фаза 9: Audit Logging ✅
Compliance-ready аудит всіх мутацій.

- audit_log таблиця (immutability trigger, 4 індекси)
- Middleware: auto-capture POST/PUT/PATCH/DELETE (fire-and-forget)
- 15 enrichment points (req.auditContext з before/after changes)
- WebUI: AuditLog page (фільтри, пагінація, JSON diff)

### Фаза 10: Test Infrastructure ✅
130+ integration тестів на реальній PostgreSQL.

- Vitest 3.2 + Supertest + Docker Compose (PostgreSQL 5433, tmpfs)
- 15 test suites: auth, RBAC, tenant isolation, CRUD, audit, OTA, notifications
- Test helpers: app.js, factories.js, migration runner

### Фаза 11: Platform Hardening & Compliance ✅
Закриття гепів виявлених ревізією — HACCP, NIST, ISA-18.2.

- **11a:** Events API + Chart Overlay (compressor/defrost/alarm events on telemetry chart)
- **11b:** HACCP Data Export — CSV (telemetry, devices, alarms) + PDF report (pdfmake, Cyrillic)
- **11c:** Password Change UI + NIST policy (15-char min, HaveIBeenPwned k-anonymity check)
- **11d:** Alarm Severity Classification (critical/warning/info, nuisance delays, severity filter)

---

## Наступні фази

### Фаза 12: Bulk Device Import
**Ціль:** Масове додавання 50-1000 пристроїв одним CSV файлом замість ручного assign по одному.
**Тривалість:** 3-5 днів

- [ ] `POST /api/devices/import` — CSV upload, per-row: знайти pending → assign + MQTT creds
- [ ] `GET /api/devices/pending/export` — експорт pending списку в CSV (заповнити в Excel → re-upload)
- [ ] `GET /api/devices/import/template` — порожній CSV шаблон з заголовками
- [ ] WebUI: `ImportModal.svelte` — drag-and-drop, preview, результат (assigned/skipped/errors)
- [ ] WebUI: кнопка "Import CSV" на PendingDevices

**Результат:** Адмін скачує pending список → заповнює метадані в Excel → завантажує назад → 500 пристроїв активовано за хвилину.

---

### Фаза 13: Energy Monitoring + Health Score
**Ціль:** Перетворити сирі дані компресора на бізнес-метрики (kWh, ₴, health score).
**Тривалість:** 2-3 тижні

#### Backend
- [ ] Нові telemetry channels: power_watts, energy_kwh
- [ ] REST API: `GET /devices/:id/energy` → kWh, вартість, avg power
- [ ] REST API: `GET /fleet/energy` → total kWh, top consumers, cost
- [ ] Health Score calculator (cron, щогодини): alarm frequency, duty deviation, sensor errors, offline hours → score 0-100
- [ ] REST API: `GET /devices/:id/health`, `GET /fleet/health`

#### WebUI
- [ ] DeviceDetail: Energy tab (kWh chart, cost KPI)
- [ ] DeviceDetail: Health Score badge (green/yellow/red)
- [ ] Dashboard: fleet energy summary, sort by health score

**Результат:** Клієнт бачить скільки коштує енергія на кожен холодильник і який потребує уваги.

---

### Фаза 14: Fleet Benchmarking + Anomaly Detection
**Ціль:** Порівняння однотипного обладнання, автоматичне виявлення аномалій.
**Тривалість:** 2-3 тижні

- [ ] Fleet baseline service: avg ± 2σ по model для duty_cycle, alarm_freq, temp_deviation
- [ ] Anomaly detector: Z-score > 2.0 → anomaly event + notification
- [ ] REST API: benchmarks, anomalies (per-device + fleet-wide)
- [ ] Fleet Analytics page (нова): duty cycle chart, outliers table
- [ ] DeviceDetail: Anomalies tab

**Результат:** "Холодильник #7 працює на 40% більше ніж середній Model X — перевірте ущільнення дверей."

---

### Фаза 15: Webhooks + API Platform
**Ціль:** Зовнішні інтеграції — CMMS, ERP, автоматизація.
**Тривалість:** 1.5-2 тижні

- [ ] Webhook dispatcher: alarm/device/anomaly events, HMAC-SHA256 signature, retry + circuit breaker
- [ ] REST API: CRUD webhooks, test delivery, delivery log
- [ ] API Keys: machine-to-machine auth (alternative to JWT)
- [ ] OpenAPI 3.0 spec → `/api/docs`
- [ ] WebUI: Webhooks page, API Keys page

**Результат:** Alarm → webhook → CMMS створює наряд на ремонт. Автоматично.

---

### Фаза 16: Advanced Reporting + PWA
**Ціль:** Друковані звіти для клієнтів, mobile experience.
**Тривалість:** 2-3 тижні

> Базовий HACCP export (CSV + PDF) вже реалізований у Phase 11b. Ця фаза розширює до scheduled reports і email delivery.

- [ ] Нові типи звітів: Device Health Report, Fleet Overview, Energy Report
- [ ] Scheduled reports: weekly/monthly generation → email attachment
- [ ] PWA: manifest.json, Service Worker, offline device states, install prompt

**Результат:** Клієнт отримує PDF звіт щотижня на email. Технік встановлює PWA на телефон.

---

### Фаза 17: Maintenance Recommendations
**Ціль:** Автоматичні рекомендації з обслуговування на основі даних.
**Тривалість:** 1.5-2 тижні

- [ ] Rules engine: defrost timeouts → "перевірте нагрівач", duty deviation → "перевірте герметичність", compressor hours → "планове ТО"
- [ ] REST API: recommendations per device, dismiss action
- [ ] Push + Webhook events для critical recommendations
- [ ] WebUI: Recommendations tab, dashboard badge

**Результат:** Платформа каже: "Холодильник #3 — очистіть конденсатор, ефективність впала на 25%."

---

### Фаза 18: Tenant Self-Service + Billing
**Ціль:** SaaS бізнес-модель — клієнти реєструються і платять самостійно.
**Тривалість:** 4-6 тижнів

- [ ] Self-registration з email verification
- [ ] Plan enforcement: max devices, max users, feature gates
- [ ] Billing integration (LiqPay / Stripe)
- [ ] Usage metering: devices, telemetry volume, API calls
- [ ] WebUI: Registration, Billing, plan comparison, invoices

| Plan | Devices | Users | Можливості | Ціна |
|------|---------|-------|------------|------|
| Free | 3 | 2 | Моніторинг, push | $0 |
| Pro | 50 | 10 | + Energy, Health Score, Reports, Webhooks | ~$49/міс |
| Enterprise | ∞ | ∞ | + Anomaly, Recommendations, API Keys, SLA | Custom |

**Результат:** Клієнт реєструється → додає пристрої → платить щомісяця.

---

## Візуальна дорожня карта

```
2026 Q2 (квітень-травень)          Q3 (червень-серпень)           Q4 (вересень+)
──────────────────────────────────────────────────────────────────────────────
 Phase 12: Bulk Import              Phase 15: Webhooks + API      Phase 18: Self-Service
 └── 3-5 днів                      └── 1.5-2 тижні              └── 4-6 тижнів

 Phase 13: Energy + Health          Phase 16: Reports + PWA
 └── 2-3 тижні                     └── 2-3 тижні

 Phase 14: Benchmarking             Phase 17: Recommendations
 └── 2-3 тижні                     └── 1.5-2 тижні
──────────────────────────────────────────────────────────────────────────────
```

---

## Конкурентна позиція

### Унікальні переваги ModESP Cloud

| Перевага | Деталі | Найближчий конкурент |
|----------|--------|---------------------|
| Глибина edge-інтеграції | 48 state + 60 command keys, direct control | Axiom (read-only) |
| Fleet OTA з rollback | Board-type валідація, batch rollout, auto-pause | Monnit (basic OTA) |
| Zero-touch auto-discovery | Pending → assign → auto-reconnect | Ніхто |
| Per-device RBAC | user_devices M:N, не тільки per-site | Ніхто (всі per-site) |
| M:N multi-tenant users | Технік обслуговує кількох клієнтів | Ніхто |
| Self-hosted | Повний контроль даних, ~$20/міс на VPS | Monnit Enterprise (дорого) |
| HACCP Export | CSV + PDF з кирилицею, готовий для регуляторів | SmartSense, Monnit |

### Головні розриви (що ще потрібно)

| Розрив | Хто вже має | Фаза |
|--------|------------|------|
| Енергомоніторинг (kWh) | Axiom, KLATU, SmartSense | Phase 13 |
| Equipment Health Score | SmartSense, KLATU | Phase 13 |
| Anomaly detection | Axiom, KLATU | Phase 14 |
| Fleet benchmarking | Axiom, SmartSense | Phase 14 |
| Webhooks / API | Monnit, Tive, SmartSense | Phase 15 |
| Scheduled reports | Monnit, SmartSense | Phase 16 |
| Mobile PWA | SmartSense, Monnit | Phase 16 |
| Maintenance recommendations | KLATU, SmartSense | Phase 17 |
| SaaS self-service | Всі хмарні конкуренти | Phase 18 |

---

## Changelog

- 2026-03-15 — Ревізія: об'єднано ROADMAP + ROADMAP_NEXT, перенумеровано фази 12-18, прибрано внутрішні деталі (firmware залежності, бізнес-метрики, відхилені рішення).
- 2026-03-15 — Phase 11 завершено: Events API, HACCP Export (CSV+PDF), Password Change (NIST), Alarm Severity (ISA-18.2).
- 2026-03-15 — Documentation: README rewritten for portfolio, FEATURES.md (EN+UA) created.
- 2026-03-11 — Phase 8c: Telegram Bot Redesign + UX (auth, RBAC, i18n, persistent keyboard).
- 2026-03-10 — MQTT Auth hardening: go-auth bootstrap fallback, stuck device auto-detection.
- 2026-03-09 — Phase 8a-8b: Tenant Management + Multi-Tenant Users.
- 2026-03-09 — Phase 4 completion: Dynamic MQTT Auth (mosquitto-go-auth).
- 2026-03-08 — VPS Production Deployment. Phases 6-7 complete (OTA, RBAC, Scalability).
- 2026-03-07 — Project created. Phases 1-5 implemented (Foundation → Analytics).
