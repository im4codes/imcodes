-- Additive: old modern peers and their four-key stable-link ON CONFLICT remain valid.
-- Stable Linux links/auto-detected install commands can bind a verified second ABI
-- digest without changing CPU identity or enrollment authority.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS abi_profile TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE controlled_node_enrollments_v2 ADD COLUMN IF NOT EXISTS abi_profile TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE controlled_node_enrollments_v2 ADD COLUMN IF NOT EXISTS abi_variants JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Keep the original modern table/PK intact: an older server's ON CONFLICT
-- (os, arch) must still work during a rolling upgrade. Explicit ABI variants
-- have their own three-key descriptor table.
CREATE TABLE IF NOT EXISTS controlled_node_artifact_variants (
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  abi_profile TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (os, arch, abi_profile)
);
