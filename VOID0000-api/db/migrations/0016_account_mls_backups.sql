ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS account_mls_state_encrypted TEXT;

ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS account_mls_state_iv TEXT;

ALTER TABLE user_key_backups
  ADD COLUMN IF NOT EXISTS account_mls_state_key_id TEXT;

-- This independently wrapped MLS snapshot is refreshed by an unlocked account
-- identity so staged KeyPackages can become claimable without retaining a
-- password or requiring a manual recovery action.
