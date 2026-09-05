# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/), версії — [SemVer](https://semver.org/lang/uk/).
Реліз = тег `vX.Y.Z`; GitHub Actions (`.github/workflows/release.yml`) збирає архів
`modesp-cloud-vX.Y.Z.tar.gz`, який `infra/deploy.sh release vX.Y.Z` встановлює на сервер.
Розділ нижче з тим самим номером стає текстом релізу.

## [Unreleased]

### Додано
- Рекомендації з обслуговування (епік 2.4 плану, фаза 18 ROADMAP): пʼять правил
  «попередження ремонту» — часті пуски компресора, компресор працює майже безперервно,
  відтайки по таймауту, забагато відкривань дверей, гарячий конденсатор — раз на годину
  читають події, телеметрію й живий стан контролера (`services/maintenance.js`). Підказка
  відкривається один раз на пристрій і правило, закривається сама, коли показник повертається
  в норму; її можна взяти в роботу (технік із доступом) або відхилити (адмін). Адміністраторам
  надходить сповіщення `info` у Telegram, на пошту й web push; WebSocket-подія `hint`.
  Таблиці `maintenance_rules` (платформні значення + перевизначення організації, за моделлю)
  і `maintenance_hints` (міграція 032), функція плану `maintenance` з тарифу «Обʼєкт».
  REST `GET /maintenance/hints`, `GET /devices/:id/hints`, `POST /maintenance/hints/:id/ack|dismiss`,
  `GET|PUT|DELETE /maintenance/rules[/:key]`, `POST /maintenance/evaluate` (superadmin).
  WebUI: вкладка «Рекомендації» в картці пристрою, плитка на панелі, бейдж на картці, пороги в
  налаштуваннях організації. Ретенція закритих підказок `MAINTENANCE_HINT_RETENTION_DAYS` (365),
  інтервал оцінки `MAINTENANCE_EVAL_INTERVAL_MIN` (60).

## [1.0.0] — 2026-09-02

Перший версійований реліз: хвиля 1 плану `docs/IMPLEMENTATION_PLAN_SAAS_UA.md`.

### Додано
- Плани організацій (`plan_limits`: Старт / Об'єкт / Мережа / Enterprise / Партнер) з лімітами
  пристроїв, точок і користувачів (`402 plan_limit`) та функціями (`402 plan_feature`);
  стан організації (`tenants.status`), призупинення закриває вхід і топіки брокера;
  налаштування організації (часовий пояс, мова, затримки аварій, пороги offline, ескалація,
  тариф на електроенергію) на сторінці «Налаштування».
- Звіт HACCP інспекційного рівня: локалізація uk/en/pl/de, реквізити організації і точки,
  місцевий час, підпис відповідальної особи, код перевірки і SHA-256 у футері, звіт по точці
  (`GET /sites/:id/export.pdf`), публічна перевірка `GET /api/public/report/:code`,
  погодинний архів `telemetry_hourly` на 3 роки, ретенція сирих даних за планом.
- Запрошення користувачів, самостійне скидання пароля, єдина політика паролів (15 символів),
  роутер `/api/profile`.
- Сповіщення: адресати через гранти на пристрої та точки, персональні налаштування
  (канали, мінімальна важливість, тихі години), підтвердження аварій (`POST /alarms/:id/ack`)
  з ескалацією непідтверджених критичних, offline як аварія `device_offline`, журнал доставок.
- Безпека команд: підтвердження для ключів, що змінюють обладнання, історія команд, ізоляція
  WebSocket за організацією, коди підключення контролерів (claim codes).
- Експлуатація: перевірений бекап одним архівом з off-site копією і runbook відновлення,
  таймери systemd замість cron, `SECURITY DEFINER` функції партицій, `/api/health` для
  зовнішнього пробу і `/api/health/details`, Telegram-алерт про збій юніта, безпечний рестарт.
- Релізи: `infra/scripts/build-release.sh`, `infra/deploy.sh` (init / release / rollback / status
  з health-гейтом), CI-перевірка міграцій і GRANT-ів на порожній БД (`infra/sql/*.sql`),
  автодеплой `main` на staging, `purge-demo.js` для продакшену без синтетичних даних,
  showcase-посилання на статус демо-точки без ліміту переглядів.
- Лендінг на `/` (`landing/`): продукт, сегменти, графік, калькулятор штрафу проти підписки,
  ціни з `plan_limits` (`GET /api/public/plans`), форма запиту на пілот
  (`POST /api/public/pilot-request` → `pilot_requests` + лист), сторінка партнерів, `/legal/*`
  з `docs/legal`, robots/sitemap; посилання на умови й політику на сторінці входу; публічна
  статус-сторінка показує організацію, «Працює на ModESP Cloud», попередження про закінчення
  посилання і заклик до дії.
- Гео-ліцензування: бекенд у продакшені відмовляється стартувати з некомерційними
  гео-хостами (`ALLOW_NONCOMMERCIAL_GEO` — свідомий обхід), self-hosted OSRM + Nominatim
  (`infra/geo/`), платний ключ Open-Meteo (`WEATHER_API_KEY`), тайли через `MAP_TILE_HOSTS`;
  погода і планувальник об'їзду — функції планів `pro`/`enterprise`/`partner`.
- Документація: бізнес-аналіз і план впровадження (UA), комерційна ліцензія і юридичні
  чернетки (`docs/legal/`), runbooks.

### Змінено
- WebUI переїхав з `/` на `/cloud/` (лендінг зайняв корінь; старі `#/…` посилання
  перенаправляються). `EMAIL_APP_URL` тепер `https://modesp.com.ua/cloud`, корінь — `PUBLIC_BASE_URL`.
- Інвентаризація пристроїв: `GET /devices/export.csv` → `GET /devices/export/inventory.csv`.
- `/users/me*` → `/api/profile*` (старі шляхи прибрано).
- Суперадміністратори більше не отримують аварії організацій без `receive_all_tenant_alerts`.
- `provision-demo-fleet.js` і `seed-demo.js` відмовляються писати з `NODE_ENV=production`
  без `--allow-production`.

### Міграції
023 (функції партицій), 024 (запрошення), 025 (коди контролерів), 026 (налаштування
сповіщень, підтвердження аварій), 027 (плани, стан, налаштування організації), 028
(`report_exports`, `telemetry_hourly`, перевизначення ретенції), 029 (showcase-посилання),
030 (ціни планів, `pilot_requests`), 031 (функції `weather`/`routing`).
Застосувати `migrate.js` як власник схеми, потім `infra/sql/app-grants.sql`.

[Unreleased]: https://github.com/Zapadenec1982/ModESP_Cloud/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Zapadenec1982/ModESP_Cloud/releases/tag/v1.0.0
