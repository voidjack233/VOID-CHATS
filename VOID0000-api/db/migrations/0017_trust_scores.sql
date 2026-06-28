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
