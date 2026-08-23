-- Phase 12: Email Notifications — extend notification_subscribers for email channel
-- Also adds 'webpush' to constraint for completeness (webpush uses push_subscriptions table
-- directly, but the constraint should reflect all valid channel values).

-- Drop old constraint and add updated one
ALTER TABLE notification_subscribers
  DROP CONSTRAINT IF EXISTS valid_channel;

ALTER TABLE notification_subscribers
  ADD CONSTRAINT valid_channel CHECK (channel IN ('telegram', 'fcm', 'email'));
