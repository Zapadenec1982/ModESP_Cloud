-- ModESP Cloud — Database Schema
-- Phase 1: Cloud Foundation
-- Run: psql -U modesp_cloud -d modesp_cloud -f schema.sql

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Tenants
-- ============================================================
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(128) NOT NULL,
  slug        VARCHAR(64)  UNIQUE NOT NULL,
  plan        VARCHAR(16)  NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  active      BOOLEAN      NOT NULL DEFAULT true
);

-- System tenant for pending devices (keeps "tenant_id in every query" rule)
INSERT INTO tenants (id, name, slug, plan)
VALUES ('00000000-0000-0000-0000-000000000000', 'System', '__system__', 'free');

-- ============================================================
-- Devices
-- ============================================================
CREATE TABLE devices (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  mqtt_device_id   VARCHAR(16)  NOT NULL,
  serial_number    VARCHAR(64),
  name             VARCHAR(128),
  location         VARCHAR(256),
  firmware_version VARCHAR(16),
  proto_version    SMALLINT     NOT NULL DEFAULT 1,
  last_seen        TIMESTAMPTZ,
  last_state       JSONB,
  online           BOOLEAN      NOT NULL DEFAULT false,
  status           VARCHAR(16)  NOT NULL DEFAULT 'pending',
  mqtt_password_hash VARCHAR(256),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, mqtt_device_id)
);

CREATE UNIQUE INDEX idx_devices_mqtt_id ON devices(mqtt_device_id);
CREATE INDEX idx_devices_tenant        ON devices(tenant_id);
CREATE INDEX idx_devices_online        ON devices(tenant_id, online);
CREATE INDEX idx_devices_status        ON devices(status) WHERE status = 'pending';

-- ============================================================
-- Users (Phase 4, but create table now for FK integrity)
-- ============================================================
CREATE TABLE users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id),
  email        VARCHAR(256) NOT NULL,
  password_hash VARCHAR(256) NOT NULL,
  role         VARCHAR(16) NOT NULL DEFAULT 'viewer',
  push_token   VARCHAR(256),
  telegram_id  BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login   TIMESTAMPTZ,
  active       BOOLEAN     NOT NULL DEFAULT true,

  UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);

-- ============================================================
-- User-Device access (many-to-many)
-- ============================================================
CREATE TABLE user_devices (
  user_id    UUID REFERENCES users(id)   ON DELETE CASCADE,
  device_id  UUID REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, device_id)
);

-- ============================================================
-- Alarms
-- ============================================================
CREATE TABLE alarms (
  id           BIGSERIAL   PRIMARY KEY,
  tenant_id    UUID        NOT NULL REFERENCES tenants(id),
  device_id    VARCHAR(16) NOT NULL,
  alarm_code   VARCHAR(32) NOT NULL,
  severity     VARCHAR(8)  NOT NULL DEFAULT 'warning',
  active       BOOLEAN     NOT NULL DEFAULT true,
  value        FLOAT,
  limit_value  FLOAT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at   TIMESTAMPTZ
);

CREATE INDEX idx_alarms_tenant_device ON alarms(tenant_id, device_id);
CREATE INDEX idx_alarms_active        ON alarms(tenant_id, active) WHERE active = true;
CREATE INDEX idx_alarms_time          ON alarms(tenant_id, triggered_at DESC);

-- ============================================================
-- Telemetry (partitioned by month)
-- ============================================================
CREATE TABLE telemetry (
  time       TIMESTAMPTZ NOT NULL,
  tenant_id  UUID        NOT NULL,
  device_id  VARCHAR(16) NOT NULL,
  channel    VARCHAR(16) NOT NULL,
  value      FLOAT       NOT NULL
) PARTITION BY RANGE (time);

CREATE INDEX idx_telemetry_lookup
  ON telemetry(tenant_id, device_id, channel, time DESC);

-- Initial partitions (3 months ahead)
CREATE TABLE telemetry_2026_03 PARTITION OF telemetry
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE telemetry_2026_04 PARTITION OF telemetry
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE telemetry_2026_05 PARTITION OF telemetry
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE telemetry_2026_06 PARTITION OF telemetry
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ============================================================
-- Events (compressor on/off, defrost start/end, device online/offline)
-- ============================================================
CREATE TABLE events (
  id         BIGSERIAL   PRIMARY KEY,
  tenant_id  UUID        NOT NULL REFERENCES tenants(id),
  device_id  VARCHAR(16) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload    JSONB,
  time       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_lookup ON events(tenant_id, device_id, time DESC);

-- ============================================================
-- Refresh Tokens (Phase 4, create now for schema completeness)
-- ============================================================
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(256) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked     BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- Row-Level Security (additional defense layer)
-- ============================================================
ALTER TABLE devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarms    ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE events    ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_devices ON devices
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);
CREATE POLICY tenant_isolation_alarms ON alarms
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);
CREATE POLICY tenant_isolation_telemetry ON telemetry
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);
CREATE POLICY tenant_isolation_events ON events
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- ============================================================
-- Partition creation function (for cron automation)
-- ============================================================
CREATE OR REPLACE FUNCTION create_telemetry_partition(year INT, month INT)
RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := format('telemetry_%s_%s', year, lpad(month::TEXT, 2, '0'));
  start_date := make_date(year, month, 1);
  end_date := start_date + INTERVAL '1 month';

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF telemetry
     FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;
