CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_verified BOOLEAN DEFAULT FALSE,
  profile_id BIGINT
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_id BIGINT;

CREATE TABLE IF NOT EXISTS user_profiles (
  id BIGINT PRIMARY KEY,
  user_id UUID NOT NULL,
  display_name VARCHAR,
  bio VARCHAR,
  avatar_filename VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS display_name VARCHAR;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bio VARCHAR;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_filename VARCHAR;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_username_key
      UNIQUE (username);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_email_key'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_email_key
      UNIQUE (email);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_profile_id_key'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_profile_id_key
      UNIQUE (profile_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_user_id_key'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_user_id_key
      UNIQUE (user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_profile_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_profile_id_fkey
      FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_username_trgm
  ON users USING gin (username gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_profiles_display_name_trgm
  ON user_profiles USING gin (display_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id UUID NOT NULL,
  addressee_id UUID NOT NULL,
  status VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE friendships ADD COLUMN IF NOT EXISTS requester_id UUID;
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS addressee_id UUID;
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS status VARCHAR;
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'friendships_requester_id_addressee_id_key'
  ) THEN
    ALTER TABLE friendships
      ADD CONSTRAINT friendships_requester_id_addressee_id_key
      UNIQUE (requester_id, addressee_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'friendships_requester_id_fkey'
  ) THEN
    ALTER TABLE friendships
      ADD CONSTRAINT friendships_requester_id_fkey
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'friendships_addressee_id_fkey'
  ) THEN
    ALTER TABLE friendships
      ADD CONSTRAINT friendships_addressee_id_fkey
      FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_friendships_requester
  ON friendships (requester_id);

CREATE INDEX IF NOT EXISTS idx_friendships_addressee
  ON friendships (addressee_id);

CREATE INDEX IF NOT EXISTS idx_friendships_status
  ON friendships (status);

CREATE TABLE IF NOT EXISTS email_verifications (
  id SERIAL PRIMARY KEY,
  user_id UUID,
  code VARCHAR,
  expires_at TIMESTAMP NOT NULL,
  token VARCHAR
);

ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS code VARCHAR;
ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS token VARCHAR;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verifications_token_key'
  ) THEN
    ALTER TABLE email_verifications
      ADD CONSTRAINT email_verifications_token_key
      UNIQUE (token);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verifications_user_id_fkey'
  ) THEN
    ALTER TABLE email_verifications
      ADD CONSTRAINT email_verifications_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_token
  ON email_verifications (token);

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address INET,
  device_fingerprint VARCHAR
);

ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS token TEXT;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'password_resets_user_id_fkey'
  ) THEN
    ALTER TABLE password_resets
      ADD CONSTRAINT password_resets_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id UUID,
  token_hash VARCHAR,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  ip_address VARCHAR,
  user_agent TEXT,
  device_id VARCHAR,
  device_name VARCHAR,
  device_type VARCHAR,
  last_used_at TIMESTAMP DEFAULT NOW(),
  is_revoked BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMP,
  revoked_by UUID,
  jti UUID NOT NULL
);

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address VARCHAR;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id VARCHAR;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_name VARCHAR;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_type VARCHAR;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP DEFAULT NOW();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS is_revoked BOOLEAN DEFAULT FALSE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_by UUID;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS jti UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_revoked_by_fkey'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_revoked_by_fkey
      FOREIGN KEY (revoked_by) REFERENCES users(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_jti_key'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_jti_key
      UNIQUE (jti);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_device'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT unique_user_device
      UNIQUE (user_id, device_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
  ON refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash
  ON refresh_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON refresh_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id
  ON refresh_tokens (device_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_used
  ON refresh_tokens (last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked
  ON refresh_tokens (is_revoked)
  WHERE is_revoked = TRUE;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti
  ON refresh_tokens (jti);

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_user_device
  ON refresh_tokens (user_id, device_id)
  WHERE is_revoked = FALSE;

CREATE TABLE IF NOT EXISTS user_2fa (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  method VARCHAR NOT NULL,
  totp_secret VARCHAR,
  is_enabled BOOLEAN DEFAULT FALSE,
  enabled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS method VARCHAR;
ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS totp_secret VARCHAR;
ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS enabled_at TIMESTAMP;
ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_2fa_user_id_fkey'
  ) THEN
    ALTER TABLE user_2fa
      ADD CONSTRAINT user_2fa_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_method'
  ) THEN
    ALTER TABLE user_2fa
      ADD CONSTRAINT unique_user_method
      UNIQUE (user_id, method);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_2fa_backup_codes (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  code_hash VARCHAR NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE user_2fa_backup_codes ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_2fa_backup_codes ADD COLUMN IF NOT EXISTS code_hash VARCHAR;
ALTER TABLE user_2fa_backup_codes ADD COLUMN IF NOT EXISTS is_used BOOLEAN DEFAULT FALSE;
ALTER TABLE user_2fa_backup_codes ADD COLUMN IF NOT EXISTS used_at TIMESTAMP;
ALTER TABLE user_2fa_backup_codes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_2fa_backup_codes_user_id_fkey'
  ) THEN
    ALTER TABLE user_2fa_backup_codes
      ADD CONSTRAINT user_2fa_backup_codes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ip_security_logs (
  id SERIAL PRIMARY KEY,
  ip_address INET NOT NULL,
  action VARCHAR NOT NULL,
  user_id UUID,
  user_agent TEXT,
  device_fingerprint VARCHAR,
  path VARCHAR,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS action VARCHAR;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS path VARCHAR;
ALTER TABLE ip_security_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ip_security_logs_user_id_fkey'
  ) THEN
    ALTER TABLE ip_security_logs
      ADD CONSTRAINT ip_security_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ip_security_logs_ip
  ON ip_security_logs (ip_address);

CREATE INDEX IF NOT EXISTS idx_ip_security_logs_action
  ON ip_security_logs (action);

CREATE INDEX IF NOT EXISTS idx_ip_security_logs_created_at
  ON ip_security_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_ip_security_logs_fingerprint
  ON ip_security_logs (device_fingerprint);

CREATE TABLE IF NOT EXISTS trust_scores (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR NOT NULL,
  ip_address VARCHAR,
  trust_score NUMERIC DEFAULT 0.50,
  successful_logins INTEGER DEFAULT 0,
  failed_logins INTEGER DEFAULT 0,
  captchas_passed INTEGER DEFAULT 0,
  captchas_failed INTEGER DEFAULT 0,
  last_seen_at TIMESTAMP DEFAULT NOW(),
  first_seen_at TIMESTAMP DEFAULT NOW(),
  accounts_created INTEGER DEFAULT 0,
  last_account_created_at TIMESTAMP
);

ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS device_id VARCHAR;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS ip_address VARCHAR;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS trust_score NUMERIC DEFAULT 0.50;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS successful_logins INTEGER DEFAULT 0;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS failed_logins INTEGER DEFAULT 0;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS captchas_passed INTEGER DEFAULT 0;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS captchas_failed INTEGER DEFAULT 0;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP DEFAULT NOW();
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS accounts_created INTEGER DEFAULT 0;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS last_account_created_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_device'
  ) THEN
    ALTER TABLE trust_scores
      ADD CONSTRAINT unique_device
      UNIQUE (device_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trust_device
  ON trust_scores (device_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY,
  theme VARCHAR NOT NULL DEFAULT 'void',
  accent_color VARCHAR NOT NULL DEFAULT '#6366f1',
  bg_color VARCHAR NOT NULL DEFAULT '#111827',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  text_color VARCHAR NOT NULL DEFAULT '#f3f4f6',
  hover_color VARCHAR NOT NULL DEFAULT '#374151',
  density VARCHAR DEFAULT 'compact',
  message_group_spacing INTEGER DEFAULT 8,
  chat_font_scale INTEGER DEFAULT 16
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS theme VARCHAR NOT NULL DEFAULT 'void';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS accent_color VARCHAR NOT NULL DEFAULT '#6366f1';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS bg_color VARCHAR NOT NULL DEFAULT '#111827';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS text_color VARCHAR NOT NULL DEFAULT '#f3f4f6';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS hover_color VARCHAR NOT NULL DEFAULT '#374151';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS density VARCHAR DEFAULT 'compact';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS message_group_spacing INTEGER DEFAULT 8;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS chat_font_scale INTEGER DEFAULT 16;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_user_id_fkey'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_message_group_spacing_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_message_group_spacing_check
      CHECK (message_group_spacing = ANY (ARRAY[0, 4, 8, 16, 24]));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_chat_font_scale_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_chat_font_scale_check
      CHECK (chat_font_scale = ANY (ARRAY[12, 14, 15, 16, 18, 20, 24]));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  public_key TEXT NOT NULL,
  key_id VARCHAR NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS key_id VARCHAR;
ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_keys_user_id_fkey'
  ) THEN
    ALTER TABLE user_keys
      ADD CONSTRAINT user_keys_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_keys_user
  ON user_keys (user_id, is_active);

CREATE TABLE IF NOT EXISTS user_key_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  recovery_encrypted_private_key TEXT,
  recovery_iv TEXT,
  recovery_salt TEXT,
  recovery_key_id TEXT,
  recovery_configured_at TIMESTAMPTZ,
  mls_state_encrypted TEXT,
  mls_state_iv TEXT,
  mls_state_salt TEXT
);

ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS iv TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS salt TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS recovery_encrypted_private_key TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS recovery_iv TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS recovery_salt TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS recovery_key_id TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS recovery_configured_at TIMESTAMPTZ;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS mls_state_encrypted TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS mls_state_iv TEXT;
ALTER TABLE user_key_backups ADD COLUMN IF NOT EXISTS mls_state_salt TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_key_backups_user_id_fkey'
  ) THEN
    ALTER TABLE user_key_backups
      ADD CONSTRAINT user_key_backups_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_key_backups_user_id_key'
  ) THEN
    ALTER TABLE user_key_backups
      ADD CONSTRAINT user_key_backups_user_id_key
      UNIQUE (user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_key_backups_user
  ON user_key_backups (user_id);
