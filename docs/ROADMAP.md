# Roadmap ModESP Cloud

## Поточний стан

**Фаза: Документація оновлена під реальний MQTT протокол. Код не написаний.**

---

## Фази розробки

### Фаза 1: Cloud Foundation
**Ціль:** Базова інфраструктура. ESP32 підключається до хмари, дані зберігаються.

**Firmware changes (ModESP_v4) — prerequisite:**
- [ ] NVS config: tenant_slug field
- [ ] Prefix builder: `modesp/v1/{tenant}/{device}` format
- [ ] Heartbeat publish (JSON metadata, кожні 30с)
- [ ] `_set_tenant` command handler (auto-discovery)
- [ ] HTTP API `/api/mqtt`: tenant field
- [ ] Тестування: compile, flash, verify MQTT topics

**Cloud infrastructure:**
- [ ] VPS налаштування (Ubuntu 24, firewall, fail2ban)
- [ ] Mosquitto broker з ACL і TLS
- [ ] PostgreSQL: базова схема (tenants, devices, alarms, telemetry, events)
- [ ] Node.js: MqttService (підписка, topic parsing, state aggregation)
- [ ] Node.js: State Map (in-memory accumulation 48 keys per device)
- [ ] Node.js: Alarm Detector (protection.* transition detection)
- [ ] Node.js: Telemetry Sampler (5хв server-side sampling → DB)
- [ ] Node.js: Event Detector (compressor on/off, defrost transitions)
- [ ] Node.js: healthcheck endpoint
- [ ] State metadata registry (state_meta.json з ModESP_v4)
- [ ] Nginx: HTTPS термінація
- [ ] systemd юніти для всіх сервісів
- [ ] Базовий моніторинг (journald + cron backup)

**Результат:** ESP32 публікує individual keys, cloud агрегує, зберігає в БД.

---

### Фаза 2: Remote Monitoring WebUI
**Ціль:** Технік бачить стан всіх контролерів з будь-якої точки світу.

- [ ] Node.js: WebSocket сервер (real-time delta broadcasts per tenant)
- [ ] Node.js: REST API (GET /devices, GET /devices/:id)
- [ ] Node.js: Command translation (REST → MQTT individual keys)
- [ ] Svelte: хмарний WebUI (окремий від ESP32 WebUI)
- [ ] Svelte: список пристроїв з online/offline статусом
- [ ] Svelte: перегляд стану контролера в реальному часі
- [ ] Svelte: auto-discovery UI (pending devices list, assign to tenant)
- [ ] Svelte: розгортання через Nginx

**Результат:** Повноцінний віддалений моніторинг без додаткового обладнання.

---

### Фаза 3: Push Notifications
**Ціль:** Технік отримує сповіщення про аварії миттєво.

- [ ] Node.js: FCM інтеграція (Firebase Cloud Messaging)
- [ ] Node.js: Telegram Bot
- [ ] Маршрутизація: alarm transition → підписники цього пристрою
- [ ] REST API: реєстрація FCM токена і Telegram ID
- [ ] WebUI: налаштування підписок на сповіщення

**Результат:** Push на телефон і Telegram при будь-якій аварії.

---

### Фаза 4: User Management
**Ціль:** Кілька техніків, кілька організацій, контроль доступу.

- [ ] Node.js: JWT авторизація (login, refresh, logout)
- [ ] Node.js: CRUD користувачів
- [ ] Ролі: admin / technician / viewer
- [ ] Прив'язка пристроїв до користувачів
- [ ] Mosquitto: mosquitto-go-auth з PostgreSQL backend (замість static ACL)
- [ ] WebUI: сторінка управління користувачами (тільки admin)

**Результат:** Мультитенантна система з ізольованим доступом.

---

### Фаза 5: History & Analytics
**Ціль:** Аналіз трендів, виявлення деградації обладнання.

- [ ] REST API: телеметрія по часовому діапазону
- [ ] REST API: агрегована статистика (min/max/avg, duty cycle)
- [ ] WebUI: графіки температур (uPlot)
- [ ] WebUI: історія аварій
- [ ] WebUI: агрегований дашборд по всьому парку
- [ ] Партиціонування телеметрії по місяцях (автоматизація)

**Результат:** Аналітика для прийняття рішень про обслуговування.

---

### Фаза 6: Fleet OTA
**Ціль:** Оновлення прошивки на всіх пристроях без виїзду на об'єкт.

- [ ] **ModESP_v4:** додати MQTT OTA handler (підписка на `cmd/_ota`, download firmware by URL)
- [ ] REST API: завантаження firmware файлів
- [ ] REST API: запуск OTA на окремому пристрої
- [ ] Груповий rollout з batch_size і інтервалом
- [ ] Відстеження статусу OTA по парку
- [ ] Автоматичний rollback при масовому збої
- [ ] WebUI: сторінка управління firmware

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
- [ ] NVS: `tenant` field (string, max 32)
- [ ] Prefix: `modesp/v1/{tenant}/{device}` (або `modesp/v1/pending/{device}`)
- [ ] Heartbeat: JSON metadata кожні 30с (~100 bytes, stack buffer)
- [ ] `_set_tenant` command: save to NVS → reconnect
- [ ] HTTP API: tenant field в GET/POST `/api/mqtt`
- [ ] RAM overhead: ≤ 2KB (80KB вільної залишиться ≥ 78KB)

### ModESP_v4 → Phase 6 (MQTT OTA)
- [ ] Підписка на `cmd/_ota` з URL firmware
- [ ] HTTPS download → esp_ota_begin/write/end
- [ ] Publish OTA status/progress

---

## Changelog

- 2026-03-07 — Створено. 7 фаз розробки, залежності з ModESP_v4.
- 2026-03-07 — Оновлено. Phase 1 деталізовано під реальний MQTT протокол (individual keys, state aggregation, server-side sampling). Firmware changes як prerequisite.
