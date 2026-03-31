-- Add persisted message notification preference to user_preferences.
-- Existing rows get TRUE (keep current behaviour for all existing users).

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS message_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
