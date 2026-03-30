-- Per-user DM hide and mute state stored directly on conversation_members.
-- is_hidden: TRUE means this user has closed/hidden the DM from their list.
-- muted_until: NULL = not muted; any future timestamp = muted (use far-future
--              for "until I turn it back on").

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;

-- Partial index: fast lookup of hidden rows per user (only rows where hidden).
CREATE INDEX IF NOT EXISTS idx_conv_members_hidden
  ON conversation_members (user_id, conversation_id)
  WHERE is_hidden = TRUE;
