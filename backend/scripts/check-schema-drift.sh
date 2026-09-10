#!/usr/bin/env bash
# Guards the invariant every database in the field depends on:
#
#     schema.sql applied to an empty database
#   ==  baseline.sql + every migration
#
# A production database was created from whatever schema.sql said on its install
# day and has been carried forward by migrations ever since. When a structural
# change lands in schema.sql without a migration behind it, a fresh install gets
# it and production never does — silently, because nothing compared the two.
# That is how idx_events_dedup and four telemetry partition unique indexes went
# missing in the field while every test and every CI run stayed green; both back
# an `ON CONFLICT DO NOTHING` written without a conflict target, so their absence
# raises nothing and simply stops deduplicating (migration 049).
#
# Usage:
#   PGURL=postgresql://user:pass@host:port  backend/scripts/check-schema-drift.sh
#
# PGURL must point at a server, not a database — the script creates and drops two
# scratch databases (drift_head_$$ / drift_base_$$) on it.
set -euo pipefail

: "${PGURL:?set PGURL to a postgres server URL, e.g. postgresql://postgres:ci@localhost:5432}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$HERE/../src/db"
HEAD_DB="drift_head_$$"
BASE_DB="drift_base_$$"
WORK="$(mktemp -d)"

cleanup() {
  psql "$PGURL/postgres" -q -c "DROP DATABASE IF EXISTS $HEAD_DB" >/dev/null 2>&1 || true
  psql "$PGURL/postgres" -q -c "DROP DATABASE IF EXISTS $BASE_DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

parse() { # host / port / user / pass out of the URL, for the node migration runner
  python3 - "$1" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
print(p.hostname or 'localhost'); print(p.port or 5432)
print(u.unquote(p.username or '')); print(u.unquote(p.password or ''))
PY
}
mapfile -t CONN < <(parse "$PGURL")

build() { # $1 = database name, $2 = schema file to start from
  psql "$PGURL/postgres" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $1"
  psql "$PGURL/$1" -q -v ON_ERROR_STOP=1 -f "$2"
  DB_HOST="${CONN[0]}" DB_PORT="${CONN[1]}" DB_NAME="$1" \
  DB_USER="${CONN[2]}" DB_PASS="${CONN[3]}" \
    node "$HERE/../src/scripts/migrate.js" >/dev/null
}

dump() { # $1 = database name, $2 = output file
  {
    echo "-- columns"
    psql -At "$PGURL/$1" -c "SELECT table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'-') FROM information_schema.columns WHERE table_schema='public' ORDER BY 1"
    echo "-- indexes"
    psql -At "$PGURL/$1" -c "SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1"
    echo "-- constraints"
    psql -At "$PGURL/$1" -c "SELECT conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1"
    echo "-- functions"
    psql -At "$PGURL/$1" -c "SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1"
    echo "-- triggers"
    psql -At "$PGURL/$1" -c "SELECT tgrelid::regclass||' '||tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1"
  } > "$2"
}

echo "building $HEAD_DB from schema.sql + migrations"
build "$HEAD_DB" "$DB_DIR/schema.sql"
echo "building $BASE_DB from baseline.sql + migrations"
build "$BASE_DB" "$DB_DIR/baseline.sql"

# ── docs/DATABASE.md: the tables that carry no tenant_id ────────────────
# The manual states multi-tenancy as a principle, so the list of tables that
# escape it has to be exact — it is the list a reader checks a new query
# against. It drifted to one table while the schema had nine.
echo "checking the tenantless-table list in docs/DATABASE.md"
psql -At "$PGURL/$HEAD_DB" -c "
  SELECT t.table_name FROM information_schema.tables t
   WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     AND t.table_name NOT LIKE 'telemetry\_%'
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                        AND c.column_name = 'tenant_id')
   ORDER BY 1" | sed '/^$/d' > "$WORK/tenantless-schema.txt"

awk '
  /<!-- tenantless-tables:/ { inblock = 1; next }
  inblock && /^\| `/ { gsub(/^\| `/, ""); sub(/`.*$/, ""); print }
  inblock && /^## / { inblock = 0 }
' "$HERE/../../docs/DATABASE.md" | sort > "$WORK/tenantless-doc.txt"

if ! diff -u "$WORK/tenantless-doc.txt" "$WORK/tenantless-schema.txt" > "$WORK/tenantless.diff"; then
  echo
  echo "docs/DATABASE.md — «Таблиці без tenant_id» does not match the schema."
  echo "  '-' lines: listed in the manual but the table does carry tenant_id (or is gone)"
  echo "  '+' lines: in the schema without tenant_id and missing from the manual"
  echo
  cat "$WORK/tenantless.diff"
  echo
  echo "Give the new table a tenant_id, or add a row to that table in docs/DATABASE.md"
  echo "saying why it stands outside multi-tenancy."
  exit 1
fi
echo "the tenantless-table list matches the schema ($(wc -l < "$WORK/tenantless-schema.txt") tables)"

dump "$HEAD_DB" "$WORK/head.txt"
dump "$BASE_DB" "$WORK/base.txt"

if diff -u "$WORK/base.txt" "$WORK/head.txt" > "$WORK/drift.diff"; then
  echo "no drift: a fresh install and a migrated database have the same catalog"
  exit 0
fi

echo
echo "SCHEMA DRIFT — a fresh install and a migrated database differ."
echo "  '-' lines: only a migrated (production) database has it"
echo "  '+' lines: only a fresh install from schema.sql has it"
echo
cat "$WORK/drift.diff"
echo
echo "Every structural change needs a migration as well as the schema.sql edit."
exit 1
