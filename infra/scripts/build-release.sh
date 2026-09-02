#!/bin/bash
# Build a ModESP Cloud release archive (plan epic 1.10).
#
#   infra/scripts/build-release.sh <version> [out-dir]
#
# Produces <out-dir>/modesp-cloud-<version>.tar.gz and its .sha256. The archive
# holds exactly what a server needs: backend runtime files (no tests, no
# node_modules — deploy.sh runs `npm ci --omit=dev` on the server), the built
# WebUI, infra/, docs/ and the licence files, plus VERSION and RELEASE.json.
# The GitHub "Release" workflow calls it on a tag; the staging workflow calls
# it for every merge into main; it also works on a laptop.
set -euo pipefail

VERSION="${1:?usage: build-release.sh <version> [out-dir]}"
OUT="${2:-release}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="modesp-cloud-$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ ! -f "$ROOT/webui/dist/index.html" ]; then
  echo "webui/dist is missing — building the WebUI first"
  (cd "$ROOT/webui" && npm ci --no-audit --no-fund && npm run build)
fi

mkdir -p "$STAGE/$NAME/backend" "$STAGE/$NAME/webui"
cp "$ROOT/backend/package.json" "$ROOT/backend/package-lock.json" "$ROOT/backend/.env.example" "$STAGE/$NAME/backend/"
cp -r "$ROOT/backend/src" "$ROOT/backend/scripts" "$STAGE/$NAME/backend/"
# Never ship plaintext emulator credentials or a local .env, whatever the checkout holds
find "$STAGE/$NAME/backend" \( -name 'emulator-fleet*.csv' -o -name '.env' -o -name '*.bin' \) -delete
cp -r "$ROOT/webui/dist" "$STAGE/$NAME/webui/dist"
[ -f "$ROOT/webui/.env.example" ] && cp "$ROOT/webui/.env.example" "$STAGE/$NAME/webui/"
cp -r "$ROOT/infra" "$STAGE/$NAME/infra"
rm -f "$STAGE/$NAME/infra/backup.env"
cp -r "$ROOT/docs" "$STAGE/$NAME/docs"
for f in README.md CHANGELOG.md COMMERCIAL-LICENSE.md LICENSE LICENSE.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/$NAME/"
done

COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "$VERSION" > "$STAGE/$NAME/VERSION"
printf '{ "version": "%s", "commit": "%s", "built_at": "%s" }\n' \
  "$VERSION" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/$NAME/RELEASE.json"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")

echo "Built $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1)) from $COMMIT"
