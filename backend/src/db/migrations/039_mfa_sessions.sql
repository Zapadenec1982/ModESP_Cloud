-- 039: MFA, sessions and the httpOnly refresh cookie (plan epic 2.9)
--
-- refresh_tokens.family_id — one session = one family. Every refresh rotates
--                            the token but keeps the family, so the "Sessions"
--                            page shows one row per device and revoking it
--                            ends the whole chain. A revoked token presented
--                            again means the chain leaked: the family is closed.
-- refresh_tokens.user_agent / ip / last_used_at — what the Sessions page shows.
-- users.mfa_*               — TOTP (RFC 6238): the secret is stored encrypted
--                            (AES-256-GCM under MFA_ENCRYPTION_KEY, falling
--                            back to JWT_SECRET); a setup in progress lives in
--                            mfa_pending_secret until the first code proves the
--                            authenticator; backup codes are stored as SHA-256;
--                            mfa_last_step stops a code from being replayed
--                            inside its 30-second window.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS user_agent   VARCHAR(256),
  ADD COLUMN IF NOT EXISTS ip           INET,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (user_id, family_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_secret         TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_backup_codes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mfa_last_step      BIGINT;
