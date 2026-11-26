-- Controlled-node hardening (audit D-A / D-E / revocation / ref identity).
-- Additive follow-up to 050 (which already shipped with the raw enrollment code
-- and no exec/revoke/ref columns). Forward-only; existing rows keep defaults.

-- D-E: a controlled node is not executable until its owner enables it.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS exec_enabled BOOLEAN NOT NULL DEFAULT false;
-- Owner revocation / kill-switch (epoch ms; NULL = active).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS revoked_at BIGINT;
-- Server-derived machine reference identity.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS ref_name TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS display_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_user_ref_name
  ON servers(user_id, ref_name) WHERE ref_name IS NOT NULL;

-- D-A: recoverable, hashed-at-rest, idempotent enrollment.
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS install_id TEXT;
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS node_token_hash TEXT;
ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS burn_failed_at BIGINT;
-- Backfill code_hash for any pre-existing rows so the column can carry the hash
-- going forward (legacy raw `code` remains the PK; new writes populate code_hash).
UPDATE enrollment_codes SET code_hash = encode(sha256(code::bytea), 'hex')
  WHERE code_hash IS NULL;
-- Idempotent redemption key: at most one controlled server per (code_hash, install_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_codes_code_install
  ON enrollment_codes(code_hash, install_id) WHERE install_id IS NOT NULL;
