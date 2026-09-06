-- 037: billing without card payments (plan epic 2.2)
--
-- Invoices are built from the data the system already has: a nightly usage
-- snapshot per organisation (usage_snapshots) multiplied by the list prices of
-- plan_limits. Payment is by bank transfer (IBAN in billing_settings); the
-- superadmin marks an invoice paid by hand or from a bank statement. Dunning
-- moves the organisation to past_due 7 days after the due date, reminds on
-- day 14 and suspends on day 21; payment restores it. A partner (billing
-- account with is_partner) gets one consolidated invoice with a line per
-- client organisation. Card payments (WayForPay / LiqPay, Checkbox) are
-- deliberately not here — they land once the merchant contract exists.

-- 1. Volume tiers of the per-controller price, so the invoice agrees with the
--    pricing page ("від 100 контролерів — 80 грн, від 500 — 60 грн").
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS price_tiers_uah JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE plan_limits SET price_tiers_uah = '[{"from":100,"price":80},{"from":500,"price":60}]'::jsonb
 WHERE plan = 'pro' AND price_tiers_uah = '[]'::jsonb;
UPDATE plan_limits SET price_tiers_uah = '[{"from":100,"price":80},{"from":300,"price":70}]'::jsonb
 WHERE plan = 'partner' AND price_tiers_uah = '[]'::jsonb;

-- 2. What each organisation used on each (UTC) day. Written hourly by
--    services/billing.js (today is refreshed, yesterday finalised).
CREATE TABLE IF NOT EXISTS usage_snapshots (
  tenant_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                DATE        NOT NULL,
  active_devices     INT         NOT NULL DEFAULT 0,
  sites              INT         NOT NULL DEFAULT 0,
  users              INT         NOT NULL DEFAULT 0,
  telemetry_rows     BIGINT      NOT NULL DEFAULT 0,   -- from telemetry_hourly.samples (the archive)
  notifications_sent INT         NOT NULL DEFAULT 0,
  taken_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_day ON usage_snapshots (day);

-- 3. The seller's requisites, printed on every invoice. One row.
CREATE TABLE IF NOT EXISTS billing_settings (
  id             SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seller_name    VARCHAR(256),
  seller_tax_id  VARCHAR(32),
  seller_iban    VARCHAR(64),
  seller_bank    VARCHAR(128),
  seller_address VARCHAR(256),
  seller_email   VARCHAR(256),
  due_days       INT          NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 1 AND 90),
  invoice_note   TEXT,                                 -- e.g. "Без ПДВ (платник єдиного податку)"
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 4. Invoices. `tenant_id` is the payer: the organisation itself, or the
--    partner for a consolidated invoice; `lines` carry the per-organisation
--    breakdown ({kind, tenant_id, tenant_name, qty, unit_price, amount}).
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

CREATE TABLE IF NOT EXISTS invoices (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  number             VARCHAR(32)   NOT NULL UNIQUE,
  tenant_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_account_id UUID          REFERENCES billing_accounts(id) ON DELETE SET NULL,
  period_start       DATE          NOT NULL,
  period_end         DATE          NOT NULL,           -- exclusive
  lines              JSONB         NOT NULL DEFAULT '[]'::jsonb,
  amount             NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency           CHAR(3)       NOT NULL DEFAULT 'UAH',
  status             VARCHAR(16)   NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
  issued_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  due_at             TIMESTAMPTZ   NOT NULL,
  paid_at            TIMESTAMPTZ,
  paid_note          VARCHAR(256),
  voided_at          TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,                      -- e-mail with the PDF
  dunning_stage      SMALLINT      NOT NULL DEFAULT 0, -- 0 none, 1 past_due, 2 reminder, 3 suspended
  dunning_at         TIMESTAMPTZ,
  buyer              JSONB         NOT NULL DEFAULT '{}'::jsonb,  -- legal_name, tax_id, email at issue time
  created_by         UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start),
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices (tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_open   ON invoices (due_at) WHERE status = 'issued';

-- 5. "Change my plan" requests from an organisation's admin; the superadmin
--    approves (the plan changes) or rejects. One pending request at a time.
CREATE TABLE IF NOT EXISTS plan_change_requests (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
  current_plan    VARCHAR(16),
  requested_plan  VARCHAR(16)  NOT NULL REFERENCES plan_limits(plan),
  message         TEXT,
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  resolved_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note VARCHAR(256),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_change_one_pending ON plan_change_requests (tenant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_plan_change_status ON plan_change_requests (status, created_at DESC);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_snapshots TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE ON billing_settings TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_change_requests TO modesp_cloud;
GRANT USAGE, SELECT ON SEQUENCE invoice_number_seq TO modesp_cloud;
