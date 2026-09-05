-- 032: maintenance hints — repair-prevention rules (plan epic 2.4, ROADMAP phase 18)
--
-- The controller already counts compressor starts and run time, detects defrost
-- timeouts and publishes the condenser temperature; the cloud already records
-- compressor / defrost / door events. This migration adds the two tables that
-- turn those signals into "check the defrost heater" / "clean the condenser":
--
--   maintenance_rules  — what to look at and where the line is. tenant_id NULL is
--                        the platform default; an organisation overrides a rule
--                        by inserting its own row with the same rule_key (and an
--                        optional model filter, matched against devices.model).
--   maintenance_hints  — one OPEN hint per (device, rule). The hourly evaluator
--                        (services/maintenance.js) opens it when the metric is
--                        over the line, refreshes last_seen_at while it stays
--                        there, and closes it (closed_reason = 'resolved') when
--                        the metric is back under. Acknowledging keeps it open;
--                        dismissing closes it ('dismissed'). The row survives a
--                        device rename and a user deletion.
--
-- Rule keys and their metric (see services/maintenance.js RULES):
--   compressor_starts — compressor_on events per hour, averaged over window_hours
--   compressor_duty   — share of window_hours the compressor was ON, in percent
--   defrost_timeouts  — defrost.consecutive_timeouts from the controller's live state
--   door_openings     — door_open events over window_hours
--   cond_temp         — average condenser temperature (telemetry channel `cond`) °C

CREATE TABLE IF NOT EXISTS maintenance_rules (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = platform default
  rule_key     VARCHAR(48)  NOT NULL,
  model        VARCHAR(64),                                             -- NULL = any model
  threshold    NUMERIC(10,2) NOT NULL,
  window_hours SMALLINT     NOT NULL DEFAULT 24 CHECK (window_hours BETWEEN 1 AND 720),
  severity     VARCHAR(8)   NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning')),
  enabled      BOOLEAN      NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by   UUID         REFERENCES users(id) ON DELETE SET NULL
);

-- One row per (scope, rule, model). COALESCE because NULLs are distinct in a plain
-- UNIQUE constraint and the platform default has tenant_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_rules_scope
  ON maintenance_rules (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_key, COALESCE(model, ''));

CREATE TABLE IF NOT EXISTS maintenance_hints (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id       VARCHAR(16)  NOT NULL,                      -- mqtt_device_id
  rule_key        VARCHAR(48)  NOT NULL,
  rule_id         UUID         REFERENCES maintenance_rules(id) ON DELETE SET NULL,
  severity        VARCHAR(8)   NOT NULL DEFAULT 'info',
  value           NUMERIC(12,2),                              -- metric at the last evaluation
  threshold       NUMERIC(12,2),                              -- line it crossed
  window_hours    SMALLINT,
  opened_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),        -- last evaluation that still matched
  closed_at       TIMESTAMPTZ,
  closed_reason   VARCHAR(16)  CHECK (closed_reason IS NULL OR closed_reason IN ('resolved', 'dismissed')),
  acknowledged_by UUID         REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMPTZ,
  ack_note        VARCHAR(512)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_hints_one_open
  ON maintenance_hints (tenant_id, device_id, rule_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_hints_open
  ON maintenance_hints (tenant_id, device_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_hints_time
  ON maintenance_hints (tenant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_hints_closed
  ON maintenance_hints (closed_at) WHERE closed_at IS NOT NULL;   -- retention sweep

-- Platform defaults. Thresholds are deliberately conservative: a hint that fires
-- on a healthy cabinet costs trust faster than a missed one costs money. An
-- organisation tunes them in Settings → Maintenance; the superadmin tunes these.
INSERT INTO maintenance_rules (tenant_id, rule_key, model, threshold, window_hours, severity) VALUES
  (NULL, 'compressor_starts', NULL, 8,  24, 'info'),   -- > 8 starts/hour on average = short cycling
  (NULL, 'compressor_duty',   NULL, 85, 24, 'info'),   -- ON > 85 % of the day = can't reach setpoint
  (NULL, 'defrost_timeouts',  NULL, 3,  24, 'info'),   -- 3 defrosts in a row ended by timeout
  (NULL, 'door_openings',     NULL, 80, 24, 'info'),   -- > 80 openings/day
  (NULL, 'cond_temp',         NULL, 55, 24, 'info')    -- condenser hotter than 55 °C on average
ON CONFLICT DO NOTHING;

-- Hints are part of the paid plans; the free trial shows the tab but no rules run.
UPDATE plan_limits
   SET features = features || '["maintenance"]'::jsonb
 WHERE plan IN ('basic', 'pro', 'enterprise', 'partner') AND NOT features ? 'maintenance';

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON maintenance_rules TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON maintenance_hints TO modesp_cloud;
GRANT USAGE, SELECT ON SEQUENCE maintenance_hints_id_seq TO modesp_cloud;
