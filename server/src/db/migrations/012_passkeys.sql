-- Passkey (WebAuthn) credentials storage
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id           TEXT PRIMARY KEY,        -- credential ID (base64url, from authenticator)
  user_id      TEXT NOT NULL REFERENCES users(id),
  public_key   TEXT NOT NULL,           -- COSE public key, stored as base64
  counter      INTEGER NOT NULL DEFAULT 0,
  device_name  TEXT,                    -- optional friendly label set by user
  transports   TEXT,                    -- JSON array of AuthenticatorTransport strings
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id);
