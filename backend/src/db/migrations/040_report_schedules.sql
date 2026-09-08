-- 040: Scheduled reports (plan epic 2.7)
--
-- report_schedules — a standing order: every week or month the HACCP, alarm
--                    or energy report of one site (or of every site of the
--                    organisation) is generated, archived and e-mailed.
-- report_exports   — grows into the archive: a scheduled PDF is kept in the
--                    row (`pdf`) so the Reports page hands it out again;
--                    ad-hoc exports keep registering code and hash only.

CREATE TABLE IF NOT EXISTS report_schedules (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id        UUID         REFERENCES sites(id) ON DELETE CASCADE,     -- NULL = every site of the organisation
  type           VARCHAR(8)   NOT NULL CHECK (type IN ('haccp', 'alarms', 'energy')),
  cadence        VARCHAR(8)   NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  recipients     TEXT[]       NOT NULL,
  lang           VARCHAR(2)   NOT NULL DEFAULT 'uk',
  bucket         VARCHAR(4)   NOT NULL DEFAULT '1h',
  enabled        BOOLEAN      NOT NULL DEFAULT true,
  next_run_at    TIMESTAMPTZ  NOT NULL,
  last_run_at    TIMESTAMPTZ,
  last_period_to TIMESTAMPTZ,                  -- end of the last period delivered: a period never goes out twice
  last_status    VARCHAR(8),                   -- ok | empty | error
  last_error     TEXT,
  created_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_due    ON report_schedules (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_report_schedules_tenant ON report_schedules (tenant_id, created_at);

ALTER TABLE report_exports
  ADD COLUMN IF NOT EXISTS report_type VARCHAR(8)  NOT NULL DEFAULT 'haccp',   -- haccp | alarms | energy
  ADD COLUMN IF NOT EXISTS schedule_id UUID        REFERENCES report_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_name   VARCHAR(160),
  ADD COLUMN IF NOT EXISTS bytes       INT,
  ADD COLUMN IF NOT EXISTS pdf         BYTEA;                                   -- scheduled reports only; REPORT_ARCHIVE_DAYS

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedules TO modesp_cloud;
