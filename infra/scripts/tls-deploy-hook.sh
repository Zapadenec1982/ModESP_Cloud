#!/bin/bash
# ModESP Cloud — certbot deploy hook.
# Installs the renewed Let's Encrypt certificate for Mosquitto (port 8883) and
# reloads nginx. certbot runs it after every successful renewal.
#
# Install:
#   cp /opt/modesp-cloud/infra/scripts/tls-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
#   chmod +x /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
# Test without a renewal:
#   RENEWED_LINEAGE=/etc/letsencrypt/live/modesp.com.ua /etc/letsencrypt/renewal-hooks/deploy/modesp-tls.sh
set -euo pipefail

DOMAIN="${DOMAIN:-modesp.com.ua}"
LIVE="${RENEWED_LINEAGE:-/etc/letsencrypt/live/$DOMAIN}"
CERT_DIR=/etc/mosquitto/certs

install -o mosquitto -g mosquitto -m 644 "$LIVE/fullchain.pem" "$CERT_DIR/server.crt"
install -o mosquitto -g mosquitto -m 600 "$LIVE/privkey.pem"   "$CERT_DIR/server.key"

# Mosquitto 2.x re-reads certfile/keyfile on SIGHUP, which keeps every device
# session up. Verify the served certificate actually changed and fall back to a
# restart (one reconnect storm) only when it did not.
systemctl reload mosquitto || true
sleep 2
want=$(openssl x509 -in "$CERT_DIR/server.crt" -noout -fingerprint -sha256 | cut -d= -f2)
have=$(echo | openssl s_client -connect 127.0.0.1:8883 -servername "$DOMAIN" 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)
if [ "$want" != "$have" ]; then
  echo "modesp-tls: broker still serves the previous certificate after reload — restarting mosquitto"
  systemctl restart mosquitto
else
  echo "modesp-tls: mosquitto picked up the new certificate on reload"
fi

systemctl reload nginx
echo "modesp-tls: done ($LIVE)"
