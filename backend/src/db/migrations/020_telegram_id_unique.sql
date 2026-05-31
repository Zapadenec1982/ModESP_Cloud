-- Migration 020: enforce one Telegram account per user
-- Prevents a TOCTOU race in the bot /start link flow from binding a single
-- Telegram chat to multiple user accounts (which would leak another tenant's
-- alarm notifications to that chat). Partial unique — NULLs are unconstrained.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id_unique
  ON users (telegram_id)
  WHERE telegram_id IS NOT NULL;
