-- Migration 012: Telegram user linking support
-- Adds link code columns and indexes for connecting Telegram accounts to system users.

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires TIMESTAMPTZ;

-- Fast lookup when bot receives /start CODE
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_link_code
  ON users(telegram_link_code) WHERE telegram_link_code IS NOT NULL;

-- Fast lookup on every bot command: resolveUser(telegram_id)
CREATE INDEX IF NOT EXISTS idx_users_telegram_id
  ON users(telegram_id) WHERE telegram_id IS NOT NULL;
