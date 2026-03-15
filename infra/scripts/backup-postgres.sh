#!/bin/bash
# ModESP Cloud — PostgreSQL backup script
# Runs daily via systemd timer (modesp-backup.timer)
#
# Environment variables (optional):
#   BACKUP_PASSPHRASE  — encrypt with GPG (AES-256) if set
#   BACKUP_REMOTE      — rsync destination for offsite copy
#                        e.g. "u123456@u123456.your-storagebox.de:backups/"
set -euo pipefail

BACKUP_DIR=/var/backups/modesp
RETENTION_DAYS=14
DB_NAME=modesp_cloud
DB_USER=modesp_cloud
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Dump + compress
pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner | gzip > "$FILE"

# Encrypt (if passphrase set)
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "$BACKUP_PASSPHRASE" "$FILE"
  rm "$FILE"
  FILE="${FILE}.gpg"
fi

# Offsite copy (if remote destination set)
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rsync -az "$FILE" "$BACKUP_REMOTE"
  echo "Offsite copy sent to: $BACKUP_REMOTE"
fi

# Prune backups older than retention period
find "$BACKUP_DIR" -name "${DB_NAME}_*" -mtime +${RETENTION_DAYS} -delete

echo "OK: $FILE ($(du -h "$FILE" | cut -f1))"
