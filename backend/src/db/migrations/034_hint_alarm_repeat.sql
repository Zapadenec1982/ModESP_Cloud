-- 034: maintenance hints read the controller's alarms, not the cloud's own thresholds
--
-- The controller is the one that knows when something is wrong: it counts
-- compressor starts and run time itself (protection.compressor_starts_1h,
-- protection.compressor_duty), tracks defrost timeouts (defrost.consecutive_timeouts)
-- and raises its own alarms for the same signs (rapid_cycle_alarm,
-- continuous_run_alarm, short_cycle_alarm, ...). Migration 032 put a second set
-- of thresholds on the server and had it decide "the heater is broken" from
-- the same numbers — a duplicate of firmware logic, and a wrong one on
-- emulators, where every defrost ends by timeout.
--
-- What the cloud can add that the controller cannot is history: the same alarm
-- coming back again and again on the same cabinet is a service call, not
-- another acknowledgement. So the five metric rules are replaced by one:
--
--   alarm_repeat — the same alarm code raised by the controller ≥ threshold
--                  times within window_hours (default 3 in 7 days). One open
--                  hint per (device, alarm code); it closes on its own once
--                  the window no longer holds that many.
--
-- The hint row gains alarm_code; rule resolution (organisation + model >
-- organisation > platform + model > platform) and the rest of the workflow
-- (acknowledge, dismiss, work order from a hint, notifications) stay as they were.

ALTER TABLE maintenance_hints ADD COLUMN IF NOT EXISTS alarm_code VARCHAR(32);

-- One open hint per (device, rule, alarm code) — the old index collapsed every
-- code of a device into one row.
DROP INDEX IF EXISTS idx_maintenance_hints_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_hints_one_open
  ON maintenance_hints (tenant_id, device_id, rule_key, COALESCE(alarm_code, '')) WHERE closed_at IS NULL;

-- Hints the server-side thresholds opened are closed, not deleted: the history
-- stays readable, and a hint that was already turned into a work order keeps its link.
UPDATE maintenance_hints
   SET closed_at = now(), closed_reason = 'dismissed'
 WHERE closed_at IS NULL
   AND rule_key IN ('compressor_starts', 'compressor_duty', 'defrost_timeouts', 'door_openings', 'cond_temp');

-- The metric rules go, platform defaults and organisation overrides alike
-- (maintenance_hints.rule_id is ON DELETE SET NULL).
DELETE FROM maintenance_rules
 WHERE rule_key IN ('compressor_starts', 'compressor_duty', 'defrost_timeouts', 'door_openings', 'cond_temp');

-- Platform default: three of the same alarm in a week.
INSERT INTO maintenance_rules (tenant_id, rule_key, model, threshold, window_hours, severity)
VALUES (NULL, 'alarm_repeat', NULL, 3, 168, 'info')
ON CONFLICT DO NOTHING;
