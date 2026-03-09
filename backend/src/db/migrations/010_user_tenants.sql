-- Migration 010: Multi-tenant user memberships (M:N user↔tenant)
-- Allows a single user to belong to multiple tenants with tenant switching.

CREATE TABLE user_tenants (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX idx_user_tenants_tenant ON user_tenants(tenant_id);

-- Seed from existing users.tenant_id
INSERT INTO user_tenants (user_id, tenant_id)
  SELECT id, tenant_id FROM users WHERE tenant_id IS NOT NULL;
