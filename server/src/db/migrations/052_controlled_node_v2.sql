-- Controlled-node v2 enrollment: a SEPARATE hash-only table (audit E1 fix).
-- This migration leaves the historical `enrollment_codes` table in place only
-- until migration 054 retires it in the same unreleased v2 rollout. v2 NEVER
-- writes to that raw-code table.
--
-- The single v2 table `controlled_node_enrollments_v2` carries both the
-- enrollment identity (code_hash) and the per-download ticket state
-- (consumed_count/max_consumes). At mint we insert with used_at=NULL and
-- install_id/node_token_hash=NULL. At redeem we atomically bind identity
-- AND mark used_at in one UPDATE.

CREATE TABLE IF NOT EXISTS controlled_node_enrollments_v2 (
  -- surrogate primary key (v2 NEVER relies on a legacy raw code PK)
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- download ticket bearer hash (separate from code_hash; bearer ≠ enrollment
  -- code so leaking a bearer token does not directly leak the redeemable code)
  ticket_hash          TEXT NOT NULL UNIQUE,
  -- hash-only redemption identity (the SOLE identity for v2)
  code_hash            TEXT NOT NULL UNIQUE,
  -- ticket / download state
  owner_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  os                   TEXT NOT NULL,
  arch                 TEXT NOT NULL,
  -- artifact metadata locked at mint time so retries return byte-identical bytes
  artifact_sha256      TEXT NOT NULL,
  -- the actual enrollment code, encrypted at rest; never returned in raw form
  encrypted_code       TEXT NOT NULL,
  -- bounded retries for downloads (browsers may retry / resume)
  consumed_count       INTEGER NOT NULL DEFAULT 0,
  max_consumes         INTEGER NOT NULL DEFAULT 3,
  consumed_at          BIGINT,
  revoked_at           BIGINT,
  last_consume_ip      TEXT,
  ticket_expires_at    BIGINT NOT NULL,
  -- enrollment lifecycle
  expires_at           BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  -- redeemed state — all NULL until atomic claim at redeem time
  used_at              BIGINT,
  redeemed_server_id   TEXT REFERENCES servers(id) ON DELETE SET NULL,
  install_id           TEXT,
  node_token_hash      TEXT,
  -- constraint: install_id + node_token_hash must both be present or both NULL
  -- (set together at atomic claim, never half-bound)
  CONSTRAINT enrollments_v2_identity_check CHECK (
    (install_id IS NULL AND node_token_hash IS NULL)
    OR
    (install_id IS NOT NULL AND node_token_hash IS NOT NULL)
  ),
  -- constraint: if redeemed, must carry a server id
  CONSTRAINT enrollments_v2_redeem_consistency CHECK (
    (used_at IS NULL AND redeemed_server_id IS NULL)
    OR
    (used_at IS NOT NULL AND redeemed_server_id IS NOT NULL)
  )
);

-- For older deployments that may have run a partial 052 before ticket_hash
-- was added: idempotent column add (CREATE TABLE IF NOT EXISTS skips the
-- definition on existing tables).
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS ticket_hash TEXT;
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS ticket_expires_at BIGINT;
UPDATE controlled_node_enrollments_v2
  SET ticket_expires_at = expires_at
  WHERE ticket_expires_at IS NULL;
ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN ticket_expires_at SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'controlled_node_enrollments_v2_ticket_hash_unique'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'controlled_node_enrollments_v2' AND column_name = 'ticket_hash'
  ) THEN
    ALTER TABLE controlled_node_enrollments_v2
      ADD CONSTRAINT controlled_node_enrollments_v2_ticket_hash_unique UNIQUE (ticket_hash);
  END IF;
END $$;

-- Indexes for the three hot paths:
--   - mint (no common lookup; relies on PK)
--   - redeem by code_hash (UNIQUE index already created above)
--   - ticket download by code_hash (also covered by UNIQUE index)
--   - retention sweep by expires_at
CREATE INDEX IF NOT EXISTS idx_enrollments_v2_expires_at
  ON controlled_node_enrollments_v2(expires_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_v2_ticket_expires_at
  ON controlled_node_enrollments_v2(ticket_expires_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_v2_owner_expires
  ON controlled_node_enrollments_v2(owner_user_id, expires_at);

-- Artifact manifests table: cached only after the server validates a strict
-- build-pipeline sidecar against the current regular-file bytes. Filename-only
-- or server-computed artifacts are never advertised by the v2 path.
CREATE TABLE IF NOT EXISTS controlled_node_artifact_manifests (
  os             TEXT NOT NULL,
  arch           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  source         TEXT NOT NULL,  -- 'manifest_json'
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (os, arch)
);

-- Documentation: v2 writes only to controlled_node_enrollments_v2. Migration
-- 054 drops the never-production-released raw-code table before this feature's
-- first authorized rollout.
COMMENT ON TABLE controlled_node_enrollments_v2 IS
  'v2 hash-only enrollment + download ticket state. Replaces legacy raw-code PK. Sole redemption identity = code_hash.';

-- ── Add os/arch metadata to servers table for v2 controlled nodes ──────────
-- Existing full-daemon rows leave these NULL; v2 controlled rows populate them
-- at redemption time.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS arch TEXT;
