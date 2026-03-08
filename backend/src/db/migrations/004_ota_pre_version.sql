-- 004: Add pre_ota_version to ota_jobs for robust OTA success detection.
-- Stores the device firmware version before OTA, so the checker can detect
-- success even when target version format (semver) differs from reported (git hash).

ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS pre_ota_version TEXT;
