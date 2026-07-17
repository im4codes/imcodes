-- Permanent, multi-use controlled-node installers.
--
-- The five-minute download ticket remains on controlled_node_enrollments_v2,
-- but newly minted package identities no longer expire after download and one
-- package may create multiple independently credentialed controlled nodes.
-- Legacy rows retain reusable=FALSE and therefore keep their original
-- single-use + expires_at behavior.

ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS reusable BOOLEAN NOT NULL DEFAULT FALSE;

-- Reusable rows use NULL to mean no enrollment expiry.  Existing rows retain
-- their timestamp and are never silently revived by this migration.
ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN expires_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS controlled_node_enrollment_installs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id        UUID NOT NULL REFERENCES controlled_node_enrollments_v2(id) ON DELETE CASCADE,
  install_id           TEXT NOT NULL,
  node_token_hash      TEXT NOT NULL,
  redeemed_server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at           BIGINT NOT NULL,
  CONSTRAINT controlled_node_enrollment_installs_identity_unique
    UNIQUE (enrollment_id, install_id),
  CONSTRAINT controlled_node_enrollment_installs_token_unique
    UNIQUE (enrollment_id, node_token_hash),
  CONSTRAINT controlled_node_enrollment_installs_server_unique
    UNIQUE (redeemed_server_id)
);

-- Preserve idempotent replay for already-claimed legacy rows.  Parent identity
-- columns remain in place for compatibility and can be removed only in a
-- separately audited migration after every deployment has passed 059.
INSERT INTO controlled_node_enrollment_installs
  (enrollment_id, install_id, node_token_hash, redeemed_server_id, created_at)
SELECT id, install_id, node_token_hash, redeemed_server_id, used_at
  FROM controlled_node_enrollments_v2
 WHERE used_at IS NOT NULL
   AND install_id IS NOT NULL
   AND node_token_hash IS NOT NULL
   AND redeemed_server_id IS NOT NULL
ON CONFLICT (enrollment_id, install_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_controlled_node_enrollment_installs_enrollment
  ON controlled_node_enrollment_installs(enrollment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_enrollments_v2_reusable_active
  ON controlled_node_enrollments_v2(owner_user_id, created_at)
  WHERE reusable = TRUE AND revoked_at IS NULL;

COMMENT ON COLUMN controlled_node_enrollments_v2.reusable IS
  'TRUE for permanent multi-use installer identities; FALSE preserves legacy single-use expiry behavior.';
COMMENT ON TABLE controlled_node_enrollment_installs IS
  'Per-machine idempotency and credential binding for controlled-node installer redemption.';
