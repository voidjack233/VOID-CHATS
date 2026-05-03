ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS recovery_mls_state_encrypted TEXT;

ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS recovery_mls_state_iv TEXT;

ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS recovery_mls_state_salt TEXT;
