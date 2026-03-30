CREATE TABLE IF NOT EXISTS mls_key_packages (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_ref TEXT NOT NULL,
  package_data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS mls_key_packages_user_id_package_ref_key
  ON mls_key_packages (user_id, package_ref);

CREATE INDEX IF NOT EXISTS idx_mls_key_packages_user_id
  ON mls_key_packages (user_id);

CREATE TABLE IF NOT EXISTS mls_group_states (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  state_blob TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  key_version INTEGER,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE mls_group_states ADD COLUMN IF NOT EXISTS key_version INTEGER;
ALTER TABLE mls_group_states ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
DELETE FROM mls_group_states WHERE user_id IS NULL;
ALTER TABLE mls_group_states ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE mls_group_states DROP CONSTRAINT IF EXISTS mls_group_states_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_states_user_unique
  ON mls_group_states (conversation_id, user_id);

CREATE INDEX IF NOT EXISTS idx_mls_group_states_updated_at
  ON mls_group_states (updated_at DESC);

CREATE TABLE IF NOT EXISTS mls_welcome_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  welcome_ref TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS mls_welcome_messages_user_id_welcome_ref_key
  ON mls_welcome_messages (user_id, welcome_ref);

CREATE INDEX IF NOT EXISTS idx_mls_welcome_messages_user_id
  ON mls_welcome_messages (user_id, consumed_at, received_at);

CREATE TABLE IF NOT EXISTS mls_commit_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  commit_ref TEXT NOT NULL,
  payload TEXT NOT NULL,
  epoch INTEGER,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS mls_commit_messages_conversation_id_commit_ref_key
  ON mls_commit_messages (conversation_id, commit_ref);

CREATE INDEX IF NOT EXISTS idx_mls_commit_messages_conversation_id
  ON mls_commit_messages (conversation_id, applied_at, received_at);

CREATE TABLE IF NOT EXISTS mls_group_key_archive (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  key_data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE mls_group_key_archive ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
DELETE FROM mls_group_key_archive WHERE user_id IS NULL;
ALTER TABLE mls_group_key_archive ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE mls_group_key_archive DROP CONSTRAINT IF EXISTS mls_group_key_archive_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_key_archive_user_unique
  ON mls_group_key_archive (conversation_id, key_version, user_id);
