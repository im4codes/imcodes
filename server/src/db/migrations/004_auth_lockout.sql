-- Auth lockout table: tracks failed auth attempts per IP/identity.
-- Replaces in-memory MemoryRateLimiter for multi-instance deployments.

CREATE TABLE IF NOT EXISTS auth_lockout (
  identity      TEXT PRIMARY KEY,
  fail_count    INT NOT NULL DEFAULT 0,
  first_fail_at TIMESTAMPTZ,
  locked_until  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_lockout_locked
  ON auth_lockout (locked_until)
  WHERE locked_until IS NOT NULL;
