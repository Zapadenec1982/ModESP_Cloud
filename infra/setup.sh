#!/bin/bash
# ModESP Cloud — VPS Setup Script
# Target: Ubuntu 24.04 LTS
# Run as root: bash setup.sh
#
# Prerequisites: fresh VPS with SSH access
# Domain: modesp.com.ua (DNS A record pointing to VPS IP) — override with DOMAIN=...

set -euo pipefail

DOMAIN="${DOMAIN:-modesp.com.ua}"
APP_DIR="/opt/modesp-cloud"
APP_USER="modesp"
DB_NAME="modesp_cloud"
DB_USER="modesp_cloud"

echo "=== ModESP Cloud VPS Setup ==="

# ── 1. System packages ────────────────────────────────────
echo "[1/8] Installing packages..."
apt-get update
apt-get install -y \
  postgresql-16 \
  mosquitto mosquitto-clients \
  nginx certbot python3-certbot-nginx \
  nodejs npm \
  fail2ban ufw \
  curl git

# ── 2. Firewall ───────────────────────────────────────────
echo "[2/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp      # HTTP (redirect to HTTPS)
ufw allow 443/tcp     # HTTPS
ufw allow 8883/tcp    # MQTTS (devices)
ufw --force enable

# ── 3. Application user ───────────────────────────────────
echo "[3/8] Creating app user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
fi

# ── 4. PostgreSQL ──────────────────────────────────────────
echo "[4/8] Setting up PostgreSQL..."
DB_PASS="${DB_PASS:?ERROR: Set DB_PASS environment variable before running setup}"
sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || true
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# mosquitto-go-auth's read-only role must exist BEFORE the migrations run:
# migration 011 grants it SELECT on mqtt_bootstrap. deploy-mqtt-auth.sh later
# sets the password the broker actually uses (MQTT_RO_DB_PASS pre-seeds it).
MQTT_RO_DB_PASS="${MQTT_RO_DB_PASS:-$(openssl rand -hex 16)}"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modesp_mqtt_ro') THEN
    CREATE USER modesp_mqtt_ro WITH PASSWORD '$MQTT_RO_DB_PASS';
  END IF;
END \$\$;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT CONNECT ON DATABASE $DB_NAME TO modesp_mqtt_ro;"

echo "  → Apply schema..."
sudo -u postgres psql -d "$DB_NAME" -f "$APP_DIR/backend/src/db/schema.sql"

# ── 5. Mosquitto ───────────────────────────────────────────
echo "[5/8] Setting up Mosquitto..."
cp "$APP_DIR/infra/mosquitto/mosquitto.conf" /etc/mosquitto/conf.d/modesp.conf
cp "$APP_DIR/infra/mosquitto/acl.conf" /etc/mosquitto/acl.conf

# Create password file
MQTT_BACKEND_PASS="${MQTT_BACKEND_PASS:?ERROR: Set MQTT_BACKEND_PASS environment variable}"
mosquitto_passwd -c -b /etc/mosquitto/passwd modesp_backend "$MQTT_BACKEND_PASS"
# Add device passwords via API after deployment

# TLS certs directory (symlink after certbot)
mkdir -p /etc/mosquitto/certs
echo "  → TLS certs: run certbot first, then symlink to /etc/mosquitto/certs/"

systemctl restart mosquitto
systemctl enable mosquitto

# ── 6. Application ────────────────────────────────────────
echo "[6/8] Setting up backend..."
mkdir -p "$APP_DIR"
# Assuming repo is cloned to APP_DIR already:
# git clone https://github.com/Zapadenec1982/ModESP_Cloud.git $APP_DIR

cd "$APP_DIR/backend"
npm ci --omit=dev

# Create .env from template
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  → Edit $APP_DIR/backend/.env with real credentials!"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/backend/.env"

# Migrations on top of schema.sql, recorded in schema_migrations. DDL must run
# as the schema owner, so the runner connects as postgres over the socket
# (peer auth); the explicit DB_* variables win over the ones in .env.
echo "  → Apply migrations..."
sudo -u postgres env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME="$DB_NAME" DB_USER=postgres DB_PASS= \
  node "$APP_DIR/backend/src/scripts/migrate.js"

# The schema is owned by postgres; the app role gets DML only (DDL stays with the
# owner, which is what migrate.js above relies on). Default privileges cover
# tables that future migrations create.
echo "  → Grant application privileges..."
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v app_user="$DB_USER" -v owner=postgres -d "$DB_NAME" \
  -f "$APP_DIR/infra/sql/app-grants.sql"
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB_NAME" \
  -c "GRANT USAGE ON SCHEMA public TO modesp_mqtt_ro; GRANT SELECT ON devices, tenants TO modesp_mqtt_ro;"
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v app_user="$DB_USER" -d "$DB_NAME" \
  -f "$APP_DIR/infra/sql/check-grants.sql"

# ── 7. Systemd ────────────────────────────────────────────
echo "[7/8] Installing systemd units..."
cp "$APP_DIR"/infra/systemd/modesp-*.service /etc/systemd/system/
cp "$APP_DIR"/infra/systemd/modesp-*.timer   /etc/systemd/system/

# Backup configuration (secrets: passphrase, off-site destination) + archive dir
mkdir -p /var/backups/modesp
chmod 750 /var/backups/modesp
chgrp "$APP_USER" /var/backups/modesp
if [ ! -f "$APP_DIR/infra/backup.env" ]; then
  cp "$APP_DIR/infra/backup.env.example" "$APP_DIR/infra/backup.env"
  chown root:root "$APP_DIR/infra/backup.env"
  chmod 600 "$APP_DIR/infra/backup.env"
  echo "  → Edit $APP_DIR/infra/backup.env (BACKUP_PASSPHRASE, BACKUP_REMOTE)"
fi

# journald cap (500 MB / 30 days) — every ModESP unit logs to the journal
mkdir -p /etc/systemd/journald.conf.d
cp "$APP_DIR/infra/journald/modesp.conf" /etc/systemd/journald.conf.d/modesp.conf
systemctl restart systemd-journald

systemctl daemon-reload
systemctl enable modesp-backend
for t in modesp-backup modesp-telemetry-partition modesp-retention-cleanup; do
  systemctl enable --now "$t.timer"
done

# Partitions for the next 6 months right away (the timer only fires on the 25th).
# Needs the real DB_PASS in backend/.env; on a first run that is still empty.
sudo -u "$APP_USER" node "$APP_DIR/backend/src/scripts/ensure-partitions.js" \
  || echo "  → ensure-partitions failed — set DB_PASS in backend/.env, then: systemctl start modesp-telemetry-partition.service"

echo "  → Start backend: systemctl start modesp-backend"

# ── 8. Nginx + TLS ────────────────────────────────────────
echo "[8/8] Setting up Nginx..."
cp "$APP_DIR/infra/nginx/modesp.conf" /etc/nginx/sites-available/modesp

# Static roots: the landing page at "/", the app at /cloud/
mkdir -p /var/www/modesp
ln -sfn "$APP_DIR/landing"    /var/www/modesp/landing
ln -sfn "$APP_DIR/webui/dist" /var/www/modesp/webui
# Defines the `zone=api` rate-limit zone referenced by modesp.conf
cp "$APP_DIR/infra/nginx/ratelimit.conf" /etc/nginx/conf.d/modesp-ratelimit.conf
ln -sf /etc/nginx/sites-available/modesp /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# certbot deploy hook: copies renewed certs to Mosquitto and reloads both services
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cp "$APP_DIR/infra/scripts/tls-deploy-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh

# Get TLS cert (requires DNS to be configured)
echo "  → Run: certbot --nginx -d $DOMAIN  (the deploy hook then installs the cert for Mosquitto)"

nginx -t && systemctl reload nginx

# ── Done ───────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
echo ""
echo "TODO:"
echo "  1. Edit $APP_DIR/backend/.env (DB password, MQTT password, JWT secret)"
echo "  2. Run: certbot --nginx -d $DOMAIN"
echo "  3. Install the cert for Mosquitto (also runs automatically on every renewal):"
echo "     RENEWED_LINEAGE=/etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh"
echo "  4. Update Mosquitto passwords: mosquitto_passwd -b /etc/mosquitto/passwd ..."
echo "  5. Start: systemctl start modesp-backend"
echo "  6. Verify: curl http://localhost:3000/api/health"
echo "  7. Backups: edit $APP_DIR/infra/backup.env, run the first one by hand:"
echo "     systemctl start modesp-backup.service && cat /var/backups/modesp/last-success"
echo "  8. Timers: systemctl list-timers 'modesp-*'   (backup, partitions, daily retention)"
echo "  9. Alerts: set PLATFORM_ALERT_CHAT_ID in backend/.env, then test:"
echo "     systemctl start 'modesp-alert@smoke-test.service'"
echo "     Restore procedure: $APP_DIR/docs/runbooks/restore.md"
echo ""

echo ""
echo "  → Releases: this checkout is the bootstrap. Switch to tagged releases with"
echo "     $APP_DIR/infra/deploy.sh init --yes   (once)"
echo "     $APP_DIR/infra/deploy.sh release vX.Y.Z   (docs/DEPLOYMENT.md, «Оновлення»)"
