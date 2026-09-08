-- 041: Organisation lifecycle and data export (plan epic 2.10)
--
-- tenants.closed_at  — when the organisation entered `closed`; the lifecycle
--                      sweep purges its operational data CLOSED_RETENTION_DAYS
--                      later (30 by default). Until then it is read-only.
-- tenants.purged_at  — data removed, devices back in the pending queue; the
--                      organisation, its users and its invoices stay.
-- tenant_exports     — one row per "give me my data" request: a zip with a
--                      CSV per table and a HACCP PDF per site, downloadable
--                      for EXPORT_TTL_DAYS.
-- audit_log          — the immutable trigger now admits exactly one kind of
--                      UPDATE: pseudonymising the person fields (user_email,
--                      ip, user_agent, and detaching user_id / tenant_id) from
--                      the SECURITY DEFINER functions below. Nothing else
--                      changes; DELETE stays prohibited; the trigger is never
--                      disabled any more.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- closed_at follows the status: set on entering `closed`, kept while closed, cleared on leaving.
-- Runs after trg_tenants_sync_status (trigger names fire alphabetically), so it sees the final status.
CREATE OR REPLACE FUNCTION tenants_track_closed() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_track_closed ON tenants;
CREATE TRIGGER trg_tenants_track_closed
  BEFORE INSERT OR UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_track_closed();

UPDATE tenants SET closed_at = COALESCE(suspended_at, now()) WHERE status = 'closed' AND closed_at IS NULL;

-- ── Data export requests ──────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_exports (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  status        VARCHAR(8)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
  file_path     TEXT,
  file_name     VARCHAR(160),
  bytes         BIGINT,
  sha256        CHAR(64),
  manifest      JSONB,                       -- tables and row counts, reports included
  error         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ                  -- the file is removed after this
);

CREATE INDEX IF NOT EXISTS idx_tenant_exports_tenant ON tenant_exports (tenant_id, created_at DESC);

-- ── audit_log: pseudonymisation without disabling the trigger ──
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('modesp.audit_pii_scrub', true) = 'on'
     AND NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.entity_type IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id   IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.method      IS NOT DISTINCT FROM OLD.method
     AND NEW.endpoint    IS NOT DISTINCT FROM OLD.endpoint
     AND NEW.status_code IS NOT DISTINCT FROM OLD.status_code
     AND NEW.changes     IS NOT DISTINCT FROM OLD.changes
     AND NEW.error       IS NOT DISTINCT FROM OLD.error
     AND NEW.duration_ms IS NOT DISTINCT FROM OLD.duration_ms
     AND NEW.user_role   IS NOT DISTINCT FROM OLD.user_role
     AND NEW.created_at = OLD.created_at
     AND (NEW.user_id   IS NULL OR NEW.user_id   = OLD.user_id)
     AND (NEW.tenant_id IS NULL OR NEW.tenant_id = OLD.tenant_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is immutable — UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

-- A deleted person leaves their actions in the trail, but not their identity:
-- the e-mail becomes a stable pseudonym, address and browser are dropped.
CREATE OR REPLACE FUNCTION audit_log_scrub_user(p_user_id UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  PERFORM set_config('modesp.audit_pii_scrub', 'on', true);
  UPDATE audit_log
     SET user_id    = NULL,
         user_email = CASE WHEN user_email IS NULL THEN NULL
                           ELSE 'deleted-' || left(encode(sha256(convert_to(lower(user_email), 'UTF8')), 'hex'), 12) || '@removed' END,
         ip         = NULL,
         user_agent = NULL
   WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('modesp.audit_pii_scrub', 'off', true);
  RETURN n;
END;
$$;

-- Hard delete of an organisation: its users' rows are pseudonymised and the
-- organisation reference dropped, so the FKs can go without touching the trigger.
CREATE OR REPLACE FUNCTION audit_log_detach_tenant(p_tenant_id UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  PERFORM set_config('modesp.audit_pii_scrub', 'on', true);
  UPDATE audit_log
     SET user_id    = NULL,
         user_email = CASE WHEN user_email IS NULL THEN NULL
                           ELSE 'deleted-' || left(encode(sha256(convert_to(lower(user_email), 'UTF8')), 'hex'), 12) || '@removed' END,
         ip         = NULL,
         user_agent = NULL
   WHERE user_id IN (SELECT id FROM users WHERE tenant_id = p_tenant_id);
  UPDATE audit_log SET tenant_id = NULL WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('modesp.audit_pii_scrub', 'off', true);
  RETURN n;
END;
$$;

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_exports TO modesp_cloud;
GRANT EXECUTE ON FUNCTION audit_log_scrub_user(UUID) TO modesp_cloud;
GRANT EXECUTE ON FUNCTION audit_log_detach_tenant(UUID) TO modesp_cloud;
