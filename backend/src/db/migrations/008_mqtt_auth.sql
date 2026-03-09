-- Migration 008: MQTT Dynamic Auth (Phase 4 completion)
-- Adds explicit mqtt_username column for mosquitto-go-auth plugin lookups.
-- mqtt_password_hash already exists (schema.sql line 43).

-- Explicit MQTT username (replaces convention-based device_XXXXXX)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_username VARCHAR(64);

-- Backfill existing devices
UPDATE devices SET mqtt_username = 'device_' || mqtt_device_id
  WHERE mqtt_username IS NULL;

-- Unique index for auth lookups (plugin searches by username)
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mqtt_username
  ON devices(mqtt_username) WHERE mqtt_username IS NOT NULL;

-- Composite index for ACL queries (username + status + hash)
CREATE INDEX IF NOT EXISTS idx_devices_mqtt_auth
  ON devices(mqtt_username, status)
  WHERE mqtt_password_hash IS NOT NULL;
