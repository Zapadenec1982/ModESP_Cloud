#!/bin/bash
# ModESP Cloud — backup script
#
# Produces ONE self-contained archive per run:
#   modesp_backup_<UTC timestamp>.tar[.gpg]
#     manifest.txt   what, when, from where, sizes, sha256 of every member
#     globals.sql    pg_dumpall --globals-only (roles incl. the app/MQTT roles)
#     db.dump        pg_dump --format=custom --no-owner of the application DB
#     files.tar.gz   backend/.env, firmware store, FCM key, webui/.env,
#                    /etc/mosquitto, /etc/letsencrypt, nginx site, systemd units
#
# Runs daily as root from modesp-backup.timer. pg_dump is executed as the
# postgres OS user over the local socket (peer auth, no password), the files
# above are readable by root only. Restore procedure: docs/runbooks/restore.md.
#
# Configuration (all optional): /opt/modesp-cloud/infra/backup.env,
# template infra/backup.env.example.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/modesp-cloud}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/modesp}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-30}"
BACKUP_GROUP="${BACKUP_GROUP:-modesp}"
DB_NAME="${BACKUP_DB_NAME:-modesp_cloud}"
PG_OS_USER="${BACKUP_PG_OS_USER:-postgres}"
SSH_OPTS="${BACKUP_SSH_OPTS:-}"

TS=$(date -u +%Y%m%d_%H%M%S)
NAME="modesp_backup_${TS}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log()  { echo "[backup] $*"; }
fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

# Read KEY=value from a dotenv file (last occurrence wins, quotes stripped).
env_value() {
  local file="$1" key="$2" line
  [ -r "$file" ] || return 0
  line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

# Run a Postgres client tool: as the postgres OS user over the socket by
# default, or over TCP with a password when BACKUP_DB_PASSWORD is set.
pg_as_admin() {
  if [ -n "${BACKUP_DB_PASSWORD:-}" ]; then
    PGPASSWORD="$BACKUP_DB_PASSWORD" "$@" \
      -h "${BACKUP_DB_HOST:-localhost}" -p "${BACKUP_DB_PORT:-5432}" -U "${BACKUP_DB_USER:-postgres}"
  else
    # env -u: EnvironmentFile=-infra/backup.env is read by systemd into this
    # unit's environment, and a libpq variable left there by an older, TCP-based
    # backup script (PGHOST=localhost) makes psql open a TCP connection instead
    # of the socket — peer auth never applies and the dump dies on
    # "password authentication failed for user postgres". Scrub the connection
    # variables so this branch always means "postgres over the local socket".
    runuser -u "$PG_OS_USER" -- env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD "$@"
  fi
}

mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"
chgrp "$BACKUP_GROUP" "$BACKUP_DIR" 2>/dev/null || true

# ── 1. Database ───────────────────────────────────────────────────────────────
log "dumping database $DB_NAME"
DB_SIZE_BYTES=$(pg_as_admin psql -d "$DB_NAME" -Atc "SELECT pg_database_size(current_database())")
# Role password hashes stay in globals.sql on purpose: the app and MQTT roles
# must come back with the credentials that backend/.env and mosquitto carry.
pg_as_admin pg_dumpall --globals-only > "$WORK/globals.sql"
pg_as_admin pg_dump -d "$DB_NAME" --format=custom --no-owner > "$WORK/db.dump"
pg_restore --list "$WORK/db.dump" > /dev/null || fail "db.dump is not a readable pg_dump archive"

# ── 2. Files ──────────────────────────────────────────────────────────────────
BACKEND_ENV="$APP_DIR/backend/.env"
FCM_PATH=$(env_value "$BACKEND_ENV" FCM_SERVICE_ACCOUNT_PATH)
FW_PATH=$(env_value "$BACKEND_ENV" FIRMWARE_STORAGE_PATH)
# Relative paths in .env are relative to the backend directory.
FW_PATH="${FW_PATH#./}"; FCM_PATH="${FCM_PATH#./}"
[ -n "$FW_PATH" ] && [ "${FW_PATH#/}" = "$FW_PATH" ] && FW_PATH="$APP_DIR/backend/$FW_PATH"
[ -n "$FCM_PATH" ] && [ "${FCM_PATH#/}" = "$FCM_PATH" ] && FCM_PATH="$APP_DIR/backend/$FCM_PATH"

CANDIDATES=(
  "$BACKEND_ENV"
  "$APP_DIR/webui/.env"
  "$APP_DIR/infra/backup.env"
  "${FW_PATH:-$APP_DIR/backend/firmware}"
  "${FCM_PATH:-}"
  /etc/mosquitto/conf.d
  /etc/mosquitto/acl.conf
  /etc/mosquitto/passwd
  /etc/mosquitto/certs
  /etc/letsencrypt
  /etc/nginx/sites-available/modesp
  /etc/nginx/conf.d/modesp-ratelimit.conf
)
for u in /etc/systemd/system/modesp-*; do CANDIDATES+=("$u"); done
for extra in ${BACKUP_EXTRA_PATHS:-}; do CANDIDATES+=("$extra"); done

FILES=()
for p in "${CANDIDATES[@]}"; do
  [ -n "$p" ] && [ -e "$p" ] && FILES+=("${p#/}")
done
log "archiving ${#FILES[@]} path(s)"
tar -C / -czf "$WORK/files.tar.gz" --ignore-failed-read "${FILES[@]}"

# ── 3. Manifest + bundle ──────────────────────────────────────────────────────
{
  echo "archive=$NAME"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname -f 2>/dev/null || hostname)"
  echo "app_dir=$APP_DIR"
  echo "release=$(cat "$APP_DIR/VERSION" 2>/dev/null || echo checkout)"
  echo "git_commit=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "db_name=$DB_NAME"
  echo "db_size_bytes=$DB_SIZE_BYTES"
  echo "pg_dump_version=$(pg_dump --version | awk '{print $3}')"
  echo "dump_format=custom (pg_restore)"
  echo "files:"
  for f in "${FILES[@]}"; do echo "  /$f"; done
  echo "sha256:"
  (cd "$WORK" && sha256sum globals.sql db.dump files.tar.gz | sed 's/^/  /')
} > "$WORK/manifest.txt"

ARCHIVE="$BACKUP_DIR/$NAME.tar"
tar -cf "$ARCHIVE" -C "$WORK" manifest.txt globals.sql db.dump files.tar.gz
chmod 600 "$ARCHIVE"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
    --passphrase-fd 3 --output "$ARCHIVE.gpg" "$ARCHIVE" 3<<<"$BACKUP_PASSPHRASE"
  rm -f "$ARCHIVE"
  ARCHIVE="$ARCHIVE.gpg"
  chmod 600 "$ARCHIVE"
fi
ARCHIVE_BYTES=$(stat -c %s "$ARCHIVE")

# ── 4. Off-site copy + remote prune ───────────────────────────────────────────
OFFSITE=no
if [ -n "${BACKUP_REMOTE:-}" ]; then
  # shellcheck disable=SC2086
  rsync -az --chmod=F600 -e "ssh -o BatchMode=yes $SSH_OPTS" "$ARCHIVE" "$BACKUP_REMOTE" \
    || fail "off-site copy to $BACKUP_REMOTE failed"
  OFFSITE=yes
  log "off-site copy sent to $BACKUP_REMOTE"

  # Prune remote archives older than BACKUP_REMOTE_RETENTION_DAYS by the date
  # in their file name (independent of remote mtimes). Needs SFTP on the
  # remote; a failure here is a warning, never a failed backup.
  REMOTE_HOST="${BACKUP_REMOTE%%:*}"
  REMOTE_PATH="${BACKUP_REMOTE#*:}"; REMOTE_PATH="${REMOTE_PATH%/}"; REMOTE_PATH="${REMOTE_PATH:-.}"
  if [ "$REMOTE_HOST" != "$BACKUP_REMOTE" ]; then
    CUTOFF=$(date -u -d "-${BACKUP_REMOTE_RETENTION_DAYS} days" +%Y%m%d)
    # shellcheck disable=SC2086
    REMOTE_LIST=$(printf 'ls -1 %s\n' "$REMOTE_PATH" | sftp -q -o BatchMode=yes $SSH_OPTS -b - "$REMOTE_HOST" 2>/dev/null || true)
    BATCH=""
    while IFS= read -r entry; do
      base=$(basename "$entry")
      [[ "$base" =~ ^modesp_backup_([0-9]{8})_[0-9]{6}\.tar(\.gpg)?$ ]] || continue
      if [ "${BASH_REMATCH[1]}" -lt "$CUTOFF" ]; then
        BATCH+="rm $REMOTE_PATH/$base"$'\n'
      fi
    done <<< "$REMOTE_LIST"
    if [ -n "$BATCH" ]; then
      # shellcheck disable=SC2086
      if printf '%s' "$BATCH" | sftp -q -o BatchMode=yes $SSH_OPTS -b - "$REMOTE_HOST" >/dev/null 2>&1; then
        log "pruned $(printf '%s' "$BATCH" | grep -c .) remote archive(s) older than $BACKUP_REMOTE_RETENTION_DAYS days"
      else
        log "WARNING: remote prune failed (SFTP); old archives remain on $REMOTE_HOST"
      fi
    fi
  fi
fi

# ── 5. Local prune + success marker ───────────────────────────────────────────
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'modesp_backup_*.tar' -o -name 'modesp_backup_*.tar.gpg' \
     -o -name 'modesp_cloud_*.sql.gz' -o -name 'modesp_cloud_*.sql.gz.gpg' \) \
  -mtime "+${BACKUP_RETENTION_DAYS}" -delete

{
  echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "archive=$(basename "$ARCHIVE")"
  echo "archive_bytes=$ARCHIVE_BYTES"
  echo "db_size_bytes=$DB_SIZE_BYTES"
  echo "offsite=$OFFSITE"
} > "$BACKUP_DIR/last-success"
chmod 644 "$BACKUP_DIR/last-success"

log "OK: $ARCHIVE ($(numfmt --to=iec "$ARCHIVE_BYTES" 2>/dev/null || echo "$ARCHIVE_BYTES B"), db $(numfmt --to=iec "$DB_SIZE_BYTES" 2>/dev/null || echo "$DB_SIZE_BYTES B"), offsite=$OFFSITE)"
