CREATE TABLE IF NOT EXISTS conversation_membership_rotations (
  operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct_add', 'invite_approval', 'remove')),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  target_user_ids UUID[] NOT NULL,
  reserved_key_version INTEGER NOT NULL,
  join_request_id BIGINT REFERENCES conversation_join_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'finalized', 'rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_membership_rotations_pending
  ON conversation_membership_rotations (conversation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_conversation_membership_rotations_conversation_created
  ON conversation_membership_rotations (conversation_id, created_at DESC);

-- Old prepares stored intent only; cancel any abandoned reservation when the
-- server switches to the single serialized membership-rotation lane.
UPDATE conversations
SET pending_add_user_ids = NULL,
    pending_add_key_version = NULL,
    pending_remove_target = NULL,
    pending_remove_key_version = NULL,
    pending_approve_request_id = NULL,
    pending_approve_user_id = NULL,
    pending_approve_key_version = NULL,
    updated_at = NOW()
WHERE pending_add_key_version IS NOT NULL
   OR pending_remove_key_version IS NOT NULL
   OR pending_approve_key_version IS NOT NULL;
