ALTER TABLE mls_key_packages
  ADD COLUMN IF NOT EXISTS claimable_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mls_key_packages_claimable
  ON mls_key_packages (user_id, created_at DESC)
  WHERE published_at IS NOT NULL
    AND claimable_at IS NOT NULL
    AND consumed_at IS NULL;

-- Existing public packages cannot be proven to be present in an encrypted
-- MLS backup. They remain quarantined until their owner uploads a fresh
-- encrypted MLS backup and activates those matching package refs.
