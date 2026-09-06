-- 036: partner plan (plan epic 2.5)
--
-- A service company on the "partner" plan runs its clients' organisations:
-- it creates them, puts its own technicians into them, sees their alarms and
-- work orders in one place and pays one invoice for all of them. Three things
-- the data model lacked for that:
--
--   1. A role per membership. users.role was one role for every organisation
--      a person belongs to; a partner's technician is `admin` at the partner
--      and `technician` at the client. user_tenants.role now carries the role
--      the access token gets for that organisation (routes/auth.js roleFor);
--      users.role stays the home-organisation role and the superadmin flag.
--   2. The parent link. tenants.parent_tenant_id points a client organisation
--      at the partner that manages it — one level, never itself.
--   3. A billing account. billing_accounts is who pays; a partner's clients
--      share the partner's account, so the consolidated invoice of plan epic
--      2.2 has a party to address. Nothing is billed yet.
--
-- Branding: tenant_settings gains brand_name / brand_logo_url / brand_url,
-- shown on public status pages and in HACCP PDFs of the organisation and, when
-- it has none of its own, of its clients (plan feature `branding`).

-- 1. Role per membership, backfilled from the account role.
ALTER TABLE user_tenants ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'viewer';
ALTER TABLE user_tenants DROP CONSTRAINT IF EXISTS user_tenants_role_check;
ALTER TABLE user_tenants ADD CONSTRAINT user_tenants_role_check
  CHECK (role IN ('admin', 'technician', 'viewer'));
UPDATE user_tenants ut
   SET role = CASE WHEN u.role = 'superadmin' THEN 'admin' ELSE u.role END
  FROM users u
 WHERE u.id = ut.user_id AND u.role IN ('superadmin', 'admin', 'technician', 'viewer');

-- 2. Who pays.
CREATE TABLE IF NOT EXISTS billing_accounts (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name     VARCHAR(256)  NOT NULL,
  tax_id         VARCHAR(32),
  email          VARCHAR(256),
  currency       CHAR(3)       NOT NULL DEFAULT 'UAH',
  payment_method VARCHAR(16)   NOT NULL DEFAULT 'invoice' CHECK (payment_method IN ('invoice', 'card')),
  is_partner     BOOLEAN       NOT NULL DEFAULT false,
  margin_pct     NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (margin_pct >= 0 AND margin_pct <= 100),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_account_id UUID REFERENCES billing_accounts(id) ON DELETE SET NULL;

-- 3. Client → partner.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS chk_tenants_parent_not_self;
ALTER TABLE tenants ADD CONSTRAINT chk_tenants_parent_not_self CHECK (parent_tenant_id IS NULL OR parent_tenant_id <> id);
CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants (parent_tenant_id) WHERE parent_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_billing_account ON tenants (billing_account_id) WHERE billing_account_id IS NOT NULL;

-- 4. Branding.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS brand_name     VARCHAR(128);
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS brand_logo_url VARCHAR(512);
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS brand_url      VARCHAR(512);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_accounts TO modesp_cloud;
