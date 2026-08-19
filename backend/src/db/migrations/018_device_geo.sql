-- 018: Device geolocation for the fleet map page
-- Adds latitude/longitude so devices can be placed on the interactive map
-- and technicians can open turn-by-turn navigation (Google/Apple Maps).
-- Run: psql -U modesp_cloud -d modesp_cloud -f backend/src/db/migrations/018_device_geo.sql
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION CHECK (latitude  >= -90  AND latitude  <= 90),
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180);
