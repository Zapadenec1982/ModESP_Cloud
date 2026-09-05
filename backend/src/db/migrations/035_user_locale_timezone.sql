-- 035: language and time zone per user (plan epic 2.11)
--
-- The organisation already has both (tenant_settings.locale / .timezone,
-- migration 027). A technician in a Polish organisation who reads Ukrainian,
-- or an administrator travelling, needs their own. NULL means "as the
-- organisation": user.locale → tenant_settings.locale → 'uk', and the same
-- for the time zone (lib/locale.js). Every channel — Telegram, e-mail, web
-- push — renders in that language and zone; the WebUI switches to the user's
-- language on login and stores the switcher's choice here.

ALTER TABLE users ADD COLUMN IF NOT EXISTS locale   VARCHAR(5);
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check
  CHECK (locale IS NULL OR locale IN ('uk', 'en', 'pl', 'de'));
