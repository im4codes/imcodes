-- Temporary challenge storage for WebAuthn passkey flows (multi-instance safe)
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  user_id     TEXT,               -- NULL = new user registration flow
  display_name TEXT NOT NULL DEFAULT '',
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pc_expires ON passkey_challenges(expires_at);
