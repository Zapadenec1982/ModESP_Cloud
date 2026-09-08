-- 038: Self-registration, trial and onboarding checklist (plan epic 2.1)
--
-- users.email_verified_at   — a self-registered admin proves the address by
--                             following the link from the verification e-mail
--                             before the first login. Accounts created by an
--                             administrator or through an invitation sent to
--                             that very address count as verified.
-- users.terms_accepted_at   — when the offer and the privacy policy were
--                             accepted (registration, invitation acceptance).
-- tenants.registered_at     — the organisation created itself through
--                             POST /auth/register (NULL: a superadmin or a
--                             partner created it).
-- tenants.approved_at       — REGISTRATION_MODE=approve keeps a registered
--                             organisation suspended until a superadmin
--                             approves it; open mode approves on the spot.
-- tenant_settings.onboarding — progress of the getting-started checklist on
--                             the dashboard: {steps: {site: ts, …}, dismissed_at}.

-- Verified by default: every account that exists today was created by an
-- administrator or accepted an invitation sent to its address, and so is every
-- account POST /users, seed-admin.js or seed-demo.js creates from now on. Only
-- POST /auth/register writes NULL here, and only when it has a channel to send
-- the link through — a code path that forgets the column can never lock
-- anyone out.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at    TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS email_verify_hash    CHAR(64),
  ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_accepted_at    TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registered_ip INET,
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by   UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS onboarding JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The superadmin's "awaiting approval" list and the hourly trial sweep.
CREATE INDEX IF NOT EXISTS idx_tenants_awaiting_approval
  ON tenants (registered_at) WHERE registered_at IS NOT NULL AND approved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_trial_expiry
  ON tenants (trial_expires_at) WHERE status = 'trial' AND trial_expires_at IS NOT NULL;
