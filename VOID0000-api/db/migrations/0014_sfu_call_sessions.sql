CREATE TABLE IF NOT EXISTS sfu_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media VARCHAR(16) NOT NULL DEFAULT 'audio',
  status VARCHAR(16) NOT NULL DEFAULT 'ringing',
  sfu_provider VARCHAR(64) NOT NULL DEFAULT 'unconfigured',
  sfu_room_name TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_by UUID REFERENCES users(id) ON DELETE SET NULL,
  end_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (media IN ('audio', 'video')),
  CHECK (status IN ('ringing', 'active', 'ended', 'rejected', 'cancelled', 'missed'))
);

CREATE INDEX IF NOT EXISTS idx_sfu_call_sessions_conversation_started
  ON sfu_call_sessions (conversation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sfu_call_sessions_started_live
  ON sfu_call_sessions (started_by, status)
  WHERE status IN ('ringing', 'active');

CREATE INDEX IF NOT EXISTS idx_sfu_call_sessions_target_live
  ON sfu_call_sessions (target_user_id, status)
  WHERE status IN ('ringing', 'active');
