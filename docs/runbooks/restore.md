# Runbook: відновлення ModESP Cloud з архіву

Покрокова процедура відновлення платформи на чистому сервері з добового архіву
`modesp-backup.timer`. Розрахована на одну людину без доступу до старого сервера.

| | |
|---|---|
| **RPO (точка відновлення)** | ≤ 24 год: архів робиться щодня о 02:00; втрачаються дані після останнього архіву |
| **RTO (час відновлення)** | ціль ≤ 4 год; заміряно на репетиції — див. розділ 9 |
| **Що потрібно** | доступ до off-site сховища (`BACKUP_REMOTE`), passphrase GPG (якщо `BACKUP_PASSPHRASE` задано), доступ до DNS домену |
| **Остання репетиція** | 2026-09-02, локальний стенд (розділ 9) |

## 1. Що в архіві

`modesp_backup_<UTC-мітка>.tar` (або `.tar.gpg`):

| Член | Вміст | Як використовується |
|---|---|---|
| `manifest.txt` | хост, коміт, розмір БД, версія `pg_dump`, перелік файлів, sha256 кожного члена | перевірка цілісності, вибір коміту для checkout |
| `globals.sql` | `pg_dumpall --globals-only`: ролі `modesp_cloud`, `modesp_mqtt_ro` з хешами паролів | крок 4 |
| `db.dump` | `pg_dump --format=custom --no-owner` бази `modesp_cloud` | крок 5 |
| `files.tar.gz` | `backend/.env`, `webui/.env`, сховище прошивок, ключ FCM, `/etc/mosquitto/{conf.d,acl.conf,passwd,certs}`, `/etc/letsencrypt`, `/etc/nginx/sites-available/modesp`, `/etc/nginx/conf.d/modesp-ratelimit.conf`, `/etc/systemd/system/modesp-*`, `infra/backup.env` | крок 6 |

## 2. Отримати і перевірити архів

```bash
# на новому сервері, від root
mkdir -p /root/restore && cd /root/restore

# з off-site сховища (параметри — з backup.env старого сервера або з пам'яті)
rsync -e "ssh -o Port=23" 'u123456@u123456.your-storagebox.de:modesp/modesp_backup_*' .
ls -1 modesp_backup_* | tail -n 3          # обрати найновіший (мітка UTC у назві)

# розшифрувати, якщо .gpg
gpg --batch --decrypt --output modesp_backup_X.tar modesp_backup_X.tar.gpg

# розпакувати і звірити контрольні суми
mkdir x && tar -xf modesp_backup_X.tar -C x && cd x
cat manifest.txt
sha256sum -c <(sed -n '/^sha256:/,$p' manifest.txt | tail -n +2 | sed 's/^  //')
pg_restore --list db.dump | head             # дамп читається
```

Якщо контрольні суми не збігаються — взяти попередній архів. Не відновлювати з пошкодженого.

## 3. Базова система

```bash
git clone https://github.com/Zapadenec1982/ModESP_Cloud.git /opt/modesp-cloud
cd /opt/modesp-cloud && git checkout <git_commit з manifest.txt>   # той самий код, що й дані

# Пакети, користувач, firewall — як у infra/setup.sh, але БЕЗ його кроків 4 і 7
# (схему й міграції дасть дамп; юніти повернуться з files.tar.gz):
apt-get update && apt-get install -y postgresql-16 mosquitto mosquitto-clients \
  nginx certbot python3-certbot-nginx nodejs npm fail2ban ufw curl git
useradd -r -m -s /bin/bash modesp || true
ufw allow ssh && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 8883/tcp && ufw --force enable
cd /opt/modesp-cloud/backend && npm ci --omit=dev
cd /opt/modesp-cloud/webui && npm ci && npm run build
```

mosquitto-go-auth збирається за `docs/DEPLOYMENT.md` (розділ MQTT Auth) — це єдиний крок, який не
входить у пакети дистрибутива; його конфіг повернеться з архіву на кроці 6.

## 4. Ролі PostgreSQL

```bash
# globals.sql містить CREATE ROLE для всіх ролей старого сервера, включно з паролями.
# Ролі, що вже існують (postgres), дадуть помилку "already exists" — це нормально.
sudo -u postgres psql -f /root/restore/x/globals.sql 2>&1 | grep -v 'already exists' || true
sudo -u postgres psql -Atc "\du" | grep -E 'modesp_cloud|modesp_mqtt_ro'   # обидві ролі є
```

## 5. База даних

```bash
sudo -u postgres psql -c "CREATE DATABASE modesp_cloud OWNER modesp_cloud;"

# Відновлення від postgres: усі об'єкти стануть власністю postgres (як на старому сервері),
# SECURITY DEFINER функції партицій працюватимуть від власника схеми.
time sudo -u postgres pg_restore --no-owner --exit-on-error -d modesp_cloud /root/restore/x/db.dump

# Права застосункової ролі (дамп зберігає GRANT-и, але після --no-owner їх варто перевірити)
sudo -u postgres psql -d modesp_cloud -c "
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO modesp_cloud;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO modesp_cloud;
  GRANT EXECUTE ON FUNCTION create_telemetry_partition(INT, INT) TO modesp_cloud;
  GRANT EXECUTE ON FUNCTION drop_telemetry_partition(TEXT) TO modesp_cloud;"
sudo -u postgres psql -d modesp_cloud -c "GRANT SELECT ON devices, tenants, mqtt_bootstrap TO modesp_mqtt_ro;"

# Перевірка
sudo -u postgres psql -d modesp_cloud -Atc "
  SELECT 'tenants='||count(*) FROM tenants UNION ALL
  SELECT 'devices='||count(*) FROM devices UNION ALL
  SELECT 'telemetry='||count(*) FROM telemetry UNION ALL
  SELECT 'migrations='||count(*) FROM schema_migrations UNION ALL
  SELECT 'last_telemetry='||max(time)::text FROM telemetry;"
```

`last_telemetry` показує фактичну точку відновлення (RPO) для цього інциденту.

## 6. Файли, конфіги, сертифікати

```bash
cd /root/restore/x
tar -xzf files.tar.gz -C / --no-same-owner --keep-directory-symlink
# tar відновлює абсолютні шляхи старого сервера: /opt/modesp-cloud/backend/.env,
# /opt/modesp-cloud/backend/firmware/…, /etc/mosquitto/…, /etc/letsencrypt/…,
# /etc/nginx/…, /etc/systemd/system/modesp-*, /opt/modesp-cloud/infra/backup.env

chown -R modesp:modesp /opt/modesp-cloud
chmod 600 /opt/modesp-cloud/backend/.env
chown root:root /opt/modesp-cloud/infra/backup.env && chmod 600 /opt/modesp-cloud/infra/backup.env
chmod 600 /etc/mosquitto/passwd 2>/dev/null; chown mosquitto:mosquitto /etc/mosquitto/passwd 2>/dev/null

# nginx: symlink сайту і статики WebUI
ln -sf /etc/nginx/sites-available/modesp /etc/nginx/sites-enabled/modesp
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/modesp && ln -sfn /opt/modesp-cloud/webui/dist /var/www/modesp/webui
nginx -t

# Сертифікати: якщо /etc/letsencrypt відновлено — certbot їх підхопить після зміни DNS
# (certbot renew --dry-run). Якщо ні — certbot --nginx -d modesp.com.ua після кроку 8.
```

## 7. Сервіси

```bash
systemctl daemon-reload
systemctl enable --now postgresql mosquitto nginx
systemctl enable --now modesp-backend
for t in modesp-backup modesp-telemetry-partition modesp-telemetry-cleanup modesp-retention-cleanup; do
  systemctl enable --now "$t.timer"
done

curl -s http://localhost:3000/api/health | jq .        # db: ok, mqtt: ok
journalctl -u modesp-backend -n 50 --no-pager
mosquitto_sub -h localhost -p 8883 --cafile /etc/mosquitto/certs/ca.crt -t 'modesp/#' -C 1 -W 10 \
  -u <mqtt-логін-пристрою> -P <пароль>                 # опційно: канал приймає дані

# перший бекап з нового сервера — цикл замкнуто
systemctl start modesp-backup.service && cat /var/backups/modesp/last-success
```

## 8. DNS і пристрої

1. Змінити A-запис `modesp.com.ua` на IP нового сервера (TTL DNS визначає, як швидко
   контролери перепідключаться; MQTT-клієнт ModESP_v4 перепідключається сам).
2. Перевірити вхід у WebUI, карту, один пристрій онлайн, одну тестову аварію в Telegram.
3. Записати в цей файл дату, фактичні RTO/RPO і що пішло не так.

## 9. Результати репетицій

| Дата | Середовище | Обсяг | Бекап | `pg_restore` | Повний RTO | RPO | Примітки |
|---|---|---|---|---|---|---|---|
| 2026-09-02 | локальний стенд (4 vCPU, PostgreSQL 16.13), не CX22 | 1 орг., 50 пристроїв × 4 канали × 5 хв × 30 днів = 1,73 млн рядків телеметрії, 58 тис. подій; БД 547 MB | 3,3 с, архів 24 MB | 13,3 с, усі лічильники збіглися, `SECURITY DEFINER` функції і GRANT-и на місці, застосункова роль створює партиції та пише телеметрію | лише БД і архів: < 1 хв; кроки 3 і 6–8 не виконувались (нема чистого VPS у стенді), оцінка ≤ 1,5 год | — (синтетичні дані) | Перша повна репетиція на CX22 — після розгортання staging (епік 1.10); заповнити рядок нижче |
| | CX22 staging | | | | | | |

Екстраполяція: `pg_restore` custom-формату йде ~130 MB/хв на стенді; для БД 5 GB це ≈ 40 хв,
тобто ціль RTO ≤ 4 год лишається з запасом на встановлення пакетів, mosquitto-go-auth і DNS.
Розмір продакшн-БД записує кожен архів у `manifest.txt` (`db_size_bytes`) і маркер
`/var/backups/modesp/last-success`.

## 10. Часті помилки

| Симптом | Причина | Дія |
|---|---|---|
| `pg_restore: error: could not execute query: ERROR: role "modesp_cloud" does not exist` | пропущено крок 4 | виконати `globals.sql`, повторити крок 5 з `DROP DATABASE` |
| `permission denied for table …` у логах бекенду | GRANT-и не застосовано | блок GRANT з кроку 5 |
| `no partition of relation "telemetry" found for row` | дамп із минулого місяця, нових партицій нема | `sudo -u modesp node backend/src/scripts/ensure-partitions.js` |
| контролери не підключаються після DNS | старий IP у кеші або сертифікат не для домену | `certbot --nginx -d modesp.com.ua`, symlink у `/etc/mosquitto/certs`, `systemctl restart mosquitto` |
| `gpg: decryption failed: Bad session key` | не той passphrase | passphrase зберігається окремо від сервера (менеджер паролів засновника) |
