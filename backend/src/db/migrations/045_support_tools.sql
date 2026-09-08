-- Support tools (plan epic 2.13)
--
-- audit_log          — two columns say when an action was taken by a support
--                      engineer signed in as the user (impersonation): the
--                      impersonator stays named next to the user they acted as.
--                      The immutability trigger and the pseudonymisation
--                      functions of migration 041 learn about them.
-- support_requests   — the "Support" form of the sidebar: stored first, mailed
--                      second, so a ticket survives an unconfigured mailer.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS impersonator_id UUID;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS impersonator_email VARCHAR(256);
CREATE INDEX IF NOT EXISTS idx_audit_log_impersonated
  ON audit_log (tenant_id, created_at DESC) WHERE impersonator_id IS NOT NULL;

-- ── audit_log: the scrub may also drop the impersonator's identity ──
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
     AND (NEW.user_id         IS NULL OR NEW.user_id         = OLD.user_id)
     AND (NEW.tenant_id       IS NULL OR NEW.tenant_id       = OLD.tenant_id)
     AND (NEW.impersonator_id IS NULL OR NEW.impersonator_id = OLD.impersonator_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is immutable — UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

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
  -- …and the rows where the deleted person was the support engineer acting as someone else
  UPDATE audit_log
     SET impersonator_id    = NULL,
         impersonator_email = CASE WHEN impersonator_email IS NULL THEN NULL
                                   ELSE 'deleted-' || left(encode(sha256(convert_to(lower(impersonator_email), 'UTF8')), 'hex'), 12) || '@removed' END
   WHERE impersonator_id = p_user_id;
  PERFORM set_config('modesp.audit_pii_scrub', 'off', true);
  RETURN n;
END;
$$;

-- ── support_requests ──
CREATE TABLE IF NOT EXISTS support_requests (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  user_email  VARCHAR(256) NOT NULL,
  user_role   VARCHAR(16),
  category    VARCHAR(16)  NOT NULL CHECK (category IN ('question', 'problem', 'billing', 'feature', 'other')),
  subject     VARCHAR(160) NOT NULL,
  message     TEXT         NOT NULL,
  context     JSONB,                       -- page, device, browser, app version — what the form attached
  status      VARCHAR(8)   NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'closed')),
  emailed_at  TIMESTAMPTZ,
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_requests_tenant ON support_requests (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests (status, created_at DESC);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON support_requests TO modesp_cloud;
