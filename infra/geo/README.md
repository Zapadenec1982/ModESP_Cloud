# Self-hosted гео-сервіси (епік 1.2)

Публічний Nominatim, демо-сервер OSRM, Open-Meteo без ключа і публічні тайли OSM —
лише для некомерційного використання. ModESP Cloud — комерційний продукт, тому в
`NODE_ENV=production` бекенд **відмовляється стартувати**, поки хоч один із них
налаштований (`backend/src/lib/licensing-check.js`), якщо не задано свідомо
`ALLOW_NONCOMMERCIAL_GEO=true`. Що куди переходить:

| Сервіс | Рішення | Де | Орієнтовна ціна |
|---|---|---|---|
| Nominatim (геокодування) | self-hosted, витяг України | цей compose, `nominatim` | ~0 (диск ~15 GB, RAM 2–4 GB) |
| OSRM (маршрути, об'їзд) | self-hosted, витяг України | цей compose, `osrm` | ~0 (RAM ~1 GB) |
| Open-Meteo (погода) | платний план + `WEATHER_API_KEY`, або `WEATHER_PROVIDER=none` | `backend/.env` | ~29 EUR/міс |
| Тайли карти | MapTiler / Stadia / Thunderforest | `webui/.env` + `MAP_TILE_HOSTS` + nginx CSP | ~20–25 EUR/міс |
| OpenRouteService (ізохрони) | лишається вимкненим; кільця «приблизно» | — | 0 |

Сервер: staging/демо (CX32: 4 vCPU, 8 GB, 80 GB) або окремий. Продакшен-бекенд ходить до
них через приватну мережу Hetzner (порти 5000/8080 слухають лише `127.0.0.1`, тож або
`network_mode` з приватним IP, або SSH-тунель/WireGuard між серверами).

## Запуск

```bash
apt-get install -y docker.io docker-compose-v2
cd /opt/modesp-cloud/infra/geo
./prepare-osrm.sh                    # ~10 хв: витяг ~700 MB, препроцесинг
NOMINATIM_PASSWORD=$(openssl rand -hex 16) docker compose up -d
docker compose logs -f nominatim     # перший імпорт України: 1–2 год
```

Перевірка:

```bash
curl -s 'http://127.0.0.1:5000/route/v1/driving/30.52,50.45;24.02,49.84?overview=false' | head -c 200
curl -s 'http://127.0.0.1:8080/search?q=Хрещатик+22,+Київ&format=jsonv2' | head -c 300
```

`backend/.env` на сервері, що використовує ці інстанси:

```
GEOCODER_URL=http://<приватний-ip>:8080
GEOCODER_BULK_ENABLED=true          # лише для власного інстансу
GEOCODER_RATE_LIMIT_MS=0
OSRM_URL=http://<приватний-ip>:5000
ORS_MIN_INTERVAL_MS=0               # без квоти на власному ORS (якщо колись підніметься)
```

## Оновлення даних

- OSRM: `./prepare-osrm.sh && docker compose restart osrm` раз на місяць (таймер systemd за
  зразком `modesp-backup.timer`, або вручну).
- Nominatim: контейнер сам тягне добові оновлення Geofabrik (`REPLICATION_UPDATE_INTERVAL`).

## Перевірка після переходу

Через добу після зміни `.env` у журналі бекенду не має бути звернень до
`nominatim.openstreetmap.org` і `router.project-osrm.org`:

```bash
journalctl -u modesp-backend --since -1d | grep -c -E 'nominatim.openstreetmap.org|router.project-osrm.org'   # → 0
```
