# Roadmap ModESP Cloud

## Поточний стан

**Фаза 6: Fleet OTA — реалізовано (cloud side)**

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
- [ ] VPS налаштування (Ubuntu 24, firewall, fail2ban) — setup.sh готовий
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
- [ ] Базовий моніторинг (journald + cron backup)

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
- [ ] Svelte: розгортання через Nginx

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
- [x] Ролі: admin / technician / viewer
- [x] Прив'язка пристроїв до користувачів (user_devices)
- [x] WebSocket: JWT auth через `?token=` query param
- [x] WebUI: Login page, protected routing, Users page (admin)
- [x] AUTH_ENABLED toggle (backward-compatible, default: false)
- [x] seed-admin.js script
- [ ] Mosquitto: mosquitto-go-auth з PostgreSQL backend (замість static ACL)

**Результат:** Мультитенантна система з ізольованим доступом.

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

### Фаза 7: Advanced Analytics (майбутнє)
- [ ] ML моделі для предиктивного обслуговування
- [ ] Виявлення аномалій (порівняння з нормою по флоту)
- [ ] Автоматичні рекомендації: "конденсатор потребує чистки"
- [ ] Звіти для клієнтів (PDF, email)
- [ ] API для інтеграції з ERP/CMMS системами

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
