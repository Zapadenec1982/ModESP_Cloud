# ModESP Cloud — Поглиблений розбір виявлених багів

> Згенеровано командою агентів (19 агентів, адверсарна верифікація) + ручна перевірка проти живого коду.
> Дата: 2026-05-31. Гілка: `main` @ `5e970c3`.
> Кожна знахідка перевірена відкриттям реального файлу — `file:line` точні станом на цей коміт.

Легенда пріоритетів: **P0** — ламає NON-NEGOTIABLE інваріант / прямий security-ризик; **P1** — серйозний ризик цілісності/доступності; **P2/P3** — гігієна, defense-in-depth, дрібні дефекти.

---

## Статус виправлень (гілка `fix/review-p0-p1`)

| ID | Проблема | Статус |
|---|---|---|
| P0-1 | MQTT cross-tenant attribution | ✅ Виправлено — `isTopicTenantAuthorized()` + дроп у state/status/heartbeat/backfill |
| P0-2 | Bootstrap-reset понижує active-пристрій | ✅ Виправлено — reset дозволено лише для offline+grace (`RESET_OFFLINE_GRACE_MS`, деф. 10хв); online → 409 |
| P1-7 | OTA сирий `error` text | ✅ Виправлено — стабільні `code` (`firmware_not_found`/`device_not_found`/`board_mismatch`/`ota_in_progress`) |
| P1-8 | OTA `created_by` = null | ✅ Виправлено — `req.userId` → `req.user?.id` |
| — | Frontend double-`.data` (бейджі+toast) | ✅ Виправлено — `App.svelte`, `Dashboard.svelte`, `Tenants.svelte` |
| Infra | telemetry-partition тихий auth-fail | ✅ Виправлено — `User=postgres`, drop `-U` |
| Infra | `.gitignore` `.bin`/CSV | ✅ Виправлено |
| P1-3/6 | міграційний раннер + дубль 017 | ✅ Виправлено — `src/scripts/migrate.js` (`npm run migrate`, `schema_migrations`, `--baseline`/`--dry-run`); `017_energy`→`019` |
| P1-5 | delete без транзакції | ✅ Виправлено — три cascade-delete обгорнуто в `db.transaction()` |
| P1-4 | WS token в URL | ✅ Виправлено — one-time ticket через `GET /api/ws-ticket`; legacy URL-token deprecated |
| P1-9 | firmware-URL не scoped + reuse JWT_SECRET | ✅ Виправлено — HMAC прив'язаний до device_id, окремий `FIRMWARE_URL_SECRET`, повний digest |
| P1-10 | немає підпису прошивки | ⏳ Потребує firmware Secure Boot v2 (`D:\ModESP_v4`) — підтвердити enablement |
| **P2/P3** | див. нижче | 🟡 Частково (гілка `fix/review-p2-p3`) |

### P2/P3 — статус

✅ **Виправлено** (гілка `fix/review-p2-p3`):
- БД: ідемпотентність `010/013/schema.sql`; soft-delete read-фільтр (`devices.js`); `ota_jobs` cleanup при delete.
- **Telegram cross-tenant leak**: partial UNIQUE на `users(telegram_id)` (міграція 020) + 23505-backstop.
- MQTT: `stateSweeper` (евікція stale stateMap + prune aux maps).
- Backend: dead-param у OTA rollout; параметризація `LIMIT`.
- Infra: dev-порти на `127.0.0.1` + required `POSTGRES_PASSWORD`; nginx rate-limit zone у `conf.d`; hardening backup/partition systemd-юнітів.
- Frontend: розумніший WS-reconnect на 1006 (без зайвого refresh); прибрано no-op ternary.

⏳ **Свідомо відкладено** (причина):
- Паралельний notification fan-out (`push.js`) — файл активно редагується незакоміченою email-фічею; робити зараз = мердж-конфлікт. Після мержу email.
- OTA `authorize()` middleware-рефактор — inline-перевірки працюють (ota.test green); рефактор ризикує technician device-access nuance. Косметика, не баг.
- `resolveDeviceRef()` helper (евристика `id.length>8`) — рефактор ~10 місць із різним tenant/superadmin контекстом; ризик регресії > вигода без точкових тестів.
- httpOnly refresh-cookie + CSP — велика зміна auth-флоу (backend cookie + frontend), окремий епік.
- Optimistic command echo QoS — поведінкова зміна, потребує узгодження з firmware.
- god-files split (`devices.js`/`mqtt.js`), `DATABASE.md` regen, CI SAST/secret-scan, `device_models` compound FK, telemetry parent-level unique — більші/документаційні задачі для окремих PR.

> **Деплой раннера на існуючий prod:** один раз виконати `npm run migrate -- --baseline`
> (запише наявні міграції як застосовані без виконання), далі `npm run migrate` для нових.

> **Примітка:** `api.js:396` typo з первинного звіту **не підтвердився** (там вже коректний `/devices`).
> Інтеграційні vitest-набори потребують тестову БД на :5433 — прогнати після `docker compose up -d postgres-test`.

---

## P0-1 — Backend довіряє `tenant_slug` з MQTT-топіку без перевірки прив'язки

**Файли:** `backend/src/services/mqtt.js:173-178` (підписка), `:228-251` (parseTopic), `:267-296` (handleStateKey), `:351-411` (handleStatus), `:414-461` (handleHeartbeat), `:905-915` (resolveTenant)

### Механізм
1. На `onConnect()` backend підписується на **повні wildcard-и**:
   ```js
   client.subscribe('modesp/v1/+/+/state/+');   // mqtt.js:173
   client.subscribe('modesp/v1/+/+/status');
   client.subscribe('modesp/v1/+/+/heartbeat');
   ```
   Тобто backend бачить геть усі топіки всіх орендарів.
2. `parseTopic()` бере `tenantSlug = parts[2]` **прямо з рядка топіку** (`mqtt.js:236`) — це довільний рядок, який публікує пристрій.
3. `resolveTenant(slug)` → `tenantInfo.id` використовується як `tenant_id` у **всіх** DB-записах: alarm reconcile (`:309`), status update (`:387-390`), firmware update, telemetry/event backfill, alarm insert. Жодного перехресного звіряння `deviceId → authorizedTenant` немає.
4. **Гірше за все:** збережений у пам'яті `_tenantId` пристрою **перезаписується** тим, що каже топік:
   ```js
   if (state._tenantSlug !== tenantSlug) {          // mqtt.js:291, :377, :437
     logger.info(..., 'Tenant slug updated from MQTT');
     state._tenantSlug = tenantSlug;
     state._tenantId = resolveTenant(tenantSlug).id;
   }
   ```
5. `resolveTenant()` для **невідомого** slug мовчки повертає `SYSTEM_TENANT_ID` (`mqtt.js:912-914`) замість того, щоб дропнути повідомлення.

### Експлойт-сценарій
Єдина перешкода — broker-side ACL у mosquitto-go-auth. У Node-шарі **нуль defense-in-depth**. Якщо ACL колись сконфігуровано з помилкою (а пам'ять проєкту фіксує, що `aclquery` вже одного разу був джерелом багів), пристрій орендаря A з валідними кредами публікує в `modesp/v1/<slugB>/<deviceX>/state/...` — і cloud:
- пише телеметрію/алярми/`last_state` під UUID орендаря B;
- розсилає `state_delta`/`device_status` підписникам WebSocket орендаря B (`mqtt.js:341, :406`).

Друкарська помилка у slug → дані падають у SYSTEM-tenant і «зникають».

### Чому це P0
Прямо ламає NON-NEGOTIABLE інваріант ізоляції орендарів на межі прийому. Верифікатор підтвердив severity **high** (не critical лише тому, що потрібна мисконфігурація ACL — тобто це defense-in-depth діра, а не прямий публічний експлойт).

### Фікс
Звіряти топік-slug з авторизованим орендарем пристрою з `deviceRegistry`:
```js
function authorizeTenant(deviceId, tenantSlug) {
  const reg = deviceRegistry.get(deviceId);
  if (!reg) return tenantSlug === 'pending';        // незнайомий → лише pending
  const expected = tenantRegistry.get(tenantSlug);
  // pending легітимний для активного пристрою лише в stuck-сценарії
  return reg.tenantId === expected?.id || tenantSlug === 'pending';
}
// у кожному handler перед записом:
if (!authorizeTenant(deviceId, tenantSlug)) {
  logger.warn({ deviceId, tenantSlug }, 'Tenant mismatch — dropping message');
  return;
}
```
- НЕ перезаписувати `_tenantId` з MQTT — джерело істини це `deviceRegistry` (БД), не топік.
- `resolveTenant()` для невідомого slug → `return null` і drop, а не fallback на SYSTEM.

---

## P0-2 — Реєстрація активного пристрою понижує його до спільних bootstrap-кредів

**Файл:** `backend/src/index.js:137-160` (auth), `:204-237` (downgrade), `.env.example:29`

### Механізм
`POST /api/devices/register` автентифікується **лише** спільним `MQTT_BOOTSTRAP_PASSWORD` (timing-safe, `index.js:154-160`) — це один низькоентропійний секрет, **однаковий на всіх прошитих ESP32** (`.env.example:29`: «shared across all ESP32 at flash time»). Жодного per-device доказу володіння.

Якщо рядок пристрою має `has_creds && status==='active'` (`index.js:204`):
```js
await db.query(
  `UPDATE devices SET tenant_id = $1, status = 'pending',
          mqtt_username = $2, mqtt_password_hash = $3
   WHERE mqtt_device_id = $4`,
  [db.SYSTEM_TENANT_ID, username, _bootstrapHash, mqttDeviceId]);   // :207-213
await db.query(`DELETE FROM user_devices WHERE device_id = (...)`); // :215-219 — зносить RBAC
mqttSvc.removeDeviceState(mqttDeviceId);                            // :220
```
Тобто унікальний `mqtt_password_hash` перезаписується **спільним** bootstrap-хешем, пристрій від'єднується від орендаря і скидається в `pending`.

### Експлойт-сценарій (DoS + takeover)
Селектор атаки — лише `device_id`, валідований як `/^[A-Fa-f0-9]{6,12}$/` (`index.js:163`). За пам'яттю проєкту `device_id` — це 6 hex від MAC → **малий перебірний простір**. Будь-хто, хто знає спільний bootstrap-ключ (він вшитий у кожну прошивку → фактично «напівпублічний»):
1. POST `{device_id}` будь-якого відомого пристрою → збиває його унікальні креди;
2. пристрій падає офлайн (go-auth відхиляє старі креди);
3. атакувальник, тримаючи той самий bootstrap-ключ, публікує **від його імені** в pending-namespace.

`registerLimiter` (30/год/IP, `index.js:88-93`) лише троттлить і обходиться зміною IP.

### Нюанс (звідки взялася ця поведінка)
Коміт `5e970c3` навмисно переніс відновлення на пристрій: «devices call register after 3 MQTT auth failures». Намір (уникати хибних скидань під час відключень електрики на складі) слушний, але тригер прив'язаний до пристрою **без** прив'язки до його ідентичності → recovery-шлях = той самий примітив атаки.

### Фікс
- Спільний bootstrap-ключ дозволяти **лише для first-time** реєстрації пристроїв **без** кредів. Для вже-active → відмова.
- Reset `active→pending` робити **лише admin-дією** (вже є route), або вимагати per-device доказ: поточний унікальний MQTT-пароль / one-time signed attestation.
- Прошивці на «3 auth failures» — використовувати власні креди, а не self-reset бекендового запису.

---

## P1-3 — Немає міграційного раннера й таблиці обліку міграцій

**Файли:** `backend/package.json:6-14`, `backend/src/services/db.js` (немає раннера), `backend/scripts/deploy-mqtt-auth.sh:56`, `backend/test/helpers/migrate.js:23-37`

### Механізм
- Жодного `migrate`-скрипта в `package.json`; `db.js` (91 рядок) має лише `init/query/transaction/healthy/shutdown` — він **ніколи не читає** теку міграцій.
- Prod накатує міграції **вручну**: `deploy-mqtt-auth.sh:56` → `sudo -u postgres psql -f .../008_mqtt_auth.sql` (по одній).
- Єдиний код, що ітерує теку — **тестовий** хелпер `test/helpers/migrate.js`, який сортує за іменем і **ковтає** помилки `42710/42704/42P07` (`already exists`) → тобто навіть тест не валідує чистий prod-apply.

### Наслідки
- Немає запису, які міграції накатано на prod.
- Немає захисту від повторного запуску **неідемпотентних** міграцій (див. P2 нижче — `010/013/schema.sql` впадуть).
- Дубль `017` (P1-6) невидимий.

### Фікс
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Раннер `npm run migrate`: читає теку, сортує, для кожного незаписаного файлу — `BEGIN; <file>; INSERT INTO schema_migrations; COMMIT;`. Той самий раннер ганяти в CI проти **чистої** БД (тоді ловиться і дубль-017, і неідемпотентність).

---

## P1-4 — WebSocket JWT у query-string URL

**Файли:** `webui/src/lib/ws.js:35-38`, читається `backend/src/services/ws.js:56-62`

### Механізм
```js
const token = getAccessToken();
if (token) url += `?token=${encodeURIComponent(token)}`;   // ws.js:36-37
```
Backend читає `reqUrl.searchParams.get('token')` у `verifyClient`. Токен у query-string потрапляє в: nginx access-логи (prod), історію браузера, `Referer`. Витік = імперсонація до закінчення TTL.

### Нюанс
Верифікатор знизив до **medium**: токен короткоживучий, додається лише в `AUTH_ENABLED`, а браузерний `WebSocket` API забороняє кастомні заголовки → query-string це стандартний workaround. Але робастні альтернативи існують.

### Фікс
One-time WS-ticket: автентифікований REST (`Authorization` header) видає короткий single-use ticket → у URL передається ticket, бекенд споживає його при handshake. Альтернатива — токен першим WS-повідомленням. Мінімум — у nginx вирізати `token` з логів:
```nginx
set $loggable_uri $uri;  # без query-string у log_format
```

---

## P1-5 — Delete / bulk-delete / pending-delete без транзакції

**Файли:** `devices.js:176-183` (pending hard-delete), `:353-364` (soft-delete), `:411-422` (bulk)

### Механізм
Кожен delete-handler виконує **6 послідовних** `await db.query()` через пул у режимі **autocommit** (`db.js:39-47` — без BEGIN):
```js
await db.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);    // :353
await db.query(`DELETE FROM telemetry ...`);
await db.query(`DELETE FROM events ...`);
await db.query(`DELETE FROM user_devices ...`);
await db.query(`DELETE FROM service_records ...`);
await db.query(`UPDATE devices SET status='deleted' ...`);                     // :358-364
```
Якщо будь-який statement після першого впаде (drop конекту, `statement_timeout` 30s, лок) — попередні DELETE вже закомічені, а `UPDATE ... status='deleted'` ні → пристрій у **напів-видаленому** стані.

### Нюанс
Хелпер `db.transaction()` **уже існує** (`db.js:53-66`) і **вже застосовується в цьому ж файлі** (`:256` reset-pending, `:1527` reassign) → це чистий недогляд. Верифікатор знизив до **medium**: вікно вузьке, дані — soft-delete cleanup (не safety-critical control state), відновлюється повторним delete.

### Фікс
```js
await db.transaction(async (client) => {
  await client.query(`DELETE FROM alarms WHERE device_id = $1`, [deviceMqttId]);
  // ... решта 5 statements через client.query
  await client.query(`UPDATE devices SET status='deleted', ... WHERE id = $1`, [deviceUuid]);
});
```
Для `/bulk` — **окрема** транзакція на пристрій усередині циклу (щоб один збій не відкочував усю партію — цикл уже ізолює failures per-device, `:426-428`).

---

## P1-6 — Дубль номера міграції `017`

**Файли:** `017_email_notifications.sql`, `017_energy_monitoring.sql`

### Механізм
Дві незалежні міграції з префіксом `017`. `017_email` робить `ALTER TABLE notification_subscribers DROP/ADD CONSTRAINT valid_channel`; `017_energy` створює `device_models` + ALTERs `devices/tenants`. Об'єкти **різні** → немає ризику пошкодження даних від порядку. Але контракт монотонної нумерації зламано, а наступний номер `018` уже зайнято.

### Нюанс
Верифікатор знизив до **low**: обидві ідемпотентні (`DROP CONSTRAINT IF EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) → нуль run-time ризику. Це гігієна.

### Фікс
Перейменувати `017_energy_monitoring.sql` → `019_energy_monitoring.sql` (бо `018` зайнято), оновити deploy-скрипти/доки. Після впровадження раннера (P1-3) такі колізії стають видимими автоматично.

---

## P1-7 — OTA endpoint-и зливають сирий `Error.message` у машинне поле `error`

**Файл:** `backend/src/routes/ota.js:56-58, 96-98, 209-211, 222-224, 235-237`

### Механізм
```js
if (err.status) {
  return res.status(err.status).json({ error: err.message, message: err.message, status: err.status });
}                                                                          // ota.js:56-58
```
Контракт (CLAUDE.md): `{ error: '<machine_code>', message: '<human text>' }`. Тут `error` стає повним англійським реченням (напр. «Board mismatch: firmware targets "x", device is "y"», що сервіс кидає в `ota.js`). Frontend, що `switch`-иться по `error`, не може покладатися на значення; wire-формат зчеплено з текстом винятків.

### Фікс
У сервісі чіпляти стабільний `code`:
```js
throw Object.assign(new Error('Board mismatch: ...'), { status: 409, code: 'board_mismatch' });
// у route:
return res.status(err.status).json({ error: err.code || 'ota_error', message: err.message, status: err.status });
```

---

## P1-8 (нове, sutteva) — OTA `created_by` персиститься як `null`

**Файл:** `backend/src/routes/ota.js:48` (deploySingle), `:88` (createRollout)

### Механізм
```js
const result = await otaSvc.deploySingle(req.tenantId, tRes.rows[0].slug, firmware_id, device_id, req.userId);  // :48
```
Передається `req.userId`, але middleware `authenticate` ставить `req.user.id` (той самий handler коректно вживає `req.user.id`/`req.tenantId` деінде). `req.userId === undefined` → OTA `created_by` пишеться `null` → **втрата аудит-сліду** на push-у коду на фізичні контролери. Те саме в `createRollout` (`:88`).

### Фікс
`req.userId` → `req.user.id` у `:48` і `:88`.

---

## P1-9 — Підписані firmware-URL не прив'язані до tenant/device + reuse `JWT_SECRET`

**Файли:** `backend/src/services/firmware-url.js:5,13-32`, `backend/src/routes/firmware-download.js:15-47`, монтується `index.js:295` (ДО auth middleware)

### Механізм
```js
const SECRET = process.env.JWT_SECRET;                                  // firmware-url.js:5 — reuse session-секрету
const sig = crypto.createHmac('sha256', SECRET)
  .update(`${filename}:${expires}`).digest('hex').slice(0, 32);          // :15-16 — лише filename+expiry
```
- HMAC лише над `filename:expires` — **нуль** прив'язки до tenant/device.
- Route `/api/firmware/dl` змонтований **до** `authenticate` (`index.js:295` vs `:308`) → **неавтентифікований**. Будь-хто з валідним `file+expires+sig` отримує байти.
- `filename = ${tenantId}_${version}_${ts}.bin` (`firmware.js:75`) — передбачуваний; єдиний захист конфіденційності між орендарями це 30-хв HMAC.
- Підпис обрізано до 32 hex (128 біт — криптографічно ок, але дайджест усічений) + reuse auth-секрету = погана гігієна ключів.

### Фікс
- Окремий `FIRMWARE_URL_SECRET` (не reuse `JWT_SECRET`), валідувати на старті незалежно від `AUTH_ENABLED`.
- Включити `device_id` (і tenant) у HMAC-вхід, валідувати ідентичність пристрою на завантаженні.
- Лишити повний 64-char дайджест; коротший TTL; one-time токен, прив'язаний до `ota_job`.

---

## P1-10 — Немає криптопідпису firmware-бінарників (safety-critical)

**Файли:** `backend/src/routes/firmware.js:69-78`, `backend/src/services/ota.js:38-50`

### Механізм
При завантаженні рахується **лише** server-side SHA256 (`crypto.createHash` над буфером) і шиється в `_ota` payload як `{url, version, checksum}`. Це лише детекція пошкодження в транзиті — **не** автентичність. Cloud (і його `FIRMWARE_STORAGE_PATH` на диску) — єдиний trust anchor. Якщо скомпрометовано upload-endpoint, admin-креди чи теку зберігання — шкідливий `.bin` доходить до фізичних холодильних контролерів без другого фактора.

### Нюанс
Верифікатор знизив до **medium**: вирішальний safety-фактор живе у firmware-шарі (ESP-IDF **Secure Boot v2**), якого тут не видно. Якщо Secure Boot v2 увімкнено на боардах — bootloader відхилить будь-який образ, не підписаний build-ключем → залишається лише boot-loop DoS. Пам'ять згадує Secure Boot/flash encryption як firmware-scope, але **не підтверджує prod-enablement** — це треба верифікувати.

### Фікс
- Out-of-band підпис: Ed25519/RSA приватним ключем офлайн (або в build-pipeline), зберігати підпис поряд із checksum, шити в `_ota`, ESP32 перевіряє вбудованим публічним ключем **до** прошивки.
- Мінімум — задокументувати й забезпечити Secure Boot v2 на всіх контролерах. Теку firmware трактувати як integrity-protected asset.

---

## P2/P3 — Середній і низький пріоритет

### Backend / авторизація
- **`authorize()` непослідовний** (`ota.js:12-39` deploy без middleware, `/jobs` `/rollouts` без `authorize()` взагалі; `devices.js:1418` superadmin-перевірка inline). Винести політику в middleware декларативно. *(в dev-fallback `index.js:335-337` ota/firmware монтуються без auth → inline-guard `req.user &&` короткозамкнений → будь-хто деплоїть прошивку — `ota.js:492-496`).*
- **`device_id`-евристика `id.length > 8`** дубльована ~10 разів (`devices.js:49,204,294,390`; `telemetry.js:21`; `alarms.js:151`; `events.js:18`; `export.js:30`). 9-12-символьний hex `mqtt_device_id` помилково класифікується як UUID → 404. Винести `resolveDeviceRef()` з реальним UUID-regex `/^[0-9a-f]{8}-/i`.
- **God-files:** `devices.js` (1562 рядки), `mqtt.js` (1457). Розбити на crud/provisioning/service-records та виокремити MQTT-підсистеми (sampler, alarm-detection, auto-discovery).
- **LIMIT інтерполюється рядком** (`telemetry.js:108-109`, `ota.js:133`) — сьогодні безпечно (server-computed), але біндити параметром для safety-by-default.
- **`AUTH_ENABLED` re-read у 6+ модулях** на require-time — централізувати в один frozen config-модуль.
- **Pending-assign неатомарний** (`devices.js:507-628`): MQTT `_set_mqtt_creds`/`_set_tenant` (`:561-581`) шлються **до** `UPDATE devices` (`:584-595`). Краш між ними → пристрій реконнектиться з кредами, яких БД не зберегла → stuck. Писати креди в БД у тій самій транзакції, MQTT — після commit.
- **Dead-param у OTA rollout** (`ota.js:132-138`): placeholders з `$3`, `'active'` на позиції `$2` ніколи не референситься.

### MQTT
- **Необмежений ріст Maps** (`mqtt.js:63` stateMap, `:465` backfillCounters, discoveryCount, deletedDevices): `offlineDetector` лише ставить `_online=false`, не видаляє. На 5000 пристроїв + churn pending-id — повільний витік. Додати sweeper із TTL (drop `_online=false` >24h, якщо не в `deviceRegistry`, після persist `last_state`).
- **`_set_mqtt_creds` шле plaintext-пароль** у pending-namespace (`mqtt.js:894, 1331-1336`) — конфіденційність лише на broker-ACL. Redaction-guard + доставляти креди через REST-відповідь `/register`, а не shared MQTT.
- **Немає обробки retained `offline` (LWT)** для відомих у БД пристроїв при рестарті (`mqtt.js:355-356` early-return). Обробляти retained-offline для `deviceRegistry`; вирівняти `OFFLINE_THRESHOLD` (90s) з 30s heartbeat.
- **Optimistic command echo** (`mqtt.js:1306-1321`): пише значення в stateMap і емітить `state_delta` до підтвердження при QoS 0. Firmware відхилив/втрачено publish → UI десинк + пишеться в `last_state`. QoS 1 + echo після re-publish, або provisional-поле.
- **Хардкоднутий retained-clear список** `protection.*` (`mqtt.js:1402-1437`) неповний → фантомний стан на пристрої з тим самим id. Брати список з того ж джерела істини, що firmware (`STATE_META retain=true`).

### Frontend
- **Подвійний un-wrap `.data`** — `request()` уже повертає `json.data` (`api.js:139-140`), тож `getDevices()`/`getAlarms()` повертають масив. `App.svelte:66,69` перевіряють `devRes?.data`/`almRes?.data` на вже-розгорнутому масиві → завжди `undefined` → бейджі pending/alarm у сайдбарі **мовчки не оновлюються**. Те саме в `Dashboard.svelte:58` (delete-toast завжди fallback на `selected.size`) і `Tenants.svelte:161` (suffix «N moved» не з'являється). Фікс: читати поля напряму (`devRes.filter(...)`, `res.deleted`).
- **`api.js:396` typo** `'\devices'` замість `'/devices'`.
- **Refresh-token у `localStorage` + немає CSP** (`api.js:14,85`) — XSS-ексфільтрований → durable takeover. httpOnly+Secure+SameSite cookie для refresh; strict CSP через nginx; self-host шрифти.
- **WS 1006 → повний restoreSession** (`ws.js:65-76`) на кожен мережевий blip — зайвий refresh+`/users/me`. Спершу plain reconnect, escalation лише на явний auth-код (4401/1008).
- **`confirm()` + модалки без focus-trap** (`DeviceDetail.svelte:202,224,239,289,331`); `:224` — no-op ternary (обидві гілки `device.mqtt_rotate_confirm`).

### Database
- **Soft-delete не застосовано в read-списку** (`devices.js:87` без `status`-фільтра) → видалені офлайн-пристрої висять до 7-денного cleanup. `AND status <> 'deleted'` + аудит інших `FROM devices` (`:129, :970, :1455`).
- **Неідемпотентні міграції** `010_user_tenants.sql:4-15` (`CREATE TABLE` без IF NOT EXISTS + безумовний `INSERT ... SELECT` → PK violation), `013_refresh_token_tenant.sql:4-5` (`ADD COLUMN` без IF NOT EXISTS), `schema.sql:21-22` (безумовний INSERT System-tenant). Додати `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`.
- **`ota_jobs` не чиститься при видаленні пристрою** (telemetry/alarms/events чистяться явно в усіх трьох delete-handler-ах → широкого orphan-ризику немає; верифікатор спростував). Лишається вузький orphan лише по `ota_jobs`. Додати очистку.
- **`devices.model_id → device_models(id)` без compound `(tenant_id, model_id)`** (`017_energy:6-30`) → крос-tenant прив'язка можлива на рівні схеми. Перевіряти в застосунку або композитний FK.
- **`telemetry` без PK**, dedup-unique створюється лише helper-шляхами; тестовий `telemetry_default` без unique-індексу → ON CONFLICT dedup не тестується.
- **`audit_log` immutable + RESTRICT FK** → tenant ніколи не hard-deletable. Задокументувати offboarding як soft-disable (`tenants.active=false`).
- **`DATABASE.md` дрейфує** (немає `device_models/audit_log/push_subscriptions/user_tenants/soft-delete`, changelog на 016). Регенерувати.

### Infra / DevOps
- **`.gitignore` не покриває `*.bin`/`batch_test.csv`** → `git add .` закомітить прошивку + provisioning-CSV (10 рядків serial/location, але «Емулятор» test-дані → верифікатор знизив до medium). Додати `backend/firmware/*.bin`, `*.csv`. *(`nul`, `*.log`, build-log — вже ignored коректно.)*
- **Telemetry-partition systemd unit не автентифікується** (`modesp-telemetry-partition.service:6-8`): `psql -U modesp_cloud` під `User=modesp` без `-h`/PGPASSWORD/EnvironmentFile. OS-user `modesp` ≠ DB-role `modesp_cloud` → peer-auth відхиляє; non-interactive → password-prompt недоступний. Pre-create партицій **мовчки падає** → telemetry INSERT-и ламаються 1-го числа непокритого місяця. Верифікатор: **high**. Фікс: `User=postgres` (drop `-U`) або EnvironmentFile+PGPASSWORD+`-h localhost`; `OnFailure=` alert (зараз тихо). *(робочий `ensure-partitions.js` існує, але НЕ підключений до unit.)*
- **Backup/partition units без hardening** (`modesp-backup.service:1-10`) — pg_dump/gpg/rsync/find-delete unconfined; немає `OnFailure=`. Додати `NoNewPrivileges/ProtectSystem=strict/ProtectHome/PrivateTmp` + `ReadWritePaths`.
- **Backup: немає restore-runbook**, retention 14d у скрипті vs 30d у `DEPLOYMENT.md`, remote росте безмежно.
- **Nginx rate-limit zone лише в коментарі** (`modesp.conf:5-6`) — деплой `modesp.conf` самого → `nginx -t` падає «zone api is not defined». Винести `limit_req_zone` в окремий `conf.d/`-файл; окремі strict-зони для auth/register.
- **Dev mosquitto `0.0.0.0` + anonymous** (`infra/dev/mosquitto.conf:4-5`) + compose публікує `1883:1883` на всіх інтерфейсах → відкритий MQTT у LAN. Map `127.0.0.1:1883:1883`.
- **Compose `dev_password` fallback + `5432:5432`** на всіх інтерфейсах (`docker-compose.yml:12-17`). Bind `127.0.0.1`, `POSTGRES_PASSWORD:?` required-form.
- **CI без SAST/dep/secret-scan** (`ci.yml`) — додати gitleaks + Dependabot + CodeQL + `npm audit`.
- **Backend `ReadWritePaths` на всю backend-теку** бо `FIRMWARE_STORAGE_PATH=./firmware` (`modesp-backend.service:26-28`). Перенести в `/var/lib/modesp/firmware`, звузити RW-path; `SystemMaxUse=` для journald.

### Notifications
- **Telegram linking TOCTOU + немає UNIQUE на `telegram_id`** (`telegram.js:653-690`, `012:12-13` лише non-unique index). Дві паралельні `/start` прив'язують один чат до кількох акаунтів → чат отримує алярми чужого орендаря. Partial UNIQUE `WHERE telegram_id IS NOT NULL` + lookup+check+update в одній транзакції.
- **Fan-out шле послідовно** (`push.js:260-309`) — один повільний провайдер блокує доставку решті. `Promise.allSettled` + per-send timeout (`Promise.race`).

---

## Рекомендований порядок виправлення

1. **P0-1** — звіряти MQTT tenant-slug з registry, drop при розбіжності/unknown (`mqtt.js`).
2. **P0-2** — заборонити bootstrap-ключу понижувати active-пристрої (`index.js`).
3. **P1-3/6** — міграційний раннер + `schema_migrations`, перейменувати `017→019`, ідемпотентність `010/013/schema.sql`, CI проти чистої БД.
4. **P1-5** + pending-assign — атомарність через `db.transaction()`.
5. **Infra high** — полагодити telemetry-partition systemd auth (тихий prod-fail).
6. **P1-4** — WS one-time ticket / вирізати token з nginx-логів.
7. **P1-7/8** — стабільні OTA `code` + `req.userId → req.user.id`.
8. **P1-9/10** — окремий `FIRMWARE_URL_SECRET`, device-binding URL; підтвердити Secure Boot v2.
9. **P2** frontend — прибрати подвійний `.data`, typo, httpOnly refresh + CSP.
10. **P2/P3** — MQTT sweeper, винести `authorize()`/`resolveDeviceRef()`, soft-delete read-фільтр, `.gitignore`, Telegram UNIQUE, гігієна репо/доків.
