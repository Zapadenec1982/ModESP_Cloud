-- 042: API keys and webhooks (plan epic 2.6)
--
-- api_keys           — machine-to-machine access to an organisation's API:
--                      "Authorization: Bearer modesp_…", stored as a SHA-256,
--                      scoped read / write / admin, revocable, optionally expiring.
-- webhooks           — where the organisation wants its events delivered:
--                      alarms raised/cleared/acknowledged, controllers going
--                      offline/online, work orders, maintenance hints. Every
--                      delivery is signed with the hook's secret (HMAC-SHA256);
--                      the secret is encrypted at rest like the TOTP secrets.
-- webhook_deliveries — one row per event per hook: retried with backoff, then
--                      dead; ten consecutive failures switch the hook off.

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(80)  NOT NULL,
  prefix       VARCHAR(16)  NOT NULL,                    -- first characters of the key, for the list
  key_hash     CHAR(64)     NOT NULL UNIQUE,             -- SHA-256 of the full key; the key itself is shown once
  scope        VARCHAR(8)   NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write', 'admin')),
  created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             VARCHAR(80)  NOT NULL,
  url              TEXT         NOT NULL,
  secret           TEXT         NOT NULL,                -- encrypted (v1:iv:tag:ciphertext)
  events           TEXT[]       NOT NULL,
  enabled          BOOLEAN      NOT NULL DEFAULT true,
  failures         INT          NOT NULL DEFAULT 0,      -- consecutive failed attempts; 10 disables the hook
  disabled_at      TIMESTAMPTZ,
  disabled_reason  VARCHAR(16),                          -- failures | manual
  last_delivery_at TIMESTAMPTZ,
  last_status      INT,
  created_by       UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID         PRIMARY KEY,
  webhook_id      UUID         NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event           VARCHAR(40)  NOT NULL,
  payload         JSONB        NOT NULL,
  status          VARCHAR(8)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed', 'dead')),
  attempts        INT          NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status_code     INT,
  error           TEXT,
  duration_ms     INT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);

-- Each GRANT on one physical line (test/helpers/migrate.js comments them out per line).
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks TO modesp_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO modesp_cloud;
