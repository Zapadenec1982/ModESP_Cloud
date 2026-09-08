-- HACCP critical limits per equipment (temperature-control journal)
--
-- devices.haccp_min / haccp_max — the critical limits the organisation's HACCP
--   programme sets for what this equipment stores (°C). NULL: the journal falls
--   back to the controller's own protection.low_limit / protection.high_limit
--   and says so; with neither it prints "limits not set" rather than a silent
--   blank. A row of the journal outside the limits is flagged as a deviation.
-- devices.haccp_product — what is stored ("frozen goods", "dairy"), printed in
--   the journal header next to the limits.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS haccp_min NUMERIC(6,2);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS haccp_max NUMERIC(6,2);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS haccp_product VARCHAR(96);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_haccp_limits_check;
ALTER TABLE devices ADD CONSTRAINT devices_haccp_limits_check
  CHECK (haccp_min IS NULL OR haccp_max IS NULL OR haccp_min < haccp_max);
