-- 015: Audit log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL    PRIMARY KEY,
  tenant_id   UUID         REFERENCES tenants(id),
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  user_email  VARCHAR(256),
  user_role   VARCHAR(16),
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(32),
  entity_id   VARCHAR(64),
  method      VARCHAR(8)   NOT NULL,
  endpoint    VARCHAR(256) NOT NULL,
  status_code SMALLINT     NOT NULL,
  ip          INET,
  user_agent  TEXT,
  changes     JSONB,
  error       TEXT,
  duration_ms INT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(tenant_id, entity_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_global ON audit_log(created_at DESC) WHERE tenant_id IS NULL;

-- Immutability trigger (append-only)
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable — UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
