-- 050: hours a backfill touched, so the hourly archive can catch up on them
--
-- A controller that lost its link buffers readings and sends up to 90 days of
-- them when it comes back (MAX_BACKFILL_AGE in services/mqtt.js). The nightly
-- fold into telemetry_hourly only covers DOWNSAMPLE_LOOKBACK_DAYS — three days —
-- so everything older landed in `telemetry`, waited out the plan's raw retention
-- and was deleted without ever reaching the archive.
--
-- The result is a hole in the archive exactly where the inspector looks: the
-- stretch the equipment ran on its own, with no link. The HACCP report prints it
-- as a break in the record, and once raw retention has passed there is nothing
-- left to rebuild it from. A manual `--backfill-days N` could fold it, but only
-- if somebody thought to run it in time.
--
-- Every backfill now writes the hours it filled here; the fold takes this table
-- as well as its window and deletes each row once folded. Self-healing: a run
-- that dies leaves the hour queued for the next one.
--
-- The table is transient — it drains as fast as the fold runs — so it carries no
-- index beyond the key it is read and deleted by.

CREATE TABLE IF NOT EXISTS telemetry_dirty_hours (
  tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id  VARCHAR(16)  NOT NULL,
  hour       TIMESTAMPTZ  NOT NULL,
  noticed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, device_id, hour)
);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON telemetry_dirty_hours TO modesp_cloud;
