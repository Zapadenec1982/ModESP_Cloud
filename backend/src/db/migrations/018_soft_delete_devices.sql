-- Migration 018: Soft delete support for devices
-- Devices deleted while offline keep their record + credentials so they can reconnect.
-- The deleted_at column tracks when deletion occurred for the cleanup job (7-day retention).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_devices_deleted_at
  ON devices(deleted_at)
  WHERE deleted_at IS NOT NULL;
