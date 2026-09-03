# Third-Party Geo Services — Licensing Checklist

> **Status: enforced.** ModESP Cloud is a commercial product. Since plan epic 1.2 the backend
> **refuses to start with `NODE_ENV=production`** while any of the free / non-commercial endpoints
> below is configured (`backend/src/lib/licensing-check.js`), unless the operator sets
> `ALLOW_NONCOMMERCIAL_GEO=true` knowingly (a demo server). The self-hosted stack lives in
> `infra/geo/` (OSRM + Nominatim on the Ukraine extract, Docker); weather needs a paid Open-Meteo
> key (`WEATHER_API_KEY`), tiles a paid provider (`VITE_MAP_TILE_URL`, `MAP_TILE_HOSTS`, nginx CSP).
> Weather and the service-round planner are plan features (`weather`, `routing`: network and
> partner plans only, migration 031), so their cost is carried by the plans that pay for it.

## Services in use

| Service | Powers | Current setting | Terms today | Required before production | Env var |
|---|---|---|---|---|---|
| **Nominatim** (OSM) | Address geocoding, autocomplete, reverse geocoding | Public endpoint | ⚠️ Free public endpoint. Hard limit **1 req/s**, identifying `User-Agent` required, **bulk geocoding prohibited** | Self-host Nominatim, or move to a paid geocoder (MapTiler / LocationIQ / Geoapify) | `GEOCODER_URL`, `GEOCODER_PROVIDER` |
| **Open-Meteo** | Outdoor weather at each site; IANA timezone per site | **Enabled for demo** | ⚠️ Free tier is **non-commercial use only** | Paid Open-Meteo plan, or self-host their API | `WEATHER_PROVIDER` |
| **OSRM** | Route to device, service-round (TSP) optimisation | **Public demo server** | ⚠️ `router.project-osrm.org` is a **community demo server — explicitly not for production**. Rate-limited, no SLA, may disappear | Self-host OSRM (Docker image + regional OSM extract) | `OSRM_URL` |
| **OpenRouteService** | Coverage isochrones (15/30/60 min drive time) | **Disabled** (no key) | Free tier needs an API key, is rate-limited and commercially restricted | ORS paid plan, or self-host ORS/Valhalla | `ORS_API_KEY` |
| **OpenStreetMap tiles** | The map itself | Public tile server | ⚠️ [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) — no heavy or commercial use | Paid tile provider (MapTiler / Thunderforest / Stadia) or self-hosted tiles | `VITE_MAP_TILE_URL` |

## Attribution — required now, not later

`© OpenStreetMap contributors` is already rendered on every map. **Do not remove it.** OSM data is licensed
under the [ODbL](https://opendatacommons.org/licenses/odbl/), which requires attribution regardless of
whether you use the free or a paid tile provider. The same applies to Nominatim results.

## Graceful degradation — already built in

Every one of these services is ENV-gated and degrades to a working, disabled state:

- `WEATHER_PROVIDER=` empty → weather widgets and the outdoor-temperature chart overlay hide themselves;
  site timezones must then be set manually.
- `OSRM_URL=` empty → the service-round planner hides itself; single-destination route deep-links
  (Google / Apple / Waze / OSM) still work, because they are plain URLs and need no API.
- `ORS_API_KEY=` empty → isochrones fall back to straight-line distance rings, **visibly labelled as
  approximate** in the UI.

So switching a service off while you sort out licensing never breaks the platform — it only removes that
feature.

## Definition of done for production

- [x] Nominatim: self-hosted (`infra/geo/docker-compose.yml`, `GEOCODER_URL` → own instance, `GEOCODER_BULK_ENABLED=true` only there); the public endpoint is blocked in production
- [ ] Open-Meteo: plan purchased, `WEATHER_API_KEY` set (customer host is used automatically) — or `WEATHER_PROVIDER=none`; the keyless public host is blocked in production
- [x] OSRM: self-hosted (`infra/geo/prepare-osrm.sh` + compose, `OSRM_URL` → own instance); the demo server is blocked in production
- [x] OpenRouteService: stays disabled; isochrones fall back to visibly approximate rings
- [ ] Map tiles: paid provider — `VITE_MAP_TILE_URL` + `VITE_MAP_ATTRIBUTION` (webui/.env), `MAP_TILE_HOSTS` (backend/.env, helmet CSP) and `img-src` in both CSP headers of `infra/nginx/modesp.conf`; OSM tile hosts in `MAP_TILE_HOSTS` are blocked in production
- [x] `© OpenStreetMap contributors` attribution kept on every map surface (`VITE_MAP_ATTRIBUTION` default)
- [x] Rate limits: `GEOCODER_RATE_LIMIT_MS=0` and `ORS_MIN_INTERVAL_MS=0` are correct only for own instances (documented in `infra/geo/README.md`)
- [x] Gating: `weather` and `routing` plan features (network / enterprise / partner)
- [x] Startup check + unit test (`backend/test/licensing-check.test.js`); `.env.example` banner replaced by the guard's description
- [ ] After the switch: `journalctl -u modesp-backend --since -1d | grep -c -E 'nominatim.openstreetmap.org|router.project-osrm.org'` = 0

Items left unchecked need money or an account (Open-Meteo, tiles) or the production switch itself.

## Related

- `backend/.env.example` — the demo configuration block and its warning banner
- `docs/DEPLOYMENT.md` — production deployment steps
- `docs/ROADMAP.md` — carries this as an explicit production blocker
