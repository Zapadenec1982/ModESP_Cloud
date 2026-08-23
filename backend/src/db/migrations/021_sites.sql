-- Migration 021: Sites (торгові точки) + geo infrastructure
-- Phase: Geo/Location full integration.
--
-- Predecessor: 020_telegram_id_unique.sql (this file assumes 018_device_geo.sql,
-- 018_soft_delete_devices.sql and 019_energy_monitoring.sql have already been applied —
-- it reads devices.location / devices.status / devices.deleted_at in the backfill).
--
-- Creates:
--   sites                 — normalized trade point (country/region/city/address + coords)
--   geocode_cache         — global, tenant-agnostic Nominatim response cache
--   devices.site_id       — device → site link, plus a backfill from devices.location
--   user_sites            — site-level RBAC grants
--   weather_observations  — historical outdoor conditions per site
--   site_public_links     — public read-only status page tokens (sha256 hashes only)
--   users.base_*          — technician home base for "nearest technician"
--
-- Run (as the schema OWNER — DDL requires table ownership; on prod the app role
-- only holds DML grants, see src/scripts/migrate.js):
--   sudo -u postgres psql -d modesp_cloud -f backend/src/db/migrations/021_sites.sql
--   sudo -u postgres psql -d modesp_cloud -c "INSERT INTO schema_migrations (id) VALUES ('021_sites.sql')"
--
-- IDEMPOTENCY GUARANTEE
--   Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING, and re-running this
--   file never overwrites a devices.site_id that was set after the first run: the
--   backfill UPDATE is guarded by `d.site_id IS NULL`, so it only ever fills, never
--   moves. This matters because re-runs are a live scenario — test/helpers/migrate.js
--   replays every migration on top of schema.sql, and the prod runbook has operators
--   apply DDL by hand and then record it.
--
-- NO ROW-LEVEL SECURITY ON THE NEW TABLES — a decision, not an oversight.
--   The RLS layer in schema.sql is dormant: nothing in backend/src ever calls
--   set_config('app.current_tenant', …). Enabling RLS on tables created by `postgres`
--   while the app connects as a non-owner role would return zero rows for every geo
--   query in production. Tenant isolation for these tables is enforced the same way it
--   is everywhere else in this codebase: an explicit `tenant_id = $n` predicate on every
--   query, plus the composite (tenant_id, site_id) foreign keys declared below.
--
-- NO updated_at TRIGGER — also a decision.
--   There is no set_updated_at() function anywhere in backend/src/db/ and this migration
--   does not add one. Instead, EVERY `UPDATE sites …` statement in the codebase must
--   append the literal `updated_at = NOW()` to its SET list (the PATCH handler, the
--   geocode writer, and the timezone fill).

-- ============================================================
-- Sites (торгові точки)
-- ============================================================
-- name is VARCHAR(256), not 128: devices.location is VARCHAR(256) and updateDeviceSchema
-- accepts location up to 256 chars, so a 129-char location would make the backfill INSERT
-- below fail with 22001 and — since src/scripts/migrate.js wraps each file in one
-- transaction — roll back the whole migration on prod data only.
--
-- tenant_id cascades: routes/tenants.js hard-deletes tenants with a hand-maintained child
-- list that will never include sites; without the cascade every tenant deletion raises
-- 23503. The cascade in turn fires devices.site_id → SET NULL.
CREATE TABLE IF NOT EXISTS sites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(256) NOT NULL,      -- назва торгової точки, e.g. "АТБ №142"
  country_code  CHAR(2),                    -- ISO 3166-1 alpha-2, 'UA'
  country       VARCHAR(64),
  region        VARCHAR(128),               -- область / region
  city          VARCHAR(128),
  address_line  VARCHAR(256),               -- вулиця, будинок
  postal_code   VARCHAR(16),
  latitude      DOUBLE PRECISION CHECK (latitude  >= -90  AND latitude  <= 90),
  longitude     DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180),
  geo_source    VARCHAR(16) NOT NULL DEFAULT 'none'
                CHECK (geo_source IN ('none','geocoded','manual','failed')),
  geo_precision VARCHAR(16),                -- 'house' | 'street' | 'city' | 'region' | 'country'
  geocoded_at   TIMESTAMPTZ,
  geo_attempts  SMALLINT NOT NULL DEFAULT 0,
  geo_last_attempt_at TIMESTAMPTZ,
  geo_error     TEXT,
  osm_type      VARCHAR(16),
  osm_id        BIGINT,
  timezone      VARCHAR(64),                -- IANA, e.g. 'Europe/Kyiv'
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, id)   -- composite-FK target for user_sites / weather_observations / site_public_links
);

-- Case-insensitive, whitespace-insensitive name uniqueness per tenant. Replaces the
-- plain UNIQUE (tenant_id, name): the backfill and every "find or create site" path
-- normalize with lower(btrim(...)), so the constraint must normalize identically.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sites_tenant_name ON sites (tenant_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_sites_tenant  ON sites (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sites_city    ON sites (tenant_id, city);
CREATE INDEX IF NOT EXISTS idx_sites_region  ON sites (tenant_id, region);
CREATE INDEX IF NOT EXISTS idx_sites_country ON sites (tenant_id, country_code);
-- /api/map/devices bbox filtering and every "sites that can be drawn" query
CREATE INDEX IF NOT EXISTS idx_sites_coords  ON sites (tenant_id, latitude, longitude) WHERE latitude IS NOT NULL;
-- POST /api/sites/geocode-pending + GET /api/sites/geocode-status
CREATE INDEX IF NOT EXISTS idx_sites_geocode_pending ON sites (tenant_id) WHERE geo_source = 'none';

-- ============================================================
-- Geocode cache
-- ============================================================
-- Deliberately GLOBAL (no tenant_id): the key is a normalized public address string and the
-- value is a public OSM/Nominatim response. Nothing tenant-derived is stored or returned.
--
-- expires_at splits the two lifetimes: positive entries live GEOCODER_CACHE_TTL_DAYS (180),
-- negative entries GEOCODER_NEGATIVE_TTL_MIN (360 = 6 h). Only a successful HTTP 200 from
-- the provider is ever cached — a timeout / 429 / 5xx writes nothing, so one Nominatim blip
-- can never make an address un-geocodable for half a year.
CREATE TABLE IF NOT EXISTS geocode_cache (
  query_hash  CHAR(64) PRIMARY KEY,         -- sha256 of the normalized query
  query_text  TEXT NOT NULL,
  provider    VARCHAR(24) NOT NULL,
  result      JSONB,                        -- NULL = negative cache (provider answered, no match)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Reads filter on expires_at > NOW(); the eviction sweep deletes expires_at < NOW().
CREATE INDEX IF NOT EXISTS idx_geocode_cache_expires ON geocode_cache (expires_at);

-- ============================================================
-- devices.site_id
-- ============================================================
-- No composite FK devices (tenant_id, site_id) → sites (tenant_id, id) — a decision.
-- Five shipped code paths move a device to another tenant without touching site_id
-- (devices.js soft delete, bulk delete, reset-pending, POST /:id/reassign, and the tenant
-- delete in routes/tenants.js). A composite FK turns every one of those into a runtime
-- 23503, including in routes/tenants.js. Tenant consistency is enforced instead by the
-- ON DELETE CASCADE above, by the mandatory `AND s.tenant_id = d.tenant_id` predicate on
-- every devices↔sites join, and by an explicit `site_id = NULL` in each of those five paths.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_site ON devices (site_id) WHERE site_id IS NOT NULL;

-- ── Backfill: one site per distinct (tenant_id, devices.location) ─────────────
-- Both statements MUST use the identical normalization lower(btrim(...)); if they diverge,
-- devices are silently left unlinked with no error.
--
-- The system tenant is excluded because CSV import inserts unseen devices there WITH a
-- location; soft-deleted rows are excluded because they keep their data by design (018).
-- devices.location is NOT cleared — it stays as "spot inside the site" (e.g. "Зал, ряд 3")
-- and display de-duplication is a UI concern.
INSERT INTO sites (tenant_id, name, geo_source)
SELECT DISTINCT ON (d.tenant_id, lower(btrim(d.location)))
       d.tenant_id, btrim(d.location), 'none'
  FROM devices d
 WHERE d.tenant_id <> '00000000-0000-0000-0000-000000000000'
   AND d.status NOT IN ('deleted','pending')
   AND d.deleted_at IS NULL
   AND d.location IS NOT NULL
   AND btrim(d.location) <> ''
 ORDER BY d.tenant_id, lower(btrim(d.location))
ON CONFLICT DO NOTHING;

UPDATE devices d
   SET site_id = s.id
  FROM sites s
 WHERE d.site_id IS NULL                                    -- fill only, NEVER overwrite
   AND s.tenant_id = d.tenant_id
   AND lower(btrim(s.name)) = lower(btrim(d.location))
   AND d.tenant_id <> '00000000-0000-0000-0000-000000000000'
   AND d.status NOT IN ('deleted','pending')
   AND d.deleted_at IS NULL
   AND d.location IS NOT NULL
   AND btrim(d.location) <> '';

-- Report the residual so a silent miss is visible in the migration output.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM devices
   WHERE location IS NOT NULL AND btrim(location) <> '' AND site_id IS NULL
     AND tenant_id <> '00000000-0000-0000-0000-000000000000'
     AND status NOT IN ('deleted','pending') AND deleted_at IS NULL;
  RAISE NOTICE 'migration 021: % device(s) with a location remain unlinked', n;
END $$;

-- ============================================================
-- Site-level RBAC grants
-- ============================================================
-- tenant_id is mandatory (house rule: always include tenant_id) and makes the composite FK
-- possible, so a grant physically cannot cross a tenant boundary — which is what the
-- device-access middleware relies on when it unions user_devices with user_sites.
--
-- granted_by … ON DELETE SET NULL is mandatory: routes/users.js hard-deletes users and only
-- nullifies firmwares.uploaded_by / ota_rollouts.created_by by hand, so a non-nullable
-- reference here would make DELETE /api/users/:id return 500 with 23503.
CREATE TABLE IF NOT EXISTS user_sites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id    UUID NOT NULL,
  tenant_id  UUID NOT NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

-- "Which users hold this site?" (site detail, grant revocation)
CREATE INDEX IF NOT EXISTS idx_user_sites_site        ON user_sites (site_id);
-- "Which sites can this user see while acting in this tenant?" (filterDeviceAccess)
CREATE INDEX IF NOT EXISTS idx_user_sites_user_tenant ON user_sites (user_id, tenant_id);

-- ============================================================
-- Weather observations (outdoor conditions per site)
-- ============================================================
-- tenant_id is carried so GET /api/sites/:id/weather/history can be tenant-scoped without a
-- join, and so the composite FK guarantees the row can never outlive its site's tenant.
CREATE TABLE IF NOT EXISTS weather_observations (
  site_id      UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,   -- hour-aligned provider timestamp
  temp_c       NUMERIC(5,2),
  humidity     SMALLINT,
  pressure_hpa NUMERIC(6,1),
  wind_ms      NUMERIC(5,2),
  weather_code SMALLINT,

  PRIMARY KEY (site_id, observed_at),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

-- The PK leads with site_id, so the retention sweep (WHERE observed_at < …) needs its own
-- index. Retention, not partitioning: WEATHER_RETENTION_DAYS=395 swept by
-- backend/scripts/cleanup-weather.js.
CREATE INDEX IF NOT EXISTS idx_weather_obs_time ON weather_observations (observed_at);

-- ============================================================
-- Public read-only site status links
-- ============================================================
-- token_hash is the sha256 hex of the raw token. The raw token is shown to the admin
-- exactly ONCE, at creation, and is never stored, logged, or written to audit_log.
-- expires_at is NOT NULL with a 90-day default: an unbounded public credential is not
-- acceptable even though the token travels in a header rather than the URL path.
CREATE TABLE IF NOT EXISTS site_public_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  site_id     UUID NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  label       VARCHAR(128),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  revoked_at  TIMESTAMPTZ,
  view_count  INTEGER NOT NULL DEFAULT 0,
  last_viewed TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

-- GET /api/sites/:id/public-links. Token lookup uses the UNIQUE index on token_hash.
CREATE INDEX IF NOT EXISTS idx_site_public_links_site ON site_public_links (site_id);

-- ============================================================
-- Technician home base (nearest-technician search)
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS base_latitude  DOUBLE PRECISION CHECK (base_latitude  >= -90  AND base_latitude  <= 90),
  ADD COLUMN IF NOT EXISTS base_longitude DOUBLE PRECISION CHECK (base_longitude >= -180 AND base_longitude <= 180),
  ADD COLUMN IF NOT EXISTS base_address   VARCHAR(256);

-- GET /api/sites/:id/nearest-technicians scans the tenant's staff that actually have a base.
CREATE INDEX IF NOT EXISTS idx_users_base_location
  ON users (tenant_id)
  WHERE base_latitude IS NOT NULL AND base_longitude IS NOT NULL;

-- ============================================================
-- Grants for the application role
-- ============================================================
-- Mandatory: on prod this file runs as the schema owner, so the app role gets no rights on
-- new tables (there is no ALTER DEFAULT PRIVILEGES anywhere in the repo, and infra/setup.sh
-- only grants on the database). Without these lines every /api/sites, /api/map and
-- /api/stats/geo call returns "permission denied for table sites" in production.
--
-- Each GRANT must stay on ONE physical line: test/helpers/migrate.js comments out
-- ^(GRANT|REVOKE)\b.*$ per line, so a wrapped statement would leave a dangling fragment and
-- break the entire backend test suite at setup. No sequence grants are needed — every key
-- here is a UUID / gen_random_uuid().
GRANT SELECT, INSERT, UPDATE, DELETE ON sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON geocode_cache TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sites TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON weather_observations TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_public_links TO modesp_cloud;
