-- Controlled nodes: passive machines that can ONLY be controlled and return
-- data. Role is enforced authoritatively on the server credential; a controlled
-- credential is rejected by every control API. Existing servers become 'full'.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS node_role TEXT NOT NULL DEFAULT 'full'
  CHECK (node_role IN ('full', 'controlled'));

-- One-time, short-TTL enrollment codes minted for a pre-paired controlled-node
-- executable. Redeeming one creates a 'controlled' server row and burns the code.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_key_id TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  used_at BIGINT,
  redeemed_server_id TEXT REFERENCES servers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_user ON enrollment_codes(user_id);
