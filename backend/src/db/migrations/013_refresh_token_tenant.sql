-- Migration 013: Add tenant_id to refresh_tokens
-- Preserves tenant context across token refresh (multi-tenant users)

ALTER TABLE refresh_tokens
  ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Backfill existing tokens with user's default tenant_id
UPDATE refresh_tokens rt
   SET tenant_id = u.tenant_id
  FROM users u
 WHERE u.id = rt.user_id
   AND rt.tenant_id IS NULL;
