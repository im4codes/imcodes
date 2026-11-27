-- Encrypt user alias sensitive payloads (value, description) at rest.
-- encryption_version = 0: legacy plaintext row (pending startup migration)
-- encryption_version = 1: AES-256-GCM encrypted with BOT_ENCRYPTION_KEY + user_id/field AAD

ALTER TABLE user_aliases ADD COLUMN IF NOT EXISTS encryption_version SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_aliases_unencrypted
  ON user_aliases (id)
  WHERE encryption_version = 0;
