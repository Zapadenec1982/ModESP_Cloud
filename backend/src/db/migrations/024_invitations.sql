-- 024: Invitations (plan epic 1.5)
--
-- An admin invites an email address into an organisation; the invitee follows
-- a link (#/invite/<token>), sets a password (or proves an existing one) and is
-- logged in. Replaces the founder-set initial passwords of POST /users for
-- everyday onboarding. Only the SHA-256 of the token is stored.

CREATE TABLE IF NOT EXISTS invitations (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email            VARCHAR(256) NOT NULL,
  role             VARCHAR(16)  NOT NULL DEFAULT 'viewer'
                   CHECK (role IN ('admin', 'technician', 'viewer')),
  token_hash       VARCHAR(64)  NOT NULL UNIQUE,
  invited_by       UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  accepted_at      TIMESTAMPTZ,
  accepted_user_id UUID         REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invitations_tenant_open
  ON invitations (tenant_id, created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (lower(email));

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO modesp_cloud;
