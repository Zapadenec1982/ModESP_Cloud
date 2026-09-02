-- 028: HACCP report registry and hourly telemetry archive (plan epic 1.9)
--
-- report_exports   — every generated HACCP PDF gets a verification code printed
--                    in its footer together with the SHA-256 of its data; an
--                    inspector checks GET /api/public/report/:code.
-- telemetry_hourly — min/max/avg/samples per device, channel and hour, filled
--                    daily by scripts/cleanup-telemetry.js and kept for three
--                    years, so a report for a period older than the plan's raw
--                    retention can still be produced.

CREATE TABLE IF NOT EXISTS report_exports (
  code          VARCHAR(16)  PRIMARY KEY,
  kind          VARCHAR(8)   NOT NULL CHECK (kind IN ('device', 'site')),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     VARCHAR(16),                 -- mqtt_device_id for kind = device
  site_id       UUID         REFERENCES sites(id) ON DELETE SET NULL,
  period_from   TIMESTAMPTZ  NOT NULL,
  period_to     TIMESTAMPTZ  NOT NULL,
  bucket        VARCHAR(4)   NOT NULL,
  source        VARCHAR(8)   NOT NULL,       -- raw | hourly
  lang          VARCHAR(2)   NOT NULL DEFAULT 'uk',
  sha256        CHAR(64)     NOT NULL,
  generated_by  VARCHAR(256),
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_exports_tenant ON report_exports (tenant_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_hourly (
  tenant_id  UUID         NOT NULL,
  device_id  VARCHAR(16)  NOT NULL,
  channel    VARCHAR(16)  NOT NULL,
  hour       TIMESTAMPTZ  NOT NULL,
  min        REAL         NOT NULL,
  max        REAL         NOT NULL,
  avg        REAL         NOT NULL,
  samples    INT          NOT NULL,
  PRIMARY KEY (tenant_id, device_id, channel, hour)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_hourly_hour ON telemetry_hourly (hour);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON report_exports TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON telemetry_hourly TO modesp_cloud;

-- ── Raw-retention override (grandfathering) ─────────────────
-- Until this migration every organisation kept 90 days of raw telemetry; the
-- per-plan retention that replaces it would cut the free plan to 30. Existing
-- organisations therefore get an explicit 400-day override that a superadmin
-- can change and that an explicit plan change clears (plan epic 1.9, risk table).
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS raw_retention_days INT
  CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 7 AND 1100);

INSERT INTO tenant_settings (tenant_id, raw_retention_days)
SELECT t.id, 400
  FROM tenants t JOIN plan_limits p ON p.plan = t.plan
 WHERE t.plan <> 'system' AND p.retention_days < 400
ON CONFLICT (tenant_id) DO UPDATE
   SET raw_retention_days = COALESCE(tenant_settings.raw_retention_days, EXCLUDED.raw_retention_days);
