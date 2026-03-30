CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL,
  name VARCHAR(100),
  owner_id UUID,
  icon_filename VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  parent_conversation_id UUID,
  public_id BIGINT,
  category_id UUID,
  topic TEXT,
  slowmode_seconds INTEGER NOT NULL DEFAULT 0,
  is_age_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  current_key_version INTEGER,
  last_message_at TIMESTAMPTZ,
  pending_remove_target UUID,
  pending_remove_key_version INTEGER,
  pending_add_user_ids UUID[],
  pending_add_key_version INTEGER,
  pending_approve_request_id INTEGER,
  pending_approve_user_id UUID,
  pending_approve_key_version INTEGER,
  first_message_at TIMESTAMPTZ,
  permissions JSONB
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icon_filename VARCHAR(255);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_conversation_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS public_id BIGINT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_age_restricted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS current_key_version INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_remove_target UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_remove_key_version INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_add_user_ids UUID[];
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_add_key_version INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_approve_request_id INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_approve_user_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_approve_key_version INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS permissions JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_type_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_type_check
      CHECK (type IN ('dm', 'group', 'channel'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_slowmode_seconds_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_slowmode_seconds_check
      CHECK (slowmode_seconds IN (0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_owner_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES users(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_parent_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_parent_conversation_id_fkey
      FOREIGN KEY (parent_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_public_id
  ON conversations (public_id)
  WHERE public_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_parent_conversation_id
  ON conversations (parent_conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversations_parent_category
  ON conversations (parent_conversation_id, category_id);

CREATE TABLE IF NOT EXISTS conversation_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_conversation_id UUID NOT NULL,
  name VARCHAR(100) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_default BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS group_conversation_id UUID;
ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE conversation_categories ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_categories_group_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversation_categories
      ADD CONSTRAINT conversation_categories_group_conversation_id_fkey
      FOREIGN KEY (group_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_categories_group_name_ci
  ON conversation_categories (group_conversation_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_conversation_categories_group_position
  ON conversation_categories (group_conversation_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_categories_single_default
  ON conversation_categories (group_conversation_id)
  WHERE is_default = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_category_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES conversation_categories(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role VARCHAR(16) DEFAULT 'member',
  nickname VARCHAR(32),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_message_id TEXT,
  last_message_sent_at TIMESTAMPTZ,
  joined_key_version INTEGER,
  history_start_version INTEGER,
  unread_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS role VARCHAR(16) DEFAULT 'member';
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS nickname VARCHAR(32);
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS last_read_message_id TEXT;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS last_message_sent_at TIMESTAMPTZ;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS joined_key_version INTEGER;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS history_start_version INTEGER;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversation_members
      ADD CONSTRAINT conversation_members_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_members
      ADD CONSTRAINT conversation_members_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_role_check'
  ) THEN
    ALTER TABLE conversation_members
      ADD CONSTRAINT conversation_members_role_check
      CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conv_members_user
  ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS dm_pairs (
  user_a UUID NOT NULL,
  user_b UUID NOT NULL,
  conversation_id UUID,
  PRIMARY KEY (user_a, user_b)
);

ALTER TABLE dm_pairs ADD COLUMN IF NOT EXISTS conversation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dm_pairs_check'
  ) THEN
    ALTER TABLE dm_pairs
      ADD CONSTRAINT dm_pairs_check
      CHECK (user_a < user_b);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dm_pairs_conversation_id_fkey'
  ) THEN
    ALTER TABLE dm_pairs
      ADD CONSTRAINT dm_pairs_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES conversations(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dm_pairs_conv
  ON dm_pairs (conversation_id);

CREATE TABLE IF NOT EXISTS conversation_key_rotations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  previous_key_version INTEGER,
  new_key_version INTEGER NOT NULL,
  rotated_by_user_id UUID,
  reason TEXT NOT NULL,
  affected_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_key_rotations_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversation_key_rotations
      ADD CONSTRAINT conversation_key_rotations_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_key_rotations_rotated_by_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_key_rotations
      ADD CONSTRAINT conversation_key_rotations_rotated_by_user_id_fkey
      FOREIGN KEY (rotated_by_user_id) REFERENCES users(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_key_rotations_affected_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_key_rotations
      ADD CONSTRAINT conversation_key_rotations_affected_user_id_fkey
      FOREIGN KEY (affected_user_id) REFERENCES users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversation_key_rotations_conversation_created
  ON conversation_key_rotations (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_invite_links (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  created_by_user_id UUID,
  code TEXT NOT NULL,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_invite_links_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversation_invite_links
      ADD CONSTRAINT conversation_invite_links_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_invite_links_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_invite_links
      ADD CONSTRAINT conversation_invite_links_created_by_user_id_fkey
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_invite_links_max_uses_check'
  ) THEN
    ALTER TABLE conversation_invite_links
      ADD CONSTRAINT conversation_invite_links_max_uses_check
      CHECK (max_uses IS NULL OR max_uses > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_invite_links_use_count_check'
  ) THEN
    ALTER TABLE conversation_invite_links
      ADD CONSTRAINT conversation_invite_links_use_count_check
      CHECK (use_count >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_invite_links_code_key
  ON conversation_invite_links (code);

CREATE INDEX IF NOT EXISTS idx_conversation_invite_links_conversation_created
  ON conversation_invite_links (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_join_requests (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  invite_link_id BIGINT,
  requester_user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_join_requests_conversation_id_fkey'
  ) THEN
    ALTER TABLE conversation_join_requests
      ADD CONSTRAINT conversation_join_requests_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_join_requests_invite_link_id_fkey'
  ) THEN
    ALTER TABLE conversation_join_requests
      ADD CONSTRAINT conversation_join_requests_invite_link_id_fkey
      FOREIGN KEY (invite_link_id) REFERENCES conversation_invite_links(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_join_requests_requester_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_join_requests
      ADD CONSTRAINT conversation_join_requests_requester_user_id_fkey
      FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_join_requests_resolved_by_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_join_requests
      ADD CONSTRAINT conversation_join_requests_resolved_by_user_id_fkey
      FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_join_requests_status_check'
  ) THEN
    ALTER TABLE conversation_join_requests
      ADD CONSTRAINT conversation_join_requests_status_check
      CHECK (status IN ('pending', 'approved', 'declined'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversation_join_requests_conversation_status
  ON conversation_join_requests (conversation_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_join_requests_pending_unique
  ON conversation_join_requests (conversation_id, requester_user_id)
  WHERE status = 'pending';
