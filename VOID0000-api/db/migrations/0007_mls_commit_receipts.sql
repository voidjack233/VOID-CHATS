CREATE TABLE IF NOT EXISTS mls_commit_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  commit_ref TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id, commit_ref)
);

CREATE INDEX IF NOT EXISTS idx_mls_commit_receipts_conversation_user
  ON mls_commit_receipts (conversation_id, user_id, applied_at DESC);
