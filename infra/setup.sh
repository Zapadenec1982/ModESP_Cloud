#!/bin/bash
# ModESP Cloud — VPS Setup Script
# Target: Ubuntu 24.04 LTS
# Run as root: bash setup.sh
#
# Prerequisites: fresh VPS with SSH access
# Domain: cloud.modesp.com (DNS A record pointing to VPS IP)

set -euo pipefail

DOMAIN="cloud.modesp.com"
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
sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD 'CHANGE_ME';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || true
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

echo "  → Apply schema..."
sudo -u postgres psql -d "$DB_NAME" -f "$APP_DIR/backend/src/db/schema.sql"

# ── 5. Mosquitto ───────────────────────────────────────────
echo "[5/8] Setting up Mosquitto..."
cp "$APP_DIR/infra/mosquitto/mosquitto.conf" /etc/mosquitto/conf.d/modesp.conf
cp "$APP_DIR/infra/mosquitto/acl.conf" /etc/mosquitto/acl.conf

# Create password file
mosquitto_passwd -c -b /etc/mosquitto/passwd modesp_backend "CHANGE_ME_BACKEND"
# Add device password (example)
# mosquitto_passwd -b /etc/mosquitto/passwd device_F27FCD "CHANGE_ME_DEVICE"

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
npm install --production

# Create .env from template
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  → Edit $APP_DIR/backend/.env with real credentials!"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 7. Systemd ────────────────────────────────────────────
echo "[7/8] Installing systemd units..."
cp "$APP_DIR/infra/systemd/modesp-backend.service" /etc/systemd/system/
cp "$APP_DIR/infra/systemd/modesp-telemetry-partition.service" /etc/systemd/system/
cp "$APP_DIR/infra/systemd/modesp-telemetry-partition.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable modesp-backend
systemctl enable modesp-telemetry-partition.timer
systemctl start modesp-telemetry-partition.timer

echo "  → Start backend: systemctl start modesp-backend"

# ── 8. Nginx + TLS ────────────────────────────────────────
echo "[8/8] Setting up Nginx..."
cp "$APP_DIR/infra/nginx/modesp.conf" /etc/nginx/sites-available/modesp
ln -sf /etc/nginx/sites-available/modesp /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Get TLS cert (requires DNS to be configured)
echo "  → Run: certbot --nginx -d $DOMAIN"
echo "  → Then symlink certs for Mosquitto TLS"

nginx -t && systemctl reload nginx

# ── Done ───────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
echo ""
echo "TODO:"
echo "  1. Edit $APP_DIR/backend/.env (DB password, MQTT password, JWT secret)"
echo "  2. Run: certbot --nginx -d $DOMAIN"
echo "  3. Symlink TLS certs for Mosquitto:"
echo "     ln -s /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/mosquitto/certs/server.crt"
echo "     ln -s /etc/letsencrypt/live/$DOMAIN/privkey.pem /etc/mosquitto/certs/server.key"
echo "     ln -s /etc/letsencrypt/live/$DOMAIN/chain.pem /etc/mosquitto/certs/ca.crt"
echo "  4. Update Mosquitto passwords: mosquitto_passwd -b /etc/mosquitto/passwd ..."
echo "  5. Start: systemctl start modesp-backend"
echo "  6. Verify: curl http://localhost:3000/api/health"
echo ""
