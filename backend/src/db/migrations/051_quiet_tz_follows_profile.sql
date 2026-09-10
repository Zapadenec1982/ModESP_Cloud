-- Quiet hours run in the person's own time zone.
--
-- user_notification_prefs.quiet_tz was NOT NULL DEFAULT 'Europe/Kyiv', a second
-- time-zone field for the same fact as users.timezone — and the settings page
-- shows both, one under the other. Someone who set their profile to
-- Europe/Warsaw still got a quiet window computed in Kyiv, an hour off, with
-- nothing on screen to explain it.
--
-- NULL now means «the time zone on my profile»; a value still wins, for the rare
-- case of a window that genuinely belongs to another zone.
--
-- Rows that hold the old default are set to NULL: 'Europe/Kyiv' was what the
-- column wrote by itself, not a choice anyone made. For a user whose profile
-- says Kyiv (or says nothing) the behaviour is identical — the fallback ends at
-- the same value. It changes only for a user whose profile says something else,
-- which is exactly the bug being fixed.

ALTER TABLE user_notification_prefs ALTER COLUMN quiet_tz DROP NOT NULL;
ALTER TABLE user_notification_prefs ALTER COLUMN quiet_tz DROP DEFAULT;

UPDATE user_notification_prefs SET quiet_tz = NULL WHERE quiet_tz = 'Europe/Kyiv';
