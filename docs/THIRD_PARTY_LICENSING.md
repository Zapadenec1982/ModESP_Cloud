# Third-Party Geo Services — Licensing Checklist

> **Status: DEMO.** ModESP Cloud currently uses the services below under their **free / non-commercial**
> terms, because the platform is a demo / pre-production system.
>
> **ModESP Cloud is a commercial product.** Every service marked ⚠️ below must move to a paid plan or a
> self-hosted instance **before the platform serves paying customers.** This is a production blocker, not a
> nice-to-have.

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

- [ ] Nominatim: self-hosted, or replaced with a paid geocoder
- [ ] Open-Meteo: paid plan purchased, or self-hosted
- [ ] OSRM: self-hosted (the demo server is removed from `.env`)
- [ ] OpenRouteService: paid plan + key, or self-hosted, or the isochrone feature is switched off
- [ ] Map tiles: paid provider or self-hosted; `VITE_MAP_TILE_URL` and attribution updated
- [ ] `© OpenStreetMap contributors` attribution verified on every map surface
- [ ] Rate limits and timeouts re-checked against the new providers' quotas
- [ ] This checklist reviewed and the demo banner removed from `backend/.env.example`

## Related

- `backend/.env.example` — the demo configuration block and its warning banner
- `docs/DEPLOYMENT.md` — production deployment steps
- `docs/ROADMAP.md` — carries this as an explicit production blocker
