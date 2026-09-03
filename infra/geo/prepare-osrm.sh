#!/bin/bash
# Download the Ukraine extract and preprocess it for OSRM (MLD pipeline).
# Re-run monthly to refresh the road network; osrm-routed needs a restart after.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/osrm
cd data/osrm
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
echo "→ downloading ukraine-latest.osm.pbf (Geofabrik)"
curl -fL --retry 3 -o ukraine-latest.osm.pbf https://download.geofabrik.de/europe/ukraine-latest.osm.pbf
echo "→ osrm-extract (car profile)"
docker run --rm -t -v "$PWD:/data" "$IMG" osrm-extract -p /opt/car.lua /data/ukraine-latest.osm.pbf
echo "→ osrm-partition / osrm-customize"
docker run --rm -t -v "$PWD:/data" "$IMG" osrm-partition /data/ukraine-latest.osrm
docker run --rm -t -v "$PWD:/data" "$IMG" osrm-customize /data/ukraine-latest.osrm
echo "→ done: $(du -sh . | cut -f1) in $PWD; now: docker compose up -d osrm"
