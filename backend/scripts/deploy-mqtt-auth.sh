#!/bin/bash
# ═══════════════════════════════════════════════════════════
# ModESP Cloud — Deploy Phase 4: Dynamic MQTT Auth
# Run on VPS as root (or with sudo)
# ═══════════════════════════════════════════════════════════
set -euo pipefail

MODESP_DIR="/opt/modesp-cloud"
BACKEND_DIR="$MODESP_DIR/backend"
WEBUI_DIR="$MODESP_DIR/webui"
MOSQUITTO_CONF="/etc/mosquitto/conf.d/modesp.conf"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Pre-checks ────────────────────────────────────────────
info "=== Phase 4: Dynamic MQTT Auth Deployment ==="

[ -d "$MODESP_DIR" ] || error "ModESP Cloud not found at $MODESP_DIR"

# Check required env vars
if [ -z "${MQTT_BOOTSTRAP_PASSWORD:-}" ]; then
    echo ""
    warn "MQTT_BOOTSTRAP_PASSWORD not set."
    echo "  This is the shared password all ESP32 devices use for initial connection."
    echo "  Generate one: openssl rand -base64 16"
    echo "  Then set in $BACKEND_DIR/.env:"
    echo "    MQTT_BOOTSTRAP_PASSWORD=<your_password>"
    echo ""
    read -p "Enter MQTT_BOOTSTRAP_PASSWORD now (or Ctrl+C to abort): " MQTT_BOOTSTRAP_PASSWORD
    echo "MQTT_BOOTSTRAP_PASSWORD=$MQTT_BOOTSTRAP_PASSWORD" >> "$BACKEND_DIR/.env"
    info "Added to .env"
fi

# ── Step 1: Git pull ──────────────────────────────────────
info "Step 1: Pulling latest code..."
cd "$MODESP_DIR"
git pull origin main
info "Code updated."

# ── Step 2: Install backend dependencies ──────────────────
info "Step 2: Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --production
info "Dependencies installed."

# ── Step 3: Run migration 008 ────────────────────────────
info "Step 3: Running migration 008_mqtt_auth.sql..."
sudo -u postgres psql -d modesp_cloud -f "$BACKEND_DIR/src/db/migrations/008_mqtt_auth.sql"
info "Migration 008 applied."

# ── Step 4: Build mosquitto-go-auth (if not built) ───────
if [ ! -f /usr/lib/mosquitto/go-auth.so ]; then
    info "Step 4: Building mosquitto-go-auth plugin..."
    apt install -y golang-go libmosquitto-dev mosquitto-dev pkg-config git make build-essential

    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git clone --depth 1 https://github.com/iegomez/mosquitto-go-auth.git
    cd mosquitto-go-auth
    make
    mkdir -p /usr/lib/mosquitto
    cp go-auth.so /usr/lib/mosquitto/go-auth.so
    cd /
    rm -rf "$TMPDIR"
    info "mosquitto-go-auth built and installed."
else
    info "Step 4: mosquitto-go-auth already installed, skipping."
fi

# ── Step 5: Create PostgreSQL read-only user ──────────────
info "Step 5: Creating PostgreSQL read-only user for Mosquitto..."
read -sp "Enter password for modesp_mqtt_ro PostgreSQL user: " PG_RO_PASS
echo ""

sudo -u postgres psql -d modesp_cloud <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'modesp_mqtt_ro') THEN
        CREATE USER modesp_mqtt_ro WITH PASSWORD '$PG_RO_PASS';
    ELSE
        ALTER USER modesp_mqtt_ro WITH PASSWORD '$PG_RO_PASS';
    END IF;
END
\$\$;
GRANT CONNECT ON DATABASE modesp_cloud TO modesp_mqtt_ro;
GRANT USAGE ON SCHEMA public TO modesp_mqtt_ro;
GRANT SELECT ON devices, tenants TO modesp_mqtt_ro;
EOF
info "PostgreSQL user modesp_mqtt_ro ready."

# ── Step 5b: TLS Certificates (Let's Encrypt) ────────────
if [ ! -d /etc/mosquitto/certs ] || [ ! -f /etc/mosquitto/certs/server.crt ]; then
    info "Step 5b: Setting up TLS certificates..."
    read -p "Enter domain name (e.g. modesp.com.ua): " DOMAIN

    apt install -y certbot
    systemctl stop nginx 2>/dev/null || true
    certbot certonly --standalone -d "$DOMAIN"
    systemctl start nginx 2>/dev/null || true

    mkdir -p /etc/mosquitto/certs
    cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/mosquitto/certs/server.crt
    cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/mosquitto/certs/server.key
    chown mosquitto:mosquitto /etc/mosquitto/certs/*
    chmod 600 /etc/mosquitto/certs/server.key

    # Auto-renewal hook
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    cat > /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh <<RENEWEOF
#!/bin/bash
# Mosquitto TLS certs
cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/mosquitto/certs/server.crt
cp /etc/letsencrypt/live/$DOMAIN/privkey.pem /etc/mosquitto/certs/server.key
chown mosquitto:mosquitto /etc/mosquitto/certs/*
systemctl restart mosquitto
# Nginx picks up new certs automatically, just reload
systemctl reload nginx
RENEWEOF
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
    info "TLS certificates installed + auto-renewal hook created (Mosquitto + Nginx)."
else
    info "Step 5b: TLS certificates already present, skipping."
fi

ufw allow 8883/tcp 2>/dev/null || true

# ── Step 6: Update Mosquitto config ──────────────────────
info "Step 6: Updating Mosquitto configuration..."

# Backup current config
if [ -f "$MOSQUITTO_CONF" ]; then
    cp "$MOSQUITTO_CONF" "${MOSQUITTO_CONF}.bak.$(date +%Y%m%d_%H%M%S)"
    info "Backed up current config."
fi

# Install the repo's canonical config.
#
# WHY THIS IS NOT A HEREDOC ANY MORE
#   This step used to write its own frozen copy of auth_opt_pg_userquery /
#   auth_opt_pg_aclquery. That copy silently drifted from
#   infra/mosquitto/mosquitto.conf, and running the script REVERTED the broker to it:
#   no self-closing pending grant (migration 022), no 'deleted' branch, no
#   /backfill* publish suffixes, no bootstrap fallback, and `WHERE acl.rw = $2` with
#   no ($2 = 4 AND acl.rw = 1) mapping — which denies EVERY subscribe, so no device
#   on the platform could subscribe to cmd/+ at all.
#   There is now exactly one copy of those queries, in the repo, covered by
#   backend/test/device-acl-grace.test.js. The only deployment-time edit is the
#   read-only PostgreSQL password, substituted line-wise below (not via sed, so a
#   password containing / & or \ cannot corrupt the file).
REPO_MOSQ_CONF="$MODESP_DIR/infra/mosquitto/mosquitto.conf"
[ -f "$REPO_MOSQ_CONF" ] || error "Canonical config not found: $REPO_MOSQ_CONF"

TMP_CONF="${MOSQUITTO_CONF}.new.$$"
: > "$TMP_CONF"
chmod 0640 "$TMP_CONF"
subbed=0
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        '# auth_opt_pg_password'*)
            printf 'auth_opt_pg_password %s\n' "$PG_RO_PASS" >> "$TMP_CONF"
            subbed=1
            ;;
        *)
            printf '%s\n' "$line" >> "$TMP_CONF"
            ;;
    esac
done < "$REPO_MOSQ_CONF"

[ "$subbed" = 1 ] || { rm -f "$TMP_CONF"; error "No '# auth_opt_pg_password' placeholder in $REPO_MOSQ_CONF"; }

# Fail loudly rather than deploy a broker config that is missing a query, or one whose
# queries wrapped onto a second line (mosquitto has no line-continuation syntax).
for directive in auth_opt_pg_userquery auth_opt_pg_superquery auth_opt_pg_aclquery; do
    n=$(grep -c "^${directive} " "$TMP_CONF" || true)
    [ "$n" = "1" ] || { rm -f "$TMP_CONF"; error "$directive appears $n times in $REPO_MOSQ_CONF (expected exactly 1, on one line)"; }
done
grep -q 'd.last_seen <= d.assigned_at' "$TMP_CONF" \
    || { rm -f "$TMP_CONF"; error "ACL query is missing the migration 022 self-closing grant"; }
grep -qF '($2 = 4 AND acl.rw = 1)' "$TMP_CONF" \
    || { rm -f "$TMP_CONF"; error "ACL query is missing the SUBSCRIBE->READ mapping; no device could subscribe to cmd/+"; }

mv "$TMP_CONF" "$MOSQUITTO_CONF"
chown root:mosquitto "$MOSQUITTO_CONF" 2>/dev/null || true
chmod 0640 "$MOSQUITTO_CONF"

info "Mosquitto config updated."

# ── Step 7: Provision existing devices ────────────────────
info "Step 7: Provisioning MQTT credentials for existing devices..."
cd "$BACKEND_DIR"
echo ""
echo "  Dry run first (no changes):"
node scripts/provision-mqtt-creds.js
echo ""
read -p "Apply? (yes/no): " APPLY
if [ "$APPLY" = "yes" ]; then
    node scripts/provision-mqtt-creds.js --apply
    info "Credentials provisioned."
else
    warn "Skipped. Run manually later: node scripts/provision-mqtt-creds.js --apply"
fi

# ── Step 8: Build WebUI ──────────────────────────────────
info "Step 8: Building WebUI..."
cd "$WEBUI_DIR"
npm install
npm run build
info "WebUI built."

# ── Step 9: Restart services ─────────────────────────────
info "Step 9: Restarting services..."
systemctl restart mosquitto
sleep 2
systemctl restart modesp-backend
info "Services restarted."

# ── Step 10: Verify ──────────────────────────────────────
info "Step 10: Verification..."
echo ""

# Check Mosquitto
if systemctl is-active --quiet mosquitto; then
    echo -e "  Mosquitto: ${GREEN}running${NC}"
else
    echo -e "  Mosquitto: ${RED}FAILED${NC}"
    journalctl -u mosquitto -n 10 --no-pager
fi

# Check backend
sleep 3
if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo -e "  Backend:   ${GREEN}healthy${NC}"
else
    echo -e "  Backend:   ${RED}FAILED${NC}"
    journalctl -u modesp-backend -n 10 --no-pager
fi

# Test MQTT auth (localhost should still work)
if mosquitto_pub -h localhost -p 1883 -t "test/deploy" -m "ok" 2>/dev/null; then
    echo -e "  MQTT (localhost): ${GREEN}OK${NC}"
else
    echo -e "  MQTT (localhost): ${RED}FAILED${NC}"
fi

echo ""
info "=== Deployment complete ==="
echo ""
echo "Next steps:"
echo "  1. For existing ESP32 devices: enter new MQTT credentials"
echo "     via local WebUI (one-time, until firmware supports _set_mqtt_creds)"
echo "  2. Flash updated firmware (with _set_mqtt_creds handler) to devices"
echo "  3. New devices will auto-provision on assign (zero-touch)"
echo ""
echo "Rollback:"
echo "  cp ${MOSQUITTO_CONF}.bak.* $MOSQUITTO_CONF"
echo "  systemctl restart mosquitto"
echo ""
