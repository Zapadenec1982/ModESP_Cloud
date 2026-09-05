-- 033: work orders and structured service records (plan epic 2.3)
--
-- An alarm or a maintenance hint becomes a work order; the work order carries a
-- technician, a site with an address, a priority and a schedule; closing it
-- writes the structured service record (who, how long, which parts, what it
-- cost). That chain — alarm → order → visit → record — is what lets an
-- organisation (or a service partner) count prevented repairs instead of
-- counting notifications.
--
-- alarm_id and hint_id carry no FK on purpose: alarms and hints are swept by
-- retention (cleanup-aux.js) long before a work-order history should go.
-- device_id keeps the device UUID for the join while it exists and
-- device_mqtt_id keeps the identity after the device is deleted.

CREATE TABLE IF NOT EXISTS work_orders (
  id                BIGSERIAL    PRIMARY KEY,
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id           UUID         REFERENCES sites(id) ON DELETE SET NULL,
  device_id         UUID         REFERENCES devices(id) ON DELETE SET NULL,
  device_mqtt_id    VARCHAR(16),
  alarm_id          BIGINT,
  hint_id           BIGINT,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  priority          VARCHAR(8)   NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status            VARCHAR(16)  NOT NULL DEFAULT 'new'    CHECK (status IN ('new', 'assigned', 'in_progress', 'done', 'cancelled')),
  assigned_to       UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_by        UUID         REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at      TIMESTAMPTZ,
  assigned_at       TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  closed_reason     VARCHAR(512),
  service_record_id BIGINT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_open
  ON work_orders (tenant_id, status) WHERE status IN ('new', 'assigned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_work_orders_assignee
  ON work_orders (tenant_id, assigned_to) WHERE status IN ('new', 'assigned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_work_orders_time   ON work_orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_orders_device ON work_orders (tenant_id, device_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_alarm  ON work_orders (alarm_id) WHERE alarm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_hint   ON work_orders (hint_id)  WHERE hint_id  IS NOT NULL;

-- Structured service records: who did it (a real user, not free text), which
-- order it closes, how long, which parts, what it cost. `technician` stays for
-- the free-text history and is filled from the user's email when a record is
-- created by closing an order.
ALTER TABLE service_records
  ADD COLUMN IF NOT EXISTS user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_order_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duration_min  INT CHECK (duration_min IS NULL OR duration_min BETWEEN 0 AND 100000),
  ADD COLUMN IF NOT EXISTS parts         JSONB,
  ADD COLUMN IF NOT EXISTS cost          NUMERIC(12,2) CHECK (cost IS NULL OR cost >= 0),
  ADD COLUMN IF NOT EXISTS cost_currency CHAR(3),
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_service_records_work_order
  ON service_records (work_order_id) WHERE work_order_id IS NOT NULL;

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON work_orders TO modesp_cloud;
GRANT USAGE, SELECT ON SEQUENCE work_orders_id_seq TO modesp_cloud;
