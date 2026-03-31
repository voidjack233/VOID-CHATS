-- Attachment archive / index for conversation settings (Media & Files views).
-- Rows are inserted when a message with attachments is persisted, not on upload.
-- Only metadata is stored — no plaintext content, preserving E2EE.

CREATE TABLE IF NOT EXISTS conversation_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL,
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_kind VARCHAR(8) NOT NULL CHECK (attachment_kind IN ('media', 'file')),
  mime          TEXT,
  name          TEXT,
  size          INTEGER,
  storage_url   TEXT NOT NULL,
  encrypted     BOOLEAN NOT NULL DEFAULT FALSE,
  encryption_iv TEXT,
  encryption_key TEXT,
  blurhash      TEXT,
  hidden_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: list media or files for a conversation, newest first, with cursor.
CREATE INDEX idx_conv_attachments_listing
  ON conversation_attachments (conversation_id, attachment_kind, created_at DESC, id DESC)
  WHERE hidden_at IS NULL;

-- Look up archive rows by message_id (for soft-hide on message delete).
CREATE INDEX idx_conv_attachments_message
  ON conversation_attachments (message_id);
