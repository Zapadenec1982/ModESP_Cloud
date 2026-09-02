-- 027: Plans, organisation status and settings (plan epic 1.8)
--
-- plan_limits      — what a plan means (capacity, retention, sampling, features);
--                    enforced by backend/src/middleware/plan.js.
-- tenants.status   — trial | active | past_due | suspended | closed. Login, token
--                    refresh, tenant switch and the broker ACL admit only the first
--                    three. `active` stays as the boolean mirror the older code and
--                    queries read; a trigger keeps the two in step whichever one
--                    is written.
-- tenant_settings  — per-organisation overrides the admin edits without SQL:
--                    time zone, locale, alarm delays, offline thresholds,
--                    acknowledgement escalation. NULL means "platform default".

-- ── Plans ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_limits (
  plan            VARCHAR(16)  PRIMARY KEY,
  name            VARCHAR(64)  NOT NULL,
  max_devices     INT,                         -- NULL = unlimited
  max_sites       INT,
  max_users       INT,
  retention_days  INT          NOT NULL DEFAULT 90,
  sampling_sec    INT          NOT NULL DEFAULT 300,
  features        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  public          BOOLEAN      NOT NULL DEFAULT true,   -- shown on the pricing page
  sort_order      INT          NOT NULL DEFAULT 0
);

INSERT INTO plan_limits (plan, name, max_devices, max_sites, max_users, retention_days, sampling_sec, features, public, sort_order) VALUES
  ('free',       'Старт',      3,    1,    3,    30,  300, '[]'::jsonb, true, 10),
  ('basic',      'Об''єкт',    20,   3,    10,   400, 300, '["geo","energy","reports"]'::jsonb, true, 20),
  ('pro',        'Мережа',     500,  100,  100,  800, 60,  '["geo","energy","reports","ota_rollout","api"]'::jsonb, true, 30),
  ('enterprise', 'Enterprise', NULL, NULL, NULL, 800, 60,  '["geo","energy","reports","ota_rollout","api","branding"]'::jsonb, true, 40),
  ('partner',    'Партнер',    NULL, NULL, NULL, 800, 60,  '["geo","energy","reports","ota_rollout","api","branding","partner"]'::jsonb, true, 50),
  ('system',     'System',     NULL, NULL, NULL, 90,  300, '[]'::jsonb, false, 0)
ON CONFLICT (plan) DO NOTHING;

-- Any plan value already stored must exist in the catalogue before the FK lands.
INSERT INTO plan_limits (plan, name, public, sort_order)
SELECT DISTINCT t.plan, t.plan, false, 99 FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM plan_limits p WHERE p.plan = t.plan);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenants_plan') THEN
    ALTER TABLE tenants ADD CONSTRAINT fk_tenants_plan FOREIGN KEY (plan) REFERENCES plan_limits(plan);
  END IF;
END $$;

-- ── Organisation status and billing identity ───────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status              VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS trial_expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_email       VARCHAR(256),
  ADD COLUMN IF NOT EXISTS legal_name          VARCHAR(256),
  ADD COLUMN IF NOT EXISTS tax_id              VARCHAR(32),
  ADD COLUMN IF NOT EXISTS billing_currency    VARCHAR(3)  NOT NULL DEFAULT 'UAH',
  ADD COLUMN IF NOT EXISTS contract_started_at DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tenants_status') THEN
    ALTER TABLE tenants ADD CONSTRAINT chk_tenants_status
      CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'closed'));
  END IF;
END $$;

-- Backfill from the boolean the code used until now.
UPDATE tenants SET status = 'suspended', suspended_at = COALESCE(suspended_at, now())
 WHERE active = false AND status = 'active';

-- Keep `active` and `status` consistent whichever one a writer touches.
CREATE OR REPLACE FUNCTION tenants_sync_status_active() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.active = false AND NEW.status IN ('trial', 'active', 'past_due') THEN
      NEW.status := 'suspended';
    END IF;
    NEW.active := NEW.status IN ('trial', 'active', 'past_due');
    IF NEW.status IN ('suspended', 'closed') AND NEW.suspended_at IS NULL THEN NEW.suspended_at := now(); END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.active := NEW.status IN ('trial', 'active', 'past_due');
  ELSIF NEW.active IS DISTINCT FROM OLD.active THEN
    NEW.status := CASE WHEN NEW.active THEN 'active' ELSE 'suspended' END;
  END IF;

  IF NEW.status IN ('suspended', 'closed') THEN
    IF OLD.status NOT IN ('suspended', 'closed') OR NEW.suspended_at IS NULL THEN NEW.suspended_at := now(); END IF;
  ELSE
    NEW.suspended_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_sync_status ON tenants;
CREATE TRIGGER trg_tenants_sync_status
  BEFORE INSERT OR UPDATE OF status, active ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_sync_status_active();

-- ── Per-organisation settings ──────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id               UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  timezone                VARCHAR(64) NOT NULL DEFAULT 'Europe/Kyiv',
  locale                  VARCHAR(5)  NOT NULL DEFAULT 'uk',
  door_alarm_delay_ms     INT CHECK (door_alarm_delay_ms IS NULL OR door_alarm_delay_ms BETWEEN 0 AND 7200000),
  pulldown_alarm_delay_ms INT CHECK (pulldown_alarm_delay_ms IS NULL OR pulldown_alarm_delay_ms BETWEEN 0 AND 7200000),
  offline_threshold_ms    INT CHECK (offline_threshold_ms IS NULL OR offline_threshold_ms BETWEEN 30000 AND 3600000),
  offline_alarm_delay_ms  INT CHECK (offline_alarm_delay_ms IS NULL OR offline_alarm_delay_ms BETWEEN 0 AND 86400000),
  ack_escalation_min      INT CHECK (ack_escalation_min IS NULL OR ack_escalation_min BETWEEN 1 AND 1440),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT ON plan_limits TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO modesp_cloud;
