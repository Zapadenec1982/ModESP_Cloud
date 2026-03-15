# Roadmap ModESP Cloud

## Поточний стан

**Production deployed ✅ — 11 фаз завершено, 15 міграцій БД, ESP32 підключений через MQTT+TLS**

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
- [ ] npm: `csv-parse` для парсингу CSV
- [ ] WebUI: `ImportModal.svelte` — drag-and-drop, preview, результат (assigned/skipped/errors)
- [ ] WebUI: кнопка "Import CSV" на PendingDevices
- [ ] i18n: import ключі (uk+en)

CSV колонки: mqtt_device_id (обов'язковий), name, serial_number, location, model, comment — ті ж поля що при ручному assign.

**Результат:** Адмін скачує pending список → заповнює метадані в Excel → завантажує назад → 500 пристроїв активовано за хвилину.

---

### Фаза 13: Energy Monitoring + Health Score
**Ціль:** Перетворити сирі дані компресора на бізнес-метрики (kWh, ₴, health score).
**Залежність від firmware:** SCT-013 current sensor → нові state keys. Без firmware — estimated kWh = duty × rated_power.
**Тривалість:** 2-3 тижні

#### Backend
- [ ] Міграція: `devices.rated_power_w`, `devices.energy_rate` (₴/kWh), `devices.health_score` (0-100)
- [ ] Нові telemetry channels: `power_watts`, `energy_kwh` (nullable, тільки з firmware)
- [ ] MQTT handler: нові state keys (`equipment.power_watts`, `equipment.compressor_current`)
- [ ] REST API: `GET /devices/:id/energy?from=&to=` → kWh, вартість, avg power
- [ ] REST API: `GET /fleet/energy` → total kWh, top consumers, cost
- [ ] Health Score calculator (cron, щогодини):
  - alarm_frequency × 5, duty_deviation × 0.3, defrost_timeouts × 10, sensor_error × 20, offline_hours × 2
  - Score = CLAMP(0, 100)
- [ ] REST API: `GET /devices/:id/health`, `GET /fleet/health`
- [ ] WebSocket: health_score change broadcasts

#### WebUI
- [ ] DeviceDetail: Energy tab (kWh chart, cost KPI, power gauge)
- [ ] DeviceDetail: Health Score badge (green/yellow/red)
- [ ] Dashboard: fleet energy summary, DeviceCard health badge, sort by health
- [ ] i18n: energy.*, health.* keys (uk+en)

**Результат:** Клієнт бачить скільки коштує енергія на кожен холодильник і який потребує уваги.

---

### Фаза 14: Fleet Benchmarking + Anomaly Detection
**Ціль:** Порівняння однотипного обладнання, автоматичне виявлення аномалій.
**Тривалість:** 2-3 тижні

#### Backend
- [ ] Fleet baseline service (cron, щоденно): avg ± 2σ по model + tenant для duty_cycle, alarm_freq, temp_deviation
- [ ] Anomaly detector (cron, щогодини): Z-score > 2.0 → anomaly event + notification
- [ ] REST API: `GET /fleet/benchmarks?model=`, `GET /devices/:id/anomalies`, `GET /fleet/anomalies`
- [ ] Push: anomaly detected → notification (debounce 1h)

#### WebUI
- [ ] Fleet Analytics page (нова): bar chart duty cycle, scatter health vs energy, outliers table
- [ ] DeviceDetail: Anomalies tab
- [ ] Dashboard: anomaly count badge
- [ ] i18n: analytics.*, anomaly.* keys (uk+en)

**Результат:** "Холодильник #7 працює на 40% більше ніж середній Model X — перевірте ущільнення дверей."

---

### Фаза 15: Webhooks + API Platform
**Ціль:** Зовнішні інтеграції — CMMS, ERP, автоматизація.
**Тривалість:** 1.5-2 тижні

#### Backend
- [ ] Webhook dispatcher:
  - Events: `alarm.triggered`, `alarm.cleared`, `device.offline`, `device.online`, `anomaly.detected`, `health.critical`, `ota.completed`
  - HMAC-SHA256 signature, retry (3 attempts, exponential backoff), circuit breaker
- [ ] REST API: CRUD `/webhooks`, test delivery, delivery log
- [ ] API Keys: `api_keys` table, API key auth middleware (machine-to-machine)
- [ ] OpenAPI 3.0 spec → `/api/docs`

#### WebUI
- [ ] Webhooks page: table, create/edit/test, delivery log
- [ ] API Keys page (admin): create, revoke, usage stats
- [ ] i18n: webhooks.*, api_keys.* keys (uk+en)

**Результат:** Alarm → webhook → 1С/CMMS створює наряд на ремонт. Автоматично.

---

### Фаза 16: Advanced Reporting + PWA
**Ціль:** Друковані звіти для клієнтів, mobile experience.
**Тривалість:** 2-3 тижні

> Примітка: базовий HACCP export (CSV + PDF) вже реалізований у Phase 11b. Ця фаза розширює до scheduled reports, email delivery, fleet reports.

#### Reports
- [ ] Report types: Device Health Report, Fleet Overview, Energy Report
- [ ] Scheduled reports: `scheduled_reports` table, cron weekly/monthly → email attachment
- [ ] Email service (nodemailer, SMTP)

#### PWA
- [ ] `manifest.json`, Service Worker (workbox)
- [ ] Offline view: cached last device states
- [ ] Install prompt, responsive audit (375px), touch optimizations

**Результат:** Клієнт отримує PDF звіт щотижня на email. Технік встановлює PWA на телефон.

---

### Фаза 17: Maintenance Recommendations
**Ціль:** Автоматичні рекомендації з обслуговування на основі даних.
**Залежність від firmware:** edge analytics keys (опціонально — базові правила працюють без firmware).
**Тривалість:** 1.5-2 тижні

- [ ] Rules engine (configurable):
  - defrost.consecutive_timeouts > 3 → "Перевірте нагрівач відтайки"
  - COP indicator trend +20% за 7d → "Очистіть конденсатор"
  - compressor_hours > 10000 → "Планове ТО компресора"
  - duty_deviation > 30% від baseline → "Перевірте герметичність камери"
  - health_score < 30 протягом 48h → "Потрібен виїзд техніка"
- [ ] REST API: `GET /devices/:id/recommendations`, `POST .../dismiss`
- [ ] Push + Webhook events для critical recommendations
- [ ] WebUI: Recommendations tab, dashboard badge

**Результат:** Платформа каже: "Холодильник #3 — очистіть конденсатор, ефективність впала на 25%."

---

### Фаза 18: Tenant Self-Service + Billing
**Ціль:** SaaS бізнес-модель — клієнти реєструються і платять самостійно.
**Тривалість:** 4-6 тижнів

- [ ] Self-registration: `POST /auth/register` → user + tenant + default plan + email verification
- [ ] Plan enforcement middleware: max_devices, max_users, feature gates
- [ ] Billing integration (LiqPay for UA, Stripe for international)
- [ ] Usage metering: device count, telemetry volume, API calls per tenant
- [ ] WebUI: Registration page, Billing page, plan comparison, invoice history

#### Плани

| Plan | Devices | Users | Features | Price |
|------|---------|-------|----------|-------|
| Free | 3 | 2 | Monitoring, push | $0 |
| Pro | 50 | 10 | + Energy, Health Score, Reports, Webhooks | ~$49/міс |
| Enterprise | ∞ | ∞ | + Anomaly, Recommendations, API Keys, SLA | Custom |

**Результат:** Клієнт реєструється на modesp.com.ua → додає пристрої → платить щомісяця.

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
| Zero-touch auto-discovery | Pending → assign → _set_tenant → auto-reconnect | Ніхто |
| Per-device RBAC | user_devices M:N, не тільки per-site | Ніхто (всі per-site) |
| M:N multi-tenant users | Технік обслуговує кількох клієнтів | Ніхто |
| Self-hosted | Повний контроль даних, ~$20/міс на VPS | Monnit Enterprise (дорого) |
| HACCP Export | CSV + PDF з кирилицею, готовий для регуляторів | SmartSense, Monnit |

### Головні розриви (що ще потрібно)

| Розрив | Хто вже має | Фаза |
|--------|------------|------|
| Енергомоніторинг (kWh) | Axiom, KLATU, SmartSense | Phase 13 |
| Equipment Health Score | SmartSense, KLATU | Phase 13 |
| Anomaly detection | Axiom (digital twin), KLATU (8 патентів) | Phase 14 |
| Fleet benchmarking | Axiom, SmartSense | Phase 14 |
| Webhooks / API integrations | Monnit, Tive, SmartSense | Phase 15 |
| Scheduled reports + email | Monnit, SmartSense, KLATU | Phase 16 |
| Mobile PWA | SmartSense, Monnit (native) | Phase 16 |
| Maintenance recommendations | KLATU, SmartSense | Phase 17 |
| SaaS self-service | Всі хмарні конкуренти | Phase 18 |

---

## Залежності Cloud ↔ Firmware

| Cloud Phase | Firmware Dependency | Обов'язково? |
|-------------|-------------------|--------------|
| Phase 13 (Energy) | SCT-013 current sensor | ⚠️ Для kWh. Без firmware — estimated kWh = duty × rated_power |
| Phase 13 (Health) | Немає | ❌ Всі дані вже є |
| Phase 14 (Anomaly) | Edge analytics keys | ❌ Cloud рахує самостійно |
| Phase 15 (Webhooks) | Немає | ❌ |
| Phase 16 (Reports) | Немає | ❌ |
| Phase 17 (Recommendations) | Adaptive defrost, COP indicator | 🟡 Базові правила працюють без firmware |
| Phase 18 (Billing) | Немає | ❌ |

---

## Метрики успіху

| Метрика | Поточне | Ціль Q3 2026 | Ціль Q4 2026 |
|---------|---------|--------------|--------------|
| Підключених пристроїв | 1 | 20+ | 100+ |
| Тенантів | 1 | 5+ | 15+ |
| Health Score coverage | — | 100% | 100% |
| Anomaly detection | — | Statistical (Z-score) | + recommendations |
| Energy monitoring | — | Estimated kWh | Real kWh (SCT-013) |
| Webhooks | — | 7 event types | + CMMS templates |
| Reports | HACCP CSV/PDF | + 3 report types | + scheduled email |
| PWA | — | Так | + offline mode |
| Paying tenants | 0 | 0 (pilot) | 3-5 |

---

## Ревізія та аналіз конкурентів (2026-03-15)

### Що досліджено
Порівняння з AWS IoT, Azure IoT Hub, ThingsBoard, Blynk, Losant, Danfoss AK-SM 800, Dixell XWEB, Carel BOSS, Axiom Cloud, KLATU Networks, SmartSense, Monnit, Controlant, ELPRO, Tive, Cooltrax, ComplianceMate.

Стандарти: HACCP (Україна, з 2019), NIST SP 800-63B Rev 4, ISA-18.2 (alarm management), OWASP, IEC 62443.

### Що відхилено як over-engineering для поточного масштабу
- **TOTP 2FA** — конкуренти не мають (Dixell: Admin/Admin), IEC 62443 SL 1-2 не вимагає
- **Account lockout** — OWASP: lockout = DoS вектор, rate limiting достатній
- **Device tags/groups** — при <100 пристроях location+model покривають 80-90% потреб
- **Quiet hours** — неприйнятно для холодильного обладнання, HACCP вимагає 24/7
- **Per-alarm-type UI** — severity classification ефективніший ніж 48 чекбоксів

---

## Changelog

- 2026-03-15 — Ревізія: об'єднано ROADMAP.md + ROADMAP_NEXT.md, перенумеровано фази 12-18, видалено дублювання, оновлено стан (11 фаз, 15 міграцій). PDF Reports частково реалізовано в Phase 11b (HACCP Export).
- 2026-03-15 — Phase 11 завершено: Events API, HACCP Export (CSV+PDF), Password Change (NIST), Alarm Severity (ISA-18.2).
- 2026-03-15 — Full platform audit & competitor research. Roadmap restructured based on ROI analysis.
- 2026-03-15 — Documentation: README rewritten for portfolio, FEATURES.md (EN+UA) created.
- 2026-03-11 — Phase 8c: Telegram Bot Redesign + UX (auth, RBAC, i18n, persistent keyboard).
- 2026-03-10 — MQTT Auth hardening: go-auth bootstrap fallback, stuck device auto-detection.
- 2026-03-09 — Phase 8a-8b: Tenant Management + Multi-Tenant Users.
- 2026-03-09 — Phase 4 completion: Dynamic MQTT Auth (mosquitto-go-auth).
- 2026-03-08 — VPS Production Deployment. Phases 6-7 complete (OTA, RBAC, Scalability).
- 2026-03-07 — Project created. Phases 1-5 implemented (Foundation → Analytics).
