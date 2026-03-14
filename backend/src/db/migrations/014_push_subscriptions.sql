-- Migration 014: Web Push subscriptions table
-- Stores Web Push API subscription data for PWA push notifications.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  key_p256dh    TEXT NOT NULL,
  key_auth      TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  active        BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user   ON push_subscriptions(user_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_push_subs_tenant ON push_subscriptions(tenant_id) WHERE active = true;

-- Changelog
-- 2026-03-14 — Created. Web Push subscriptions for PWA notifications.
