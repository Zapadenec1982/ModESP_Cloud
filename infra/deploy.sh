#!/bin/bash
# ModESP Cloud — release deployment (plan epic 1.10).
#
#   deploy.sh init --yes                      convert the git checkout at /opt/modesp-cloud
#                                             into the release layout (once per server)
#   deploy.sh release <version> [--archive F] [--repo owner/repo] [--no-migrate] [--force]
#   deploy.sh rollback                        switch back to the previous release
#   deploy.sh status
#
# Layout (after init):
#   /opt/modesp-releases/releases/<version>/   extracted archives (build-release.sh)
#   /opt/modesp-releases/shared/               backend.env, firmware/, backup.env, webui.env
#   /opt/modesp-releases/downloads/            fetched archives + checksums
#   /opt/modesp-cloud -> releases/<version>    the symlink every unit, nginx and script uses
#
# A release: download + verify (or --archive), extract, npm ci --omit=dev, link
# the shared secrets, migrate.js --dry-run then apply as the schema owner, grant
# the application role, switch the symlink, restart the backend and wait for
# /api/health to say "ok" — otherwise the symlink goes back and the backend is
# restarted on the previous release. Migrations are never undone by rollback.
set -euo pipefail

APP_LINK="${APP_LINK:-/opt/modesp-cloud}"
BASE="${MODESP_RELEASES:-/opt/modesp-releases}"
RELEASES="$BASE/releases"
SHARED="$BASE/shared"
DOWNLOADS="$BASE/downloads"
APP_USER="${APP_USER:-modesp}"
REPO="${MODESP_REPO:-Zapadenec1982/ModESP_Cloud}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
WEBROOT_LINK="/var/www/modesp/webui"

log()  { printf '[deploy] %s\n' "$*"; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

env_value() {  # env_value KEY FILE
  grep -E "^$1=" "$2" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true
}

health_wait() {
  local i=0
  while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      log "health ok after ${i}s"
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  log "health check did not pass within ${HEALTH_TIMEOUT}s:"
  curl -sS --max-time 3 "$HEALTH_URL" || true
  echo
  return 1
}

switch_link() {  # switch_link TARGET — atomic replace of the symlink
  ln -sfn "$1" "$APP_LINK.tmp"
  mv -Tf "$APP_LINK.tmp" "$APP_LINK"
}

restart_backend() {
  systemctl daemon-reload
  systemctl restart modesp-backend
}

link_shared() {  # link_shared RELEASE_DIR
  local dir="$1"
  ln -sfn "$SHARED/backend.env" "$dir/backend/.env"
  local fw; fw="$(env_value FIRMWARE_STORAGE_PATH "$SHARED/backend.env")"
  if [ -z "$fw" ] || [ "${fw#/}" = "$fw" ]; then
    rm -rf "$dir/backend/firmware"
    ln -sfn "$SHARED/firmware" "$dir/backend/firmware"
  fi
  [ -f "$SHARED/backup.env" ] && ln -sfn "$SHARED/backup.env" "$dir/infra/backup.env"
  [ -f "$SHARED/webui.env" ]  && ln -sfn "$SHARED/webui.env"  "$dir/webui/.env"
  return 0
}

install_units() {  # install_units RELEASE_DIR
  cp "$1"/infra/systemd/modesp-*.service /etc/systemd/system/
  cp "$1"/infra/systemd/modesp-*.timer   /etc/systemd/system/
  mkdir -p "$(dirname "$WEBROOT_LINK")"
  ln -sfn "$APP_LINK/webui/dist" "$WEBROOT_LINK"
  ln -sfn "$APP_LINK/landing" "$(dirname "$WEBROOT_LINK")/landing"
  systemctl daemon-reload
}

run_migrations() {  # run_migrations RELEASE_DIR APPLY(0|1)
  local dir="$1" apply="$2"
  local db_name db_user
  db_name="$(env_value DB_NAME "$SHARED/backend.env")"; db_name="${db_name:-modesp_cloud}"
  db_user="$(env_value DB_USER "$SHARED/backend.env")"; db_user="${db_user:-modesp_cloud}"
  local pgenv=(env DB_HOST=/var/run/postgresql DB_PORT=5432 DB_NAME="$db_name" DB_USER=postgres DB_PASS=)
  log "migrations (dry run):"
  runuser -u postgres -- "${pgenv[@]}" node "$dir/backend/src/scripts/migrate.js" --dry-run
  if [ "$apply" = "1" ]; then
    runuser -u postgres -- "${pgenv[@]}" node "$dir/backend/src/scripts/migrate.js"
    runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -v app_user="$db_user" -v owner=postgres \
      -d "$db_name" -f "$dir/infra/sql/app-grants.sql"
    runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -v app_user="$db_user" \
      -d "$db_name" -f "$dir/infra/sql/check-grants.sql"
  else
    log "--no-migrate: pending migrations were NOT applied"
  fi
}

prune_releases() {  # keep the newest KEEP_RELEASES, never the current or previous
  local current previous
  current="$(readlink -f "$APP_LINK")"
  previous="$(cat "$BASE/.previous" 2>/dev/null || true)"
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
    [ "$old" = "$current" ] && continue
    [ "$old" = "$previous" ] && continue
    log "pruning $old"
    rm -rf "$old"
  done
}

fetch_archive() {  # fetch_archive VERSION -> prints archive path
  local version="$1" name="modesp-cloud-$1.tar.gz"
  local url="https://github.com/$REPO/releases/download/$version/$name"
  mkdir -p "$DOWNLOADS"
  log "downloading $url" >&2
  curl -fsSL --retry 3 -o "$DOWNLOADS/$name" "$url"
  curl -fsSL --retry 3 -o "$DOWNLOADS/$name.sha256" "$url.sha256"
  echo "$DOWNLOADS/$name"
}

verify_archive() {  # verify_archive FILE (expects FILE.sha256 next to it)
  [ -f "$1.sha256" ] || die "no checksum next to $1"
  (cd "$(dirname "$1")" && sha256sum -c --quiet "$(basename "$1").sha256") || die "checksum mismatch for $1"
  log "checksum ok"
}

cmd_init() {
  need_root
  local yes=0
  for a in "$@"; do [ "$a" = "--yes" ] && yes=1; done
  [ -L "$APP_LINK" ] && die "$APP_LINK is already a symlink — init was done"
  [ -d "$APP_LINK" ] || die "no checkout at $APP_LINK"
  [ -f "$APP_LINK/backend/.env" ] || die "$APP_LINK/backend/.env not found"
  if [ "$yes" != "1" ]; then
    cat <<MSG
This converts $APP_LINK (a git checkout) into the release layout:
  $APP_LINK             -> $RELEASES/checkout-<stamp> (symlink)
  backend/.env, backend/firmware, infra/backup.env, webui/.env -> $SHARED/
The backend is stopped for the move and started again (health-gated).
Re-run with --yes to proceed.
MSG
    exit 2
  fi
  local stamp checkout
  stamp="$(date +%Y%m%d%H%M%S)"
  checkout="$RELEASES/checkout-$stamp"
  mkdir -p "$RELEASES" "$SHARED" "$DOWNLOADS"

  log "stopping modesp-backend"
  systemctl stop modesp-backend || true
  mv "$APP_LINK" "$checkout"

  mv "$checkout/backend/.env" "$SHARED/backend.env"
  local fw; fw="$(env_value FIRMWARE_STORAGE_PATH "$SHARED/backend.env")"
  if [ -z "$fw" ] || [ "${fw#/}" = "$fw" ]; then
    if [ -d "$checkout/backend/firmware" ] && [ ! -L "$checkout/backend/firmware" ]; then
      mv "$checkout/backend/firmware" "$SHARED/firmware"
    fi
  fi
  install -d -o "$APP_USER" -g "$APP_USER" "$SHARED/firmware"
  [ -f "$checkout/infra/backup.env" ] && [ ! -L "$checkout/infra/backup.env" ] && mv "$checkout/infra/backup.env" "$SHARED/backup.env"
  [ -f "$checkout/webui/.env" ] && [ ! -L "$checkout/webui/.env" ] && mv "$checkout/webui/.env" "$SHARED/webui.env"
  chown "$APP_USER:$APP_USER" "$SHARED/backend.env"; chmod 600 "$SHARED/backend.env"
  [ -f "$SHARED/backup.env" ] && chown root:root "$SHARED/backup.env" && chmod 600 "$SHARED/backup.env"
  chmod 755 "$BASE" "$RELEASES" "$SHARED"

  link_shared "$checkout"
  switch_link "$checkout"
  install_units "$checkout"
  log "starting modesp-backend"
  systemctl start modesp-backend
  health_wait || die "backend did not become healthy after init — inspect: journalctl -u modesp-backend -n 100"
  log "init done: $APP_LINK -> $checkout; secrets in $SHARED"
}

cmd_release() {
  need_root
  local version="${1:-}"; shift || true
  [ -n "$version" ] || die "usage: deploy.sh release <version> [--archive FILE] [--no-migrate] [--force]"
  local archive="" migrate=1 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --archive) archive="$2"; shift 2 ;;
      --repo)    REPO="$2"; shift 2 ;;
      --no-migrate) migrate=0; shift ;;
      --force)   force=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -L "$APP_LINK" ] || die "$APP_LINK is not a symlink — run 'deploy.sh init --yes' first"
  [ -f "$SHARED/backend.env" ] || die "$SHARED/backend.env missing"

  local target="$RELEASES/$version"
  if [ -d "$target" ]; then
    [ "$force" = "1" ] || die "$target exists — use --force to re-extract"
    rm -rf "$target"
  fi
  [ -n "$archive" ] || archive="$(fetch_archive "$version")"
  [ -f "$archive" ] || die "archive not found: $archive"
  verify_archive "$archive"

  log "extracting to $target"
  mkdir -p "$target"
  tar -xzf "$archive" -C "$target" --strip-components=1
  [ -f "$target/backend/package.json" ] || die "archive does not look like a ModESP release"
  chown -R "$APP_USER:$APP_USER" "$target"

  log "installing backend dependencies"
  (cd "$target/backend" && runuser -u "$APP_USER" -- npm ci --omit=dev --no-audit --no-fund)
  link_shared "$target"

  run_migrations "$target" "$migrate"

  local previous; previous="$(readlink -f "$APP_LINK")"
  echo "$previous" > "$BASE/.previous"
  log "switching $APP_LINK: $previous -> $target"
  switch_link "$target"
  install_units "$target"
  restart_backend
  if ! health_wait; then
    log "ROLLING BACK to $previous"
    switch_link "$previous"
    install_units "$previous"
    restart_backend
    health_wait || log "previous release is not healthy either — manual intervention needed"
    die "release $version failed the health gate; $APP_LINK points back to $previous"
  fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || log "nginx reload skipped"
  prune_releases
  log "release $version is live ($(cat "$target/VERSION" 2>/dev/null || echo '?'))"
}

cmd_rollback() {
  need_root
  local previous current
  previous="$(cat "$BASE/.previous" 2>/dev/null || true)"
  [ -n "$previous" ] && [ -d "$previous" ] || die "no previous release recorded in $BASE/.previous"
  current="$(readlink -f "$APP_LINK")"
  [ "$previous" != "$current" ] || die "previous release is already live"
  log "rolling back: $current -> $previous (migrations are NOT undone)"
  echo "$current" > "$BASE/.previous"
  switch_link "$previous"
  install_units "$previous"
  restart_backend
  health_wait || die "rollback target is not healthy — inspect: journalctl -u modesp-backend -n 100"
  log "rollback done: $APP_LINK -> $previous"
}

cmd_status() {
  echo "app link:  $APP_LINK -> $(readlink -f "$APP_LINK" 2>/dev/null || echo '(not a symlink)')"
  echo "version:   $(cat "$APP_LINK/VERSION" 2>/dev/null || echo '(git checkout)')"
  echo "previous:  $(cat "$BASE/.previous" 2>/dev/null || echo '-')"
  echo "releases:"; ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::; s:^:  :' || echo "  (none)"
  echo "backend:   $(systemctl is-active modesp-backend 2>/dev/null || echo unknown)"
  curl -sS --max-time 3 "$HEALTH_URL" 2>/dev/null || true; echo
}

case "${1:-}" in
  init)     shift; cmd_init "$@" ;;
  release)  shift; cmd_release "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  status)   shift; cmd_status "$@" ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac
