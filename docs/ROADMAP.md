# Roadmap ModESP Cloud

## Поточний стан

**Production deployed ✅ — 10 phases complete, ESP32 connected, MQTT+TLS, OTA, Multi-Tenant, RBAC, Telegram Bot, Audit Logging, 130+ Tests**

**Next: Phase 11 — Platform Hardening & Compliance (Events API, HACCP Export, Password UI, Alarm Severity)**

---

## Фази розробки

### Фаза 1: Cloud Foundation
**Ціль:** Базова інфраструктура. ESP32 підключається до хмари, дані зберігаються.

**Firmware changes (ModESP_v4) — prerequisite:**
- [x] NVS config: tenant_slug field
- [x] Prefix builder: `modesp/v1/{tenant}/{device}` format
- [x] Heartbeat publish (JSON metadata, кожні 30с)
- [x] `_set_tenant` command handler (auto-discovery)
- [x] HTTP API `/api/mqtt`: tenant field
- [x] Тестування: compile, flash, verify MQTT topics

**Cloud infrastructure:**
- [x] VPS налаштування (Ubuntu 24, firewall, fail2ban)
- [x] Mosquitto broker з ACL і TLS — конфіги готові
- [x] PostgreSQL: базова схема (tenants, devices, alarms, telemetry, events)
- [x] Node.js: MqttService (підписка, topic parsing, state aggregation)
- [x] Node.js: State Map (in-memory accumulation 48 keys per device)
- [x] Node.js: Alarm Detector (protection.* transition detection)
- [x] Node.js: Telemetry Sampler (5хв server-side sampling → DB)
- [x] Node.js: Event Detector (compressor on/off, defrost transitions)
- [x] Node.js: healthcheck endpoint
- [x] State metadata registry (state_meta.json з ModESP_v4)
- [x] Nginx: HTTPS термінація — конфіг готовий
- [x] systemd юніти для всіх сервісів
- [x] Базовий моніторинг (journald + cron backup + telemetry partition timer)

**Результат:** ESP32 публікує individual keys, cloud агрегує, зберігає в БД.

---

### Фаза 2: Remote Monitoring WebUI
**Ціль:** Технік бачить стан всіх контролерів з будь-якої точки світу.

- [x] Node.js: WebSocket сервер (real-time delta broadcasts per tenant)
- [x] Node.js: REST API (GET /devices, GET /devices/:id, telemetry, alarms)
- [x] Node.js: Command translation (REST → MQTT individual keys)
- [x] Svelte: хмарний WebUI (окремий від ESP32 WebUI)
- [x] Svelte: список пристроїв з online/offline статусом
- [x] Svelte: перегляд стану контролера в реальному часі
- [x] Svelte: auto-discovery UI (pending devices list, assign to tenant)
- [x] Svelte: розгортання через Nginx

**Результат:** Повноцінний віддалений моніторинг без додаткового обладнання.

---

### Фаза 3: Push Notifications
**Ціль:** Технік отримує сповіщення про аварії миттєво.

- [x] Node.js: Push orchestrator (push.js) з debouncing і channel registry
- [x] Node.js: FCM інтеграція (firebase-admin, stale token auto-cleanup)
- [x] Node.js: Telegram Bot (long-polling, /start /stop /status /devices, UA messages)
- [x] Маршрутизація: alarm transition → підписники цього пристрою (tenant-scoped)
- [x] REST API: CRUD /api/notifications/subscribers, test send, delivery log
- [x] DB: notification_subscribers + notification_log tables (migration 002)
- [x] WebUI: Notifications page (subscribers table, add form, delivery log)

**Результат:** Push на телефон і Telegram при будь-якій аварії.

---

### Фаза 4: User Management
**Ціль:** Кілька техніків, кілька організацій, контроль доступу.

- [x] Node.js: JWT авторизація (login, refresh token rotation, logout)
- [x] Node.js: CRUD користувачів (admin-only + self-service /me)
- [x] Ролі: superadmin / admin / technician / viewer
- [x] Прив'язка пристроїв до користувачів (user_devices)
- [x] WebSocket: JWT auth через `?token=` query param
- [x] WebUI: Login page, protected routing, Users page (admin)
- [x] AUTH_ENABLED toggle (backward-compatible, default: false)
- [x] seed-admin.js script
- [x] Mosquitto: mosquitto-go-auth з PostgreSQL backend (замість static ACL)
- [x] MQTT Bootstrap Provisioning: shared bootstrap → unique credentials on assign
- [x] REST API: generate/rotate/revoke MQTT credentials per device
- [x] WebUI: credentials feedback on assign, MQTT auth status on DeviceDetail
- [x] provision-mqtt-creds.js: migration script for existing devices
- [x] go-auth bootstrap fallback: deleted/stuck devices reconnect via shared bootstrap password (migration 011)
- [x] ACL fix: handle MOSQ_ACL_SUBSCRIBE ($2=4) in aclquery — devices can subscribe to cmd/+ topics
- [x] Stuck device auto-detection: backend resets devices publishing to wrong tenant after 120s grace
- [x] Device lifecycle: DELETE soft-reset (active→pending) + hard-delete (pending), POST /devices/register

**Результат:** Мультитенантна система з ізольованим доступом і zero-touch provisioning.

---

### Фаза 5: History & Analytics
**Ціль:** Аналіз трендів, виявлення деградації обладнання.

- [x] REST API: телеметрія по часовому діапазону (from/to ISO + hours)
- [x] REST API: агрегована статистика (min/max/avg per bucket: 5m/15m/1h/6h/1d)
- [x] REST API: статистика аварій (count, avg_duration per alarm_code)
- [x] REST API: fleet summary (devices_total, online, alarms_active, alarms_24h)
- [x] WebUI: графіки температур (uPlot — TelemetryChart.svelte)
- [x] WebUI: історія аварій (AlarmHistory.svelte)
- [x] WebUI: fleet summary bar на Dashboard
- [x] Партиціонування телеметрії по місяцях (ensure-partitions.js)

**Результат:** Аналітика для прийняття рішень про обслуговування.

---

### Фаза 6: Fleet OTA
**Ціль:** Оновлення прошивки на всіх пристроях без виїзду на об'єкт.

- [x] **ModESP_v4:** MQTT OTA handler (cmd/_ota → HTTP download → SHA256 → flash → reboot, ~8s E2E)
- [x] REST API: завантаження firmware файлів (multer, SHA256 checksum)
- [x] REST API: запуск OTA на окремому пристрої
- [x] Груповий rollout з batch_size і інтервалом
- [x] Відстеження статусу OTA по парку (periodic checker, heartbeat version detection)
- [x] Автоматичний rollback при масовому збої (auto-pause on fail threshold)
- [x] WebUI: сторінка управління firmware (upload, deploy, rollout monitoring)

**Результат:** Zero-touch оновлення парку з будь-якої точки світу.

---

### Фаза 6.5: WebUI Polish & Device Management
**Ціль:** Зручний UI для техніків: i18n, theming, повне керування метаданими пристрою.

- [x] WebUI: i18n система (UK + EN) з Svelte store + locale switcher
- [x] WebUI: Light theme toggle (CSS custom properties `[data-theme="light"]`)
- [x] DB: нові колонки devices (model, comment, manufactured_at) — migration 005
- [x] DB: service_records таблиця (технік, причина, роботи) — migration 005
- [x] REST API: PATCH /devices/:id (name, location, serial_number, model, comment, manufactured_at)
- [x] REST API: CRUD /devices/:id/service-records (GET, POST, DELETE)
- [x] REST API: GET /devices/:id повертає users з доступом (user_devices JOIN)
- [x] WebUI: DeviceDetail — edit modal (6 полів), users with access, manufactured_at
- [x] WebUI: DeviceDetail — Service tab (записи обслуговування, додавання, видалення)
- [x] WebUI: DeviceCard — model в footer
- [x] WebUI: Dashboard — пошук по model, serial_number
- [x] WebUI: PendingDevices — model/serial в assign modal

**Результат:** Повна картка пристрою з редагуванням, сервісною історією, двома мовами і темами.

---

### Фаза 7: RBAC + Scalability
**Ціль:** Масштабування до 5000+ пристроїв, per-device access control для техніків/viewers.

#### 7a: Per-Device RBAC (Backend) ✅
- [x] Міграція 006: audit columns (granted_by, granted_at) + indexes для user_devices
- [x] Middleware: `filterDeviceAccess()` для list-ендпоінтів (GET /devices, GET /alarms, GET /fleet/summary)
- [x] Middleware: `checkDeviceAccess()` для single-device ендпоінтів (один JOIN запит)
- [x] Всі device routes: per-device access check (devices, telemetry, alarms, service-records)
- [x] Fleet summary: фільтрація по assigned devices для non-admin
- [x] WebSocket: per-device access check при subscribe
- [x] Users API: GET /users/:id/devices, PUT /users/:id/devices (bulk replace)
- [x] POST /users/:id/devices: tenant verification + granted_by
- [x] grant-all-devices.js: одноразовий скрипт для backward compatibility
- [x] schema.sql: оновлено user_devices з audit columns + indexes

#### 7b: Backend Scalability ✅
- [x] DB Pool: max=30 (env configurable), statement_timeout=30s
- [x] Batch state writer (N queries → 1 multi-row UPDATE via VALUES)
- [x] Heartbeat write dedup (firmware_version тільки при зміні, _lastFw cache)
- [x] Event INSERT batching (буфер + flush щосекунди, flush on shutdown)
- [x] Telemetry retention (cleanup-telemetry.js — drop партицій >90 днів)
- [x] Telemetry query LIMIT 10000 + X-Truncated header
- [x] WebSocket backpressure (bufferedAmount > 64KB → skip)
- [x] StateMap monitoring (device count, total keys, approx MB, event buffer — every 60s)

#### 7c: Frontend RBAC ✅
- [x] Stores: isAdmin, canWrite derived stores
- [x] Conditional UI: edit/command/service buttons hidden for viewer, ParameterEditor readonly
- [x] Route guards: /users, /firmware, /pending → admin only (svelte-spa-router wrap)
- [x] Device Assignment UI: checklist modal на Users page (search, select all/none, bulk PUT)
- [x] i18n: нові ключі для RBAC (uk.js + en.js)

#### 7d: OTA Board Compatibility ✅
- [x] Міграція 007: firmwares.board_type column + index
- [x] Firmware upload з board_type (optional, NULL = universal)
- [x] OTA deploy: board validation (firmware.board_type vs device.model, 400 on mismatch)
- [x] Rollout: фільтрація eligible devices по board (incompatible skipped)
- [x] OTA command payload: includes board_type for device-side verification
- [x] Firmware WebUI: board select on upload, board column in library, compatibility info in deploy modal, incompatible devices disabled

**Результат:** Безпечна мультикористувацька система з per-device access control.

---

### Фаза 8a: Tenant Management ✅
**Ціль:** Повноцінне управління тенантами через WebUI, superadmin роль для cross-tenant операцій.

#### Дворівнева модель ролей
- Platform: `superadmin` → бачить всі тенанти, CRUD, reassign devices
- Tenant: `admin` → керує своїм тенантом, `technician` → assigned devices, `viewer` → read-only

#### Backend
- [x] Міграція 009: superadmin role (users_role_check constraint)
- [x] Auth middleware: superadmin inherits admin, requireSuperadmin(), cross-tenant bypass
- [x] Device-access middleware: superadmin bypass для filterDeviceAccess + checkDeviceAccess
- [x] Tenants CRUD API (routes/tenants.js): GET, POST, PATCH, DELETE з Zod валідацією
- [x] GET /tenants повертає device_count + user_count (superadmin: всі, admin: свій)
- [x] POST /devices/:id/reassign — transaction: UPDATE device, DELETE user_devices, rotate MQTT creds, send _set_tenant + _set_mqtt_creds via OLD slug
- [x] GET /devices/:id — superadmin cross-tenant access, JOIN tenants for tenant_slug
- [x] POST /devices/pending/:mqttId/assign — superadmin can assign to any tenant via tenant_id body param
- [x] seed-admin.js: --role flag (default: admin), parameterized role INSERT
- [x] mqtt.js: export refreshRegistries + updateDeviceStateMap

#### WebUI
- [x] Stores: isSuperAdmin derived store, isAdmin/canWrite include superadmin
- [x] API: getTenants, createTenant, updateTenant, deleteTenant, reassignDevice
- [x] Sidebar: tenants nav item (admin + superadmin)
- [x] App.svelte: /tenants route з admin guard
- [x] Tenants.svelte: table + create/edit/delete modals, auto-slug, plan, active toggle
- [x] DeviceDetail: "Change Tenant" button + modal (superadmin only)
- [x] PendingDevices: tenant dropdown при assign (superadmin)
- [x] i18n: tenants.*, role_superadmin, device.change_tenant, pending.target_tenant (uk+en)

**Результат:** Superadmin може створювати тенантів, переносити пристрої між ними, керувати всією платформою.

---

### Фаза 8b: Multi-Tenant User Memberships ✅
**Ціль:** Один користувач належить кільком тенантам (M:N). Технік обслуговує обладнання кількох клієнтів.

**Патерн:** Active Tenant (WorkOS/Clerk/AWS) — junction table `user_tenants`, JWT тримає один `tenantId`, перемикання мінтить новий JWT. Всі ~44 SQL запити з `WHERE tenant_id` залишаються без змін.

#### Backend
- [x] Міграція 010: `user_tenants` junction table (M:N) + seed від `users.tenant_id`
- [x] Auth service: `generatePendingToken()` / `verifyPendingToken()` (JWT без tenantId, 5хв)
- [x] POST /auth/login: multi-tenant detection → `require_tenant_select` + pending_token
- [x] POST /auth/select-tenant: завершення логіну після вибору тенанту
- [x] POST /auth/switch-tenant: перемикання тенанту (новий JWT pair, superadmin bypass)
- [x] POST /auth/refresh: повертає `tenants` array для frontend
- [x] GET /users: повертає `user.tenants[]` array з усіма членствами
- [x] POST /users: також INSERT в user_tenants
- [x] GET/POST/DELETE /users/:id/tenants — CRUD membership (superadmin only)

#### WebUI
- [x] Stores: `currentTenant`, `availableTenants`, `hasMultipleTenants`
- [x] API: `selectTenant()`, `switchTenant()`, `addUserTenant()`, `removeUserTenant()`
- [x] Login: tenant selection step (cards з аватаром, slug, last-used default)
- [x] Sidebar: tenant switcher widget (dropdown, поточний тенант, перемикання → reload)
- [x] Users: multi-tenant badges, "Manage Tenants" modal (add/remove chips)
- [x] i18n: auth.select_workspace, auth.switch_workspace, users.manage_tenants (uk+en)

**Результат:** Технік логіниться → бачить picker тенантів → працює в одному → перемикається через sidebar.

---

### Фаза 8c: Telegram Bot Redesign ✅
**Ціль:** Повноцінний Telegram бот з авторизацією, RBAC, моніторинг + розширені сповіщення.

#### Backend
- [x] Міграція 012: `telegram_link_code`, `telegram_link_expires` колонки + indexes
- [x] telegram.js: повне переписування — user auth через link code, 7 команд (/start, /devices, /status, /alarms, /tenant, /unlink, /help)
- [x] telegram.js: RBAC — admin бачить все, viewer/technician тільки assigned devices (user_devices)
- [x] telegram.js: multi-tenant support (/tenant switch + in-memory context)
- [x] telegram.js: extended send() — 3 типи повідомлень (alarm raised, alarm cleared, device offline)
- [x] push.js: alarm cleared notifications (видалено `if (!evt.active) return`)
- [x] push.js: device offline push (2 хв delay, cancel on reconnect)
- [x] push.js: user-based dispatch (dispatchToLinkedUsers + RBAC per user)
- [x] push.js: duplicate prevention (linked users excluded from legacy subscribers)
- [x] users.js: 3 нові endpoints (POST/DELETE /me/telegram-link, POST /:id/telegram-link)

#### WebUI
- [x] api.js: generateTelegramLink, generateMyTelegramLink, unlinkMyTelegram
- [x] Users.svelte: Telegram column (linked badge / link button)
- [x] Users.svelte: Telegram link modal (code + /start instructions)
- [x] i18n: telegram keys (uk+en)

#### Telegram Bot UX (Phase 8c.1) ✅
- [x] Persistent reply keyboard (📦 Пристрої / 🚨 Аварії / 🔀 Тенант / EN↔UA)
- [x] Interactive device buttons (tap device → detailed status with location)
- [x] i18n (UA/EN) — full bilingual support with per-chat language preference
- [x] Language switch button (persistent keyboard)
- [x] Chat cleanup (auto-delete old messages on navigation)
- [x] NaN temperature fix (isFinite guard on all Number().toFixed() calls)
- [x] Device location on status page and in all notification types (alarm raised, alarm cleared, offline)
- [x] Removed inline menu/refresh/back buttons — cleaner UX
- [x] `setMyCommands` for Telegram command autocomplete
- [x] Superadmin cross-tenant bypass for device/alarm API routes

**Результат:** Telegram бот з авторизацією, per-device доступом, i18n, зручною навігацією через persistent keyboard і сповіщеннями з локацією.

---

### Фаза 9: Audit Logging ✅
**Ціль:** Compliance-ready аудит всіх мутацій для безпеки та прозорості.

- [x] Міграція 015: `audit_log` таблиця (BIGSERIAL, immutability trigger, 4 індекси)
- [x] Middleware `audit.js`: авто-перехоплення POST/PUT/PATCH/DELETE (fire-and-forget INSERT)
- [x] Auto-derive `action` + `entity_type` з req.baseUrl + req.method
- [x] Збагачення через `req.auditContext` (entityId, before/after changes) — 15 enrichment points
- [x] Route `GET /api/audit-log` (superadmin only, filterable, paginated)
- [x] WebUI: AuditLog.svelte (фільтри, пагінація, before/after diff)
- [x] i18n: audit keys (uk+en)

**Результат:** Superadmin бачить хто що зробив, коли, з якими змінами.

---

### Фаза 10: Test Infrastructure ✅
**Ціль:** Повноцінна тестова інфраструктура + критичні security-тести.

- [x] Vitest 3.2 + Supertest + Docker Compose test profile (PostgreSQL 5433, tmpfs)
- [x] Test helpers: app.js, factories.js, migration runner
- [x] 15 test suites, 130+ integration тестів (auth, RBAC, tenant isolation, CRUD, audit)
- [x] Legacy 20 unit тестів збережено

**Результат:** `npm test` → 130+ тестів за 15 секунд на реальній PostgreSQL.

---

### Фаза 11: Platform Hardening & Compliance
**Ціль:** Закрити реальні гепи виявлені ревізією (2026-03-15). Пріоритизовано за ROI на основі аналізу конкурентів (Danfoss AK-SM, Dixell XWEB, Carel BOSS), стандартів (HACCP, NIST SP 800-63B Rev 4, ISA-18.2, OWASP) та реального масштабу платформи.

#### 11a: Events API & Device Activity Log
**Обґрунтування:** Дані events вже пишуться в БД (~150/день/пристрій: compressor on/off, defrost, online/offline), але немає жодного endpoint'у для читання. Частота циклів компресора — головний діагностичний показник.

- [ ] `GET /api/devices/:id/events` — query з `from`, `to`, `type`, `limit` фільтрами
- [ ] WebUI: Events tab в DeviceDetail (таблиця з фільтрами, хронологія подій)
- [ ] i18n: events ключі (uk+en)

**Результат:** Технік бачить історію роботи обладнання — цикли компресора, дефрости, перепідключення.

#### 11b: HACCP Data Export (CSV + PDF)
**Обґрунтування:** HACCP обов'язковий в Україні з 20.09.2019 (Держпродспоживслужба). Форма 498-10/о вимагає журнал реєстрації температурного режиму. Всі конкуренти (Danfoss, Dixell, Carel) мають export. Без цього платформа не є повноцінним рішенням для холодильного обладнання.

- [ ] `GET /api/telemetry/:deviceId/export?from=&to=&format=csv` — CSV download температурних даних
- [ ] `GET /api/devices/export?format=csv` — CSV інвентаризація пристроїв
- [ ] `GET /api/alarms/export?from=&to=&format=csv` — CSV export алармів
- [ ] `GET /api/telemetry/:deviceId/export?format=pdf` — PDF compliance report (HACCP температурний лог)
- [ ] PDF: заголовок (організація, пристрій, діапазон дат), таблиця (час, температура), min/max/avg summary
- [ ] WebUI: кнопки "Export CSV" / "Export PDF" на TelemetryChart, Alarms, Dashboard
- [ ] npm: `pdfkit` або `puppeteer` для генерації PDF
- [ ] i18n: export ключі (uk+en)

**Результат:** Адмін натискає "Export" → отримує файл для інспектора Держпродспоживслужби або внутрішнього аудиту.

#### 11c: Password Change UI + NIST-aligned Password Policy
**Обґрунтування:** Backend PUT /users/me вже є, але UI відсутній. NIST SP 800-63B Rev 4 (2025): мінімум 15 символів, НЕ вимагати complexity rules, перевіряти через breach databases.

- [ ] WebUI: "Change Password" модалка з sidebar меню (old/new/confirm, НЕ окрема сторінка)
- [ ] Backend: збільшити мінімум пароля до 15 символів (NIST-aligned)
- [ ] Backend: HaveIBeenPwned k-anonymity API check при створенні/зміні пароля
- [ ] Backend: НЕ додавати complexity rules (NIST явно забороняє)
- [ ] i18n: password change ключі (uk+en)

**Результат:** Юзер може змінити пароль через UI. Слабкі/скомпрометовані паролі відхиляються.

#### 11d: Alarm Severity Classification
**Обґрунтування:** ISA-18.2 визначає alarm fatigue як >10 алармів за 10 хв. 2/3 операторів BMS ігнорують сповіщення. Не всі аларми рівні: high_temp = CRITICAL (продукт псується), door_alarm = INFO (нормальна операція). Конкуренти (Danfoss, Copeland) мають Alarm Action Matrix.

- [ ] Backend mqtt.js: severity рівні на ALARM_KEYS (critical / warning / info)
- [ ] Backend push.js: severity-aware dispatch (critical = завжди, warning = configurable, info = тільки in-app)
- [ ] Backend push.js: time-delay для nuisance алармів (door_alarm 3хв, pulldown 5хв після дефросту)
- [ ] DB migration: `alarm_severity` поле або lookup table
- [ ] WebUI Alarms: severity badge (колір/іконка)
- [ ] API: severity filter на GET /alarms

**Результат:** Техніки отримують лише важливі сповіщення. Критичні аларми (температура) — завжди, операційні (двері) — з затримкою.

---

### Фаза 12: Bulk Device Import
**Ціль:** Масове додавання 50-1000 пристроїв одним CSV файлом замість ручного assign по одному.

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

### Фаза 13: REST API + OpenAPI (ERP Integration)
**Ціль:** Зовнішні системи можуть отримувати статус пристроїв, підписуватись на події.
**Статус: ВІДКЛАДЕНО** — реалізувати коли з'явиться перший клієнт з запитом на інтеграцію.
**Обґрунтування відкладення:** 1С в Україні не інтегрується з IoT-сенсорами програмно. Жоден клієнт не запитує API. Мінімальна реалізація (API key + endpoints) = 4-6 годин коли знадобиться.

- [ ] `api_keys` таблиця (tenant_id, key_hash, name, created_at, last_used_at, active)
- [ ] API key middleware (`X-API-Key` header, SHA-256 hash, rate limiting)
- [ ] Expose existing endpoints під API key auth
- [ ] Webhooks: alarm events, device online/offline (HMAC-SHA256 signed)
- [ ] OpenAPI 3.0 spec (YAML) — Swagger UI

**Результат:** Зовнішня система отримує дані через API або webhook.

---

### Фаза 14: Advanced Analytics (майбутнє)
- [ ] ML моделі для предиктивного обслуговування
- [ ] Виявлення аномалій (порівняння з нормою по флоту)
- [ ] Автоматичні рекомендації: "конденсатор потребує чистки"

---

## Ревізія та аналіз конкурентів (2026-03-15)

### Що досліджено
Порівняння з AWS IoT, Azure IoT Hub, ThingsBoard, Blynk, Losant, Danfoss AK-SM 800, Dixell XWEB, Carel BOSS. Аналіз стандартів: HACCP (Україна, з 2019), NIST SP 800-63B Rev 4, ISA-18.2 (alarm management), OWASP, IEC 62443.

### Що підтверджено як реальна потреба
- **HACCP data export** — обов'язковий за законодавством, всі конкуренти мають
- **Events API** — дані пишуться, але недоступні (dead data)
- **Password change UI** — backend є, UI немає
- **Alarm severity** — ISA-18.2 підтверджує alarm fatigue як реальну проблему
- **NIST password policy** — мінімум 15 символів, breach check, НЕ complexity rules

### Що відхилено як over-engineering для поточного масштабу
- **TOTP 2FA** — конкуренти не мають (Dixell: Admin/Admin), IEC 62443 SL 1-2 не вимагає, 40-60 год розробки для 10 юзерів
- **Account lockout** — OWASP: lockout = DoS вектор, rate limiting достатній, для 10 юзерів з компресорами lockout = операційний ризик
- **Device tags/groups** — при <100 пристроях location+model покривають 80-90% потреб, PostgreSQL TEXT[] = 2 год коли знадобиться
- **API keys / ERP** — жоден клієнт не запитує, 1С не інтегрується з IoT
- **Quiet hours** — неприйнятно для холодильного обладнання, HACCP вимагає 24/7 реакції
- **Per-alarm-type UI** — 48 чекбоксів ніхто не налаштує правильно, severity classification ефективніший
- **Timezone per-user** — Україна = 1 часовий пояс
- **Dedicated Settings page** — модалка достатня для <50 юзерів (ThingsBoard, Blynk так само)

### Аудит кодової бази — знахідки
- **Критичних: 0** ✅
- Console.log у фронтенді (12 шт) — всі навмисні з [WS]/[Auth] префіксами, не debug
- schema.sql не синхронізований з міграціями — косметично, тести працюють (schema + migrations)
- Дублювання request()/requestFull() в api.js — low priority refactor

---

## Залежності між проектами

### ModESP_v4 → Phase 1 (firmware changes)
- [x] NVS: `tenant` field (string, max 32)
- [x] Prefix: `modesp/v1/{tenant}/{device}` (або `modesp/v1/pending/{device}`)
- [x] Heartbeat: JSON metadata кожні 30с (~100 bytes, stack buffer)
- [x] `_set_tenant` command: save to NVS → reconnect
- [x] HTTP API: tenant field в GET/POST `/api/mqtt`
- [x] RAM overhead: ≤ 2KB (80KB вільної залишиться ≥ 78KB)

### ModESP_v4 → Phase 6 (MQTT OTA) ✅
- [x] Підписка на `cmd/_ota` з URL firmware
- [x] HTTP download → esp_ota_begin/write/end (з SHA256, magic byte, board match)
- [x] Publish OTA status/progress (_ota.status, _ota.progress, _ota.error)
- [x] Partition table: otadata + ota_0 + ota_1 (rollback support)
- [x] E2E тест: download → verify → flash → reboot ~8 сек

---

## Changelog

- 2026-03-07 — Створено. 7 фаз розробки, залежності з ModESP_v4.
- 2026-03-07 — Оновлено. Phase 1 деталізовано під реальний MQTT протокол (individual keys, state aggregation, server-side sampling). Firmware changes як prerequisite.
- 2026-03-07 — Phase 1 cloud code: backend scaffolding, schema.sql, db.js, mqtt.js, index.js, state_meta.json, unit tests (20/20). Firmware changes позначено [x].
- 2026-03-07 — Phase 2: REST API (devices, telemetry, alarms, commands), WebSocket (real-time state), Svelte WebUI (Dashboard, DeviceDetail, PendingDevices). Протестовано з ESP32 F27FCD.
- 2026-03-07 — Phase 3: Push notifications — push.js orchestrator, telegram.js (UA), fcm.js, notifications REST API, WebUI Notifications page. Graceful skip when tokens not configured.
- 2026-03-07 — Phase 4: Auth & User Management — auth.js service, JWT middleware, login/refresh/logout routes, users CRUD, seed-admin script, WebSocket JWT, WebUI Login/Users pages, AUTH_ENABLED toggle.
- 2026-03-07 — Phase 5: History & Analytics — telemetry stats (bucketed aggregation), alarm stats, fleet summary API, uPlot TelemetryChart, AlarmHistory table, Dashboard fleet summary bar, ensure-partitions.js.
- 2026-03-07 — Phase 6: Fleet OTA (cloud side) — firmware upload/list/delete, OTA deploy + group rollout with batching, ota.js service (status checker, auto-pause), sendJsonCommand QoS 1, Firmware WebUI page, migration 003.
- 2026-03-08 — Phase 6 complete: ModESP_v4 OTA handler (ota_handler.cpp) — E2E verified. Partition table fix (otadata + ota_1 for rollback).
- 2026-03-08 — Phase 6.5: WebUI polish — i18n (UK+EN), light/dark theme, device metadata (model, comment, manufactured_at), editing, service records, search by all fields.
- 2026-03-08 — Phase 7a: Per-Device RBAC (backend) — migration 006, device-access middleware (filterDeviceAccess + checkDeviceAccess), all device/telemetry/alarm/fleet routes protected, WebSocket per-device check, users GET/PUT devices (bulk), grant-all-devices.js migration script.
- 2026-03-08 — Phase 7b: Backend Scalability — DB pool max=30 + statement_timeout, batch state writer (N→1 query), heartbeat write dedup, event INSERT batching (1s flush), cleanup-telemetry.js (90-day retention), telemetry LIMIT 10000, WS backpressure (64KB), StateMap monitoring (60s stats).
- 2026-03-08 — Phase 7c: Frontend RBAC — isAdmin/canWrite derived stores, conditional UI (edit/command/service hidden for viewer, ParameterEditor readonly), route guards (admin-only pages via svelte-spa-router wrap), device assignment modal on Users page (search, select all/none, bulk PUT), i18n keys (uk+en).
- 2026-03-08 — Phase 7d: OTA Board Compatibility — migration 007 (firmwares.board_type), firmware upload with board_type, deploySingle board mismatch check (400), createRollout filters incompatible devices, OTA payload includes board_type, Firmware WebUI board awareness (select on upload, column in library, compatibility in deploy modal).
- 2026-03-08 — VPS Production Deployment: backend (modesp-backend.service), WebUI via Nginx, MQTT bidirectional, OTA E2E confirmed, admin + viewer accounts, ESP32 connected and operational.
- 2026-03-08 — VPS Ops: cron backup (PostgreSQL daily 2:00, retention 30d), telemetry cleanup (daily 3:00, >90d), telemetry partition timer (systemd, 25th monthly). Phase 1 моніторинг — ✅.
- 2026-03-09 — Phase 4 completion: Dynamic MQTT Auth — mosquitto-go-auth + PostgreSQL (migration 008, mqtt-auth.js service, REST API for credentials lifecycle, bootstrap provisioning in mqtt.js, mosquitto.conf rewrite with per_listener_settings + SQL ACL, provision-mqtt-creds.js migration script, WebUI credentials feedback on assign + MQTT auth status on DeviceDetail, i18n uk+en).
- 2026-03-09 — Phase 8a: Tenant Management — superadmin role (migration 009), tenants CRUD API, device reassign endpoint, Tenants WebUI page, DeviceDetail "Change Tenant" modal, PendingDevices tenant select for superadmin, isSuperAdmin store, seed-admin --role flag, i18n (uk+en).
- 2026-03-09 — Phase 8b: Multi-Tenant User Memberships — migration 010 (user_tenants M:N), pendingToken flow, login/select-tenant/switch-tenant endpoints, tenant membership CRUD, frontend tenant picker on login, sidebar tenant switcher, Users manage tenants modal, i18n (uk+en).
- 2026-03-10 — MQTT Auth hardening: go-auth bootstrap fallback (migration 011 mqtt_bootstrap table), device lifecycle (soft-reset active→pending, hard-delete pending, POST /devices/register), stuck device auto-detection (120s grace → auto-reset), ACL fix for MOSQ_ACL_SUBSCRIBE ($2=4), QoS 1 for _set_tenant/_set_mqtt_creds. Full assign flow E2E verified with emulator.
- 2026-03-10 — Roadmap: додано Phase 9a (Bulk CSV Import) і Phase 9b (REST API + OpenAPI для ERP). Advanced Analytics перенесено в Phase 10.
- 2026-03-10 — Bugfix session: reset-to-pending ordering (MQTT commands before DB change), heartbeat empty payload guard, credential key standardization (user/pass), go-auth cache fix (300s→5s — root cause of assign loop after credential rotation).
- 2026-03-11 — Phase 8c: Telegram Bot Redesign — migration 012 (telegram_link_code/expires), telegram.js full rewrite (user auth, 7 commands, RBAC, multi-tenant), push.js rewrite (alarm cleared, device offline with 2min delay, user-based dispatch, duplicate prevention), users.js 3 new endpoints, WebUI Telegram column + link modal, i18n (uk+en).
- 2026-03-11 — Phase 8c.1: Telegram Bot UX — persistent reply keyboard, i18n UA/EN with per-chat preference, interactive device status buttons, chat cleanup (auto-delete), NaN temperature fix, device location in status page and all notification types, removed inline menu/refresh/back buttons, setMyCommands, superadmin cross-tenant bypass in device/alarm routes.
- 2026-03-15 — Documentation refactoring: README rewritten for portfolio (EN), AGENTS.md updated, ARCHITECTURE_INTERNAL.md synced, docs updated.
- 2026-03-15 — Access control fixes: Pending Devices sidebar visibility (admin-only), Firmware page access for technicians (view+deploy assigned, admin-only: upload/delete/rollout), user hard delete with FK cleanup.
- 2026-03-15 — Full platform audit & competitor research. Compared with AWS IoT, ThingsBoard, Danfoss AK-SM 800, Dixell XWEB, Carel BOSS. Analyzed HACCP (UA law), NIST 800-63B Rev 4, ISA-18.2, OWASP, IEC 62443. Roadmap restructured: Phase 11 (Platform Hardening — events API, HACCP export, password UI, alarm severity), Phase 12 (Bulk Import), Phase 13 (API keys — deferred), Phase 14 (Analytics). Rejected: TOTP 2FA, account lockout, device tags, quiet hours, dedicated Settings page — all over-engineering at current scale.
