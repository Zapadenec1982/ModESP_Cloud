-- 005: Device metadata expansion — model, comment, manufactured_at, service_records.

-- New device columns
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS manufactured_at DATE;

-- Service records — maintenance/repair journal per device
CREATE TABLE IF NOT EXISTS service_records (
  id          BIGSERIAL    PRIMARY KEY,
  tenant_id   UUID         NOT NULL REFERENCES tenants(id),
  device_id   UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  service_date DATE        NOT NULL,
  technician  VARCHAR(128) NOT NULL,
  reason      TEXT         NOT NULL,
  work_done   TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_records_device
  ON service_records(tenant_id, device_id, service_date DESC);
