ALTER TABLE mls_welcome_messages
  ADD COLUMN IF NOT EXISTS key_version INTEGER;
