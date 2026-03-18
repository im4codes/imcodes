-- Security tables migration
-- Deploy: wrangler d1 execute <database-name> --file migrations/0003_security.sql

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,          -- SHA-256 hash of the actual API key
  label TEXT,
  revoked_at INTEGER,              -- epoch ms; null = active
  grace_expires_at INTEGER,        -- epoch ms; used during rotation grace period
  created_at INTEGER NOT NULL,
  UNIQUE(key_hash)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,        -- SHA-256 hash of the refresh token
  family_id TEXT NOT NULL,         -- family reuse detection: compromised family → revoke all
  used_at INTEGER,                 -- null = still active, set = consumed (rotation happened)
  expires_at INTEGER NOT NULL,     -- epoch ms
  created_at INTEGER NOT NULL,
  UNIQUE(token_hash)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,            -- Idempotency-Key header value (max 128 chars)
  user_id TEXT NOT NULL REFERENCES users(id),
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL      -- entries older than 24h cleaned up by scheduled cron
);

CREATE TABLE IF NOT EXISTS auth_lockouts (
  identity TEXT PRIMARY KEY,       -- user_id or IP address
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,            -- epoch ms; null = not locked
  last_attempt_at INTEGER NOT NULL
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_user_id ON idempotency_records(user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at ON idempotency_records(created_at);
