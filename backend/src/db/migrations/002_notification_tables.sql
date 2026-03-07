-- ModESP Cloud — Migration 002: Notification Tables
-- Phase 3: Push Notifications (Telegram + FCM)
-- Run: psql -U modesp_cloud -d modesp_cloud -f backend/src/db/migrations/002_notification_tables.sql

-- ============================================================
-- Notification Subscribers
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_subscribers (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  channel       VARCHAR(16)  NOT NULL,          -- 'telegram' | 'fcm'
  address       VARCHAR(256) NOT NULL,          -- chat_id or FCM token
  label         VARCHAR(128),                   -- friendly name ("Oleg's phone")
  device_filter UUID[],                         -- NULL = all devices, else specific device UUIDs
  active        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_channel CHECK (channel IN ('telegram', 'fcm'))
);

CREATE INDEX IF NOT EXISTS idx_ns_tenant
  ON notification_subscribers(tenant_id, active)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_ns_channel
  ON notification_subscribers(tenant_id, channel)
  WHERE active = true;

-- ============================================================
-- Notification Log (delivery tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_log (
  id            BIGSERIAL    PRIMARY KEY,
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  subscriber_id UUID         REFERENCES notification_subscribers(id) ON DELETE SET NULL,
  channel       VARCHAR(16)  NOT NULL,
  device_id     VARCHAR(16),
  alarm_code    VARCHAR(32),
  status        VARCHAR(16)  NOT NULL,          -- 'sent' | 'failed' | 'skipped'
  error_message TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nl_tenant
  ON notification_log(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nl_subscriber
  ON notification_log(subscriber_id, created_at DESC);

-- RLS policies
ALTER TABLE notification_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log         ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ns ON notification_subscribers
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY tenant_isolation_nl ON notification_log
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);
