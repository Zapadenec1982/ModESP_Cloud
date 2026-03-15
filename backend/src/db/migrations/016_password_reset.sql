-- 016: Password reset codes (admin-generated, time-limited)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_code VARCHAR(32),
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;
