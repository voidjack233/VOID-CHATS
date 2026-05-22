ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS started_by_last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS target_last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_signal_at TIMESTAMPTZ;

UPDATE call_sessions
SET started_by_last_seen_at = COALESCE(started_by_last_seen_at, started_at),
    target_last_seen_at = COALESCE(target_last_seen_at, answered_at),
    last_signal_at = COALESCE(last_signal_at, updated_at, started_at)
WHERE status IN ('ringing', 'active');

CREATE INDEX IF NOT EXISTS idx_call_sessions_live_heartbeats
  ON call_sessions (status, started_by_last_seen_at, target_last_seen_at)
  WHERE status IN ('ringing', 'active');
