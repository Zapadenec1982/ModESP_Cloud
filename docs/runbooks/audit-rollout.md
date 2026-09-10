# Runbook: викочування виправлень аудиту цілісності

Що зробити на продакшн-сервері, щоб узяти зміни, злиті після аудиту цілісності
(PR #40–#58). Ці кроки **не покриваються** звичайним викочуванням: три
міграції, з яких одна важка, вимкнений на час викочування таймер, необовʼязкове
відновлення історії, яке треба зробити **до** міграції, і чотири разові запити
на пошук уже зіпсованих даних.

| | |
|---|---|
| **Скільки триває** | 20–40 хв активної роботи; міграція 049 — від хвилин до годин залежно від обсягу `telemetry` |
| **Простій** | не потрібен: бекенд працює, але на час міграції 049 зростає навантаження на БД |
| **Що потрібно** | root на сервері, доступ до off-site архіву (якщо відновлюєте історію), вікно обслуговування |
| **Відкат** | залежить від розкладки сервера (розділ 4); міграції **не відкочуються** в обох випадках — див. розділ 6 |

## 1. Перед початком: свіжий архів

Міграція 049 видаляє рядки. Не покладайтеся на нічний архів — зробіть свій:

```bash
systemctl start modesp-backup.service
journalctl -u modesp-backup.service -n 20 --no-pager   # останній рядок починається з «OK:»
ls -lh /var/backups/modesp/ | tail -3
```

## 2. Зупинити таймер очистки

Обовʼязково і **першим кроком**. Таймер щодня о 03:30 виконує
`cleanup-telemetry.js` і `cleanup-aux.js`. Поки на сервері старий код, кожен
його запуск додає втрат (це і була критична вада C1); а поки триває міграція
049, паралельне видалення просто заважає.

```bash
systemctl stop modesp-retention-cleanup.timer
systemctl disable modesp-retention-cleanup.timer
systemctl is-active modesp-retention-cleanup.timer    # inactive
```

Таймер повертаємо аж у розділі 5, після перевірки.

## 3. Відновити історію, якщо вона потрібна — **до** міграції

Два випадки, і обидва мають статися до того, як щось піде далі.

### 3.1. Погодинний архів за періоди автономної роботи (H7, PR #48)

Контролер досилає до 90 днів накопичених вимірювань, але згортка в
`telemetry_hourly` обробляла лише останні 3 дні. Періоди, коли обладнання
працювало без звʼязку, лишилися в архіві розривами. Сирі рядки за ті періоди
ще є, поки їх не видалила ретенція — тож згорнути їх можна **зараз**:

```bash
cd /opt/modesp-cloud/backend
# спершу подивитися, скільки їх
sudo -u modesp node scripts/cleanup-telemetry.js --backfill-days 400
# якщо цифри виглядають розумно — виконати
sudo -u modesp node scripts/cleanup-telemetry.js --apply --backfill-days 400
```

`400` — глибина в днях; беріть за найдовшою ретенцією серед ваших планів.
Операція ідемпотентна (`ON CONFLICT DO UPDATE`), її можна повторювати.

### 3.2. Історія тривог за періоди, старші за 365 днів (M5, PR #55)

Нижня межа ретенції доказових таблиць діє **лише вперед**. Тривоги, події та
підказки, старші за 365 днів, уже видалив нічний таймер — у базі їх немає.
Якщо звіти за 2025 рік ще знадобляться, дістати ці рядки можна тільки з
архіву, і зробити це треба **до першого запуску таймера після викочування**.

Процедура — `docs/runbooks/restore.md`, розділ 5, але замість повного
відновлення розгорніть дамп у окрему базу і перенесіть лише потрібні рядки:

```bash
createdb -O postgres modesp_restore
pg_restore -d modesp_restore --no-owner /root/restore/db.dump
# далі перенести вибірку, наприклад:
#   \copy (SELECT * FROM alarms WHERE cleared_at < now() - interval '365 days') TO '/tmp/old-alarms.csv' CSV
```

Якщо історія за той період не потрібна — пропустіть цей крок свідомо, а не за
замовчуванням: після викочування повернути її буде нізвідки.

## 4. Викотити код і міграції

**Спершу зʼясуйте, яка на цьому сервері розкладка.** Їх дві, і команда для них
різна:

```bash
ls -ld /opt/modesp-cloud /opt/modesp-releases 2>&1
```

| Що видно | Розкладка | Куди далі |
|---|---|---|
| `/opt/modesp-cloud` — **symlink**, `/opt/modesp-releases` існує | релізна (після `deploy.sh init`) | 4.1 |
| `/opt/modesp-cloud` — звичайний каталог, `/opt/modesp-releases` немає | git-checkout | 4.2 |

Не пропускайте цю перевірку. `deploy.sh release` на git-checkout або впаде, або
почне перебудовувати розкладку **посеред викочування** — цього не має статися
між зупиненим таймером і незастосованими міграціями.

### 4.1. Релізна розкладка

```bash
sudo /opt/modesp-cloud/infra/deploy.sh release v<версія>
```

Скрипт сам робить dry-run міграцій, застосовує їх від власника схеми, наливає
гранти і перевіряє `/api/health` з автоматичним відкатом.

### 4.2. Git-checkout

Той самий порядок, але кожна гарантія — окремою командою (це «Ручний шлях» із
`docs/DEPLOYMENT.md`). Виконуйте по одній і дивіться на вивід кожної:

```bash
cd /opt/modesp-cloud && git pull origin main

# міграції: спершу подивитися перелік, потім застосувати
sudo -u postgres env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME=modesp_cloud DB_USER=postgres DB_PASS= \
  node backend/src/scripts/migrate.js --dry-run
sudo -u postgres env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME=modesp_cloud DB_USER=postgres DB_PASS= \
  node backend/src/scripts/migrate.js

# права застосунку і перевірка, що вони справді наливаються
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v app_user=modesp_cloud -v owner=postgres \
  -d modesp_cloud -f infra/sql/app-grants.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -v app_user=modesp_cloud \
  -d modesp_cloud -f infra/sql/check-grants.sql

(cd backend && npm ci --omit=dev) && (cd webui && npm ci && npm run build)
sudo systemctl restart modesp-backend
curl -s http://localhost:3000/api/health | jq .
```

Відкату «одним рухом» тут немає — це головна відмінність від 4.1. Якщо
`/api/health` не піднявся, повертайтеся на попередній коміт (`git checkout
<sha>`, `npm ci --omit=dev`, рестарт); міграції при цьому лишаються — див.
розділ 6, вони сумісні зі старим кодом.

---

Три нові міграції:

| Міграція | Що робить | Скільки триває |
|---|---|---|
| **049** | видаляє дублікати в `events` і в **кожній** партиції `telemetry`, потім будує пʼять унікальних індексів | **важка** — залежить від обсягу; на великому парку години |
| **050** | створює `telemetry_dirty_hours` | секунди |
| **051** | знімає NOT NULL з `user_notification_prefs.quiet_tz`, обнуляє рядки з `'Europe/Kyiv'` | секунди |

Про 049 варто знати заздалегідь: вона **видаляє рядки** (дублікати, що
накопичилися, поки унікальних індексів не було), і без цього індекси не
збудуються. Виживає перший побачений рядок (найменший `id` для `events`,
найменший `ctid` для телеметрії). Скільки їх буде — можна порахувати
завчасно:

```sql
SELECT count(*) - count(DISTINCT (tenant_id, device_id, event_type, time)) AS dup_events FROM events;
```

Якщо число велике, робіть це у вікні обслуговування.

## 5. Перевірити і повернути таймер

Пробний запуск **без** `--apply` — він нічого не видаляє, лише рахує:

```bash
cd /opt/modesp-cloud/backend
sudo -u modesp node scripts/cleanup-telemetry.js | tee /tmp/retention-dry.txt
sudo -u modesp node scripts/cleanup-aux.js       | tee -a /tmp/retention-dry.txt
```

На що дивитися:

- **`Backfilled hours: N`** — скільки годин чекає на згортку. Після кроку 3.1
  має бути близько нуля; велике число означає, що backfill не спрацював.
- **`<slug>: N engineering row(s) older than 30 days`** — інженерні канали
  (`evap`, `cond`, `setpoint`, `comp`) тепер живуть 30 днів окремо від
  продуктових. Перший запуск після викочування видалить накопичене — число
  може бути великим, це очікувано.
- **`alarms: … (1095 days, the hourly archive horizon)`** — нижня межа
  доказових таблиць працює. Якщо в дужках 365 — щось не так із
  `HOURLY_RETENTION_DAYS`.

Якщо цифри збігаються з очікуваннями:

```bash
systemctl enable --now modesp-retention-cleanup.timer
systemctl list-timers modesp-retention-cleanup.timer --no-pager
```

## 6. Якщо треба відкотитися

Як саме — залежить від розкладки (розділ 4):

- **релізна:** `sudo /opt/modesp-cloud/infra/deploy.sh rollback` — перемикає
  symlink на `.previous`, рестарт, health-гейт;
- **git-checkout:** `git checkout <попередній sha>`, `(cd backend && npm ci
  --omit=dev)`, `(cd webui && npm ci && npm run build)`, рестарт — кроки ті
  самі, але вручну і без автоматичного гейту.

**Міграції в обох випадках лишаються застосованими** — усі три сумісні зі
старим кодом:

- 049 додає індекси й видаляє дублікати; старий код цього не помітить;
- 050 створює таблицю, якою старий код не користується;
- 051 робить колонку nullable — старий код читає `quiet_tz` з `|| 'Europe/Kyiv'`,
  тож `NULL` для нього означає те саме, що й раніше.

Відкат схеми потрібен лише при відновленні з архіву (розділ 5 `restore.md`).

## 7. Разові запити після викочування

Виправлення діють уперед. Ці чотири запити знаходять дані, зіпсовані до них.
Жоден нічого не змінює — усі лише показують.

### 7.1. Прошивки, що стали приватними замість платформених (PR #49)

Форма суперадміна передавала прапорець «платформна прошивка», а клієнт API його
не надсилав. Такі файли лягли як прошивки організації суперадміна й невидимі
тим, кому призначалися:

```sql
SELECT f.id, f.version, f.original_name, f.created_at, t.slug AS uploaded_into
  FROM firmwares f JOIN tenants t ON t.id = f.tenant_id
 WHERE f.tenant_id IS NOT NULL
   AND t.slug IN ('system', '<slug вашої організації-суперадміна>')
 ORDER BY f.created_at DESC;
```

Виправлення: перезавантажити файл через форму (тепер прапорець працює) або
проставити `tenant_id = NULL`, `visibility` вручну.

### 7.2. Активні тривоги на пристроях, яких організація вже не має (PR #50)

Передача пристрою не закривала відкриті рядки попереднього власника — вони
довічно рахувалися у зведенні:

```sql
SELECT a.tenant_id, t.slug, a.device_id, a.alarm_code, a.triggered_at
  FROM alarms a
  JOIN tenants t ON t.id = a.tenant_id
  LEFT JOIN devices d ON d.mqtt_device_id = a.device_id AND d.tenant_id = a.tenant_id
 WHERE a.active = true AND d.id IS NULL
 ORDER BY a.triggered_at;
```

Виправлення: `UPDATE alarms SET active = false, cleared_at = now() WHERE id IN (…)`.

### 7.3. Пристрої, що вказують на чужу модель обладнання (PR #57)

`PATCH /devices/:id` приймав будь-який `model_id`; енергорозрахунок брав
потужності з чужого обладнання:

```sql
SELECT d.tenant_id, d.mqtt_device_id, d.name, d.model_id, m.tenant_id AS model_owner
  FROM devices d JOIN device_models m ON m.id = d.model_id
 WHERE m.tenant_id <> d.tenant_id;
```

Після викочування такі рядки читаються як «моделі немає» (join несе
`m.tenant_id = d.tenant_id`), тож енергооцінка повертається до власних `*_kw`
пристрою. Прибрати посилання: `UPDATE devices SET model_id = NULL WHERE id IN (…)`.

### 7.4. Точки з часовим поясом, який не є назвою IANA (PR #57)

Такі значення кидають `RangeError` у кожному звіті, де є ця точка. PostgreSQL
знає повну базу IANA у системному вигляді `pg_timezone_names`, тож перевірка —
звичайний SQL:

```sql
SELECT id, tenant_id, name, timezone
  FROM sites
 WHERE timezone IS NOT NULL
   AND (timezone NOT IN (SELECT name FROM pg_timezone_names)
        -- три імені, які знає PostgreSQL і не приймає Intl.DateTimeFormat,
        -- тобто саме те, чим рендериться звіт
        OR timezone IN ('Factory', 'localtime', 'posixrules'));
```

Перевіряється проти бази часових поясів **цього сервера**, тож лишається
правильним і після оновлення tzdata. Для пари PostgreSQL 16 / Node 22 цей запит
точний: із 499 імен, які знає PostgreSQL, `Intl` відкидає рівно ці три.

Виправлення: задати правильну назву через WebUI (тепер форма не прийме хибну)
або `UPDATE sites SET timezone = NULL WHERE id IN (…)` — тоді звіт візьме пояс
організації.

## 8. Що змінилося у поведінці

Не помилки, а свідомі зміни, які варто знати черговому:

- **Інженерні канали живуть 30 днів.** `evap`, `cond`, `setpoint`, `comp`
  видаляються раніше за `air` і `defrost`. Графіки за старі періоди
  показуватимуть лише продуктові канали — це задумано (PR #43).
- **Масове розгортання прошивки — функція плану.** Організації на «Старті» й
  «Базовому» отримають `402 plan_feature` на груповому розгортанні; на один
  пристрій — як і раніше (PR #56).
- **Тихі години рахуються за поясом профілю.** Хто ставив собі пояс, відмінний
  від Києва, побачить зсув вікна тиші — на правильний (PR #56).
- **Публічна сторінка точки закритої організації віддає 404.** Раніше показувала
  назви й стан обладнання (PR #53).
