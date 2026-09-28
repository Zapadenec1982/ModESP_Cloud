-- Migration 055: the notifications page shows, for the signed-in person, each
-- channel's last delivery («Остання перевірка», product audit item 4). The log
-- was indexed by tenant and by subscriber only; the user path that migration
-- 026 added had no index of its own, so that lookup would walk the whole log.
CREATE INDEX IF NOT EXISTS idx_nl_user
  ON notification_log (user_id, channel, created_at DESC)
  WHERE user_id IS NOT NULL;
