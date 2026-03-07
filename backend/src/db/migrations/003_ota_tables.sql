-- ModESP Cloud — Migration 003: OTA Tables
-- Phase 6: Fleet OTA
-- Run: psql -U modesp_cloud -d modesp_cloud -f backend/src/db/migrations/003_ota_tables.sql

-- ============================================================
-- Firmware Images
-- ============================================================
CREATE TABLE IF NOT EXISTS firmwares (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  version       VARCHAR(32)  NOT NULL,
  filename      VARCHAR(256) NOT NULL,
  original_name VARCHAR(256),
  size_bytes    INTEGER      NOT NULL,
  checksum      VARCHAR(80)  NOT NULL,     -- "sha256:abcdef..."
  notes         TEXT,
  uploaded_by   UUID         REFERENCES users(id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_firmwares_tenant
  ON firmwares(tenant_id, created_at DESC);

-- ============================================================
-- OTA Rollouts (group deployments)
-- ============================================================
CREATE TABLE IF NOT EXISTS ota_rollouts (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES tenants(id),
  firmware_id        UUID         NOT NULL REFERENCES firmwares(id),
  batch_size         INTEGER      NOT NULL DEFAULT 5,
  batch_interval_s   INTEGER      NOT NULL DEFAULT 300,
  fail_threshold_pct INTEGER      NOT NULL DEFAULT 50,
  status             VARCHAR(16)  NOT NULL DEFAULT 'running',
  total_devices      INTEGER      NOT NULL DEFAULT 0,
  created_by         UUID         REFERENCES users(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,

  CONSTRAINT valid_rollout_status CHECK (
    status IN ('running', 'paused', 'completed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_ota_rollouts_tenant
  ON ota_rollouts(tenant_id, created_at DESC);

-- ============================================================
-- OTA Jobs (one row per device per OTA attempt)
-- ============================================================
CREATE TABLE IF NOT EXISTS ota_jobs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  firmware_id   UUID         NOT NULL REFERENCES firmwares(id),
  device_id     VARCHAR(16)  NOT NULL,     -- mqtt_device_id
  rollout_id    UUID         REFERENCES ota_rollouts(id),
  status        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  queued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,

  CONSTRAINT valid_ota_status CHECK (
    status IN ('queued', 'sent', 'succeeded', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_ota_jobs_tenant
  ON ota_jobs(tenant_id, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_ota_jobs_rollout
  ON ota_jobs(rollout_id) WHERE rollout_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ota_jobs_active
  ON ota_jobs(status) WHERE status IN ('queued', 'sent');

CREATE INDEX IF NOT EXISTS idx_ota_jobs_device
  ON ota_jobs(tenant_id, device_id, queued_at DESC);
