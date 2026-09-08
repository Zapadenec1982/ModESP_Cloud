-- 043: Firmware library, rollback and FK integrity (plan epic 2.8)
--
-- firmwares.tenant_id NULL      — a platform (global) firmware: uploaded by a
--                                 superadmin, visible to every organisation
--                                 (visibility = 'all') or to the ones listed in
--                                 firmware_visibility (visibility = 'selected').
-- firmware_visibility           — selective publication of a global firmware.
-- ota_jobs / ota_rollouts       — firmware_id may be NULL after the firmware is
--                                 deleted (ON DELETE SET NULL); firmware_version
--                                 keeps the history readable. ota_jobs gains the
--                                 actor, the kind (deploy | rollback), the
--                                 pre-OTA deferral counters and the force flag.
-- tenant_settings.ota_window_*  — the organisation's OTA window, minutes after
--                                 local midnight (NULL = any time).

ALTER TABLE firmwares ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE firmwares ADD COLUMN IF NOT EXISTS visibility VARCHAR(8) NOT NULL DEFAULT 'all';
ALTER TABLE firmwares DROP CONSTRAINT IF EXISTS firmwares_visibility_check;
ALTER TABLE firmwares ADD CONSTRAINT firmwares_visibility_check CHECK (visibility IN ('all', 'selected'));
-- UNIQUE (tenant_id, version) treats NULLs as distinct: globals need their own guard
CREATE UNIQUE INDEX IF NOT EXISTS uq_firmwares_global_version ON firmwares (version) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_firmwares_global ON firmwares (created_at DESC) WHERE tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS firmware_visibility (
  firmware_id UUID NOT NULL REFERENCES firmwares(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (firmware_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_firmware_visibility_tenant ON firmware_visibility (tenant_id);

-- ota_jobs: the firmware may go after the job is over; the version stays
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);
UPDATE ota_jobs j SET firmware_version = f.version FROM firmwares f WHERE f.id = j.firmware_id AND j.firmware_version IS NULL;
ALTER TABLE ota_jobs ALTER COLUMN firmware_id DROP NOT NULL;
ALTER TABLE ota_jobs DROP CONSTRAINT IF EXISTS ota_jobs_firmware_id_fkey;
ALTER TABLE ota_jobs ADD CONSTRAINT ota_jobs_firmware_id_fkey FOREIGN KEY (firmware_id) REFERENCES firmwares(id) ON DELETE SET NULL;
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS actor VARCHAR(255);          -- e-mail or apikey:<name> at the time
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'deploy';
ALTER TABLE ota_jobs DROP CONSTRAINT IF EXISTS ota_jobs_kind_check;
ALTER TABLE ota_jobs ADD CONSTRAINT ota_jobs_kind_check CHECK (kind IN ('deploy', 'rollback'));
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS deferrals INT NOT NULL DEFAULT 0;   -- batches skipped by the pre-OTA checks
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS defer_reason VARCHAR(32);
ALTER TABLE ota_jobs ADD COLUMN IF NOT EXISTS forced BOOLEAN NOT NULL DEFAULT false;

-- ota_rollouts: same firmware handling, plus why a rollout is paused
ALTER TABLE ota_rollouts ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);
UPDATE ota_rollouts r SET firmware_version = f.version FROM firmwares f WHERE f.id = r.firmware_id AND r.firmware_version IS NULL;
ALTER TABLE ota_rollouts ALTER COLUMN firmware_id DROP NOT NULL;
ALTER TABLE ota_rollouts DROP CONSTRAINT IF EXISTS ota_rollouts_firmware_id_fkey;
ALTER TABLE ota_rollouts ADD CONSTRAINT ota_rollouts_firmware_id_fkey FOREIGN KEY (firmware_id) REFERENCES firmwares(id) ON DELETE SET NULL;
ALTER TABLE ota_rollouts ADD COLUMN IF NOT EXISTS paused_reason VARCHAR(16);
-- failures the admin accepted by resuming an auto-paused rollout: the threshold re-arms on new failures only
ALTER TABLE ota_rollouts ADD COLUMN IF NOT EXISTS acked_failures INT NOT NULL DEFAULT 0;
ALTER TABLE ota_rollouts DROP CONSTRAINT IF EXISTS ota_rollouts_paused_reason_check;
ALTER TABLE ota_rollouts ADD CONSTRAINT ota_rollouts_paused_reason_check CHECK (paused_reason IS NULL OR paused_reason IN ('manual', 'failures'));

-- OTA window of the organisation (minutes after local midnight, wraps past midnight when from > to)
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS ota_window_from SMALLINT;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS ota_window_to SMALLINT;
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_ota_window_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_ota_window_check
  CHECK ((ota_window_from IS NULL OR ota_window_from BETWEEN 0 AND 1439) AND (ota_window_to IS NULL OR ota_window_to BETWEEN 0 AND 1439));

GRANT SELECT, INSERT, UPDATE, DELETE ON firmware_visibility TO modesp_cloud;
