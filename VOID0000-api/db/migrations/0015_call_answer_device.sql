ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS answered_by_device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_call_sessions_answered_device
  ON call_sessions (answered_by_device_id)
  WHERE answered_by_device_id IS NOT NULL;
