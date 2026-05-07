CREATE TABLE IF NOT EXISTS mls_group_state_history (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  state_blob TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id, key_version)
);

CREATE INDEX IF NOT EXISTS idx_mls_group_state_history_conversation_version
  ON mls_group_state_history (conversation_id, key_version, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mls_group_state_history_user
  ON mls_group_state_history (user_id, conversation_id, key_version);

INSERT INTO mls_group_state_history (
  conversation_id,
  user_id,
  group_id,
  epoch,
  key_version,
  state_blob,
  created_at,
  updated_at
)
SELECT
  conversation_id,
  user_id,
  group_id,
  epoch,
  key_version,
  state_blob,
  created_at,
  updated_at
FROM mls_group_states
WHERE user_id IS NOT NULL
  AND key_version IS NOT NULL
ON CONFLICT (conversation_id, user_id, key_version) DO NOTHING;
