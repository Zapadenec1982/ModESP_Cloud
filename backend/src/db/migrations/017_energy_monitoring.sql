-- Migration 017: Energy Monitoring
-- Equipment model profiles with rated power values for estimated energy calculation.
-- Forward-compatible with real energy sensors via energy_source flag.

-- ── Equipment model profiles ──────────────────────────────
CREATE TABLE IF NOT EXISTS device_models (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  name              VARCHAR(64) NOT NULL,
  compressor_kw     NUMERIC(5,3),
  evap_fan_kw       NUMERIC(5,3),
  cond_fan_kw       NUMERIC(5,3),
  defrost_heater_kw NUMERIC(5,3),
  standby_kw        NUMERIC(5,3),
  energy_source     VARCHAR(16) NOT NULL DEFAULT 'estimated',  -- 'estimated' | 'metered'
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_device_models_tenant
  ON device_models(tenant_id);

-- ── Per-device: link to model + optional power overrides ──
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS model_id           UUID REFERENCES device_models(id),
  ADD COLUMN IF NOT EXISTS compressor_kw      NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS evap_fan_kw        NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS cond_fan_kw        NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS defrost_heater_kw  NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS standby_kw         NUMERIC(5,3);

-- ── Electricity rate per tenant for cost calculation ──────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS electricity_rate     NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS electricity_currency VARCHAR(3) DEFAULT 'UAH';
