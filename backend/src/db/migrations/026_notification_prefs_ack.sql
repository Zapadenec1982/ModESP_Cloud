-- 026: Notification preferences, alarm acknowledgement, delivery log (plan epic 1.6)
--
-- * users.receive_all_tenant_alerts — a superadmin is no longer on every
--   organisation's distribution list unless this is set.
-- * user_notification_prefs — per-user channels, minimum severity and quiet
--   hours, read by push.js before every delivery.
-- * alarms.acknowledged_* / ack_note — "taken into work" by a technician;
--   escalated_at marks the one admin re-notification of an unacknowledged
--   critical alarm (push.js runEscalations, ALARM_ACK_ESCALATION_MIN).
-- * notification_log.user_id / alarm_id — the user-based delivery path now logs
--   every send, so an alarm can show who was notified and how.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS receive_all_tenant_alerts BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id      UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      BOOLEAN     NOT NULL DEFAULT true,
  min_severity VARCHAR(8)  NOT NULL DEFAULT 'info'
               CHECK (min_severity IN ('info', 'warning', 'critical')),
  telegram     BOOLEAN     NOT NULL DEFAULT true,
  webpush      BOOLEAN     NOT NULL DEFAULT true,
  email        BOOLEAN     NOT NULL DEFAULT true,
  quiet_from   CHAR(5),                       -- 'HH:MM' local time, NULL = no quiet hours
  quiet_to     CHAR(5),
  quiet_tz     VARCHAR(64) NOT NULL DEFAULT 'Europe/Kyiv',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE alarms
  ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_note        VARCHAR(512),
  ADD COLUMN IF NOT EXISTS escalated_at    TIMESTAMPTZ;

-- The escalation sweep: active critical alarms nobody acknowledged
CREATE INDEX IF NOT EXISTS idx_alarms_unacked_critical
  ON alarms (triggered_at)
  WHERE active = true AND severity = 'critical' AND acknowledged_at IS NULL AND escalated_at IS NULL;

ALTER TABLE notification_log
  ADD COLUMN IF NOT EXISTS user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alarm_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_nl_alarm ON notification_log (alarm_id) WHERE alarm_id IS NOT NULL;

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_prefs TO modesp_cloud;
