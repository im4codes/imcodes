-- AI-managed MCP and Skills: owner-scoped identities and immutable versions.
-- Capability package bytes live in private content-addressed storage; these
-- tables contain only bounded metadata, non-secret definitions, and digests.

CREATE TABLE IF NOT EXISTS capability_items (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('skill', 'mcp')),
  name              TEXT NOT NULL,
  lifecycle_state   TEXT NOT NULL CHECK (lifecycle_state IN (
    'pending', 'active', 'disabled', 'runtime_pending', 'tombstoned', 'removed', 'degraded'
  )),
  active_version_id TEXT,
  revision          BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  tombstoned_at     BIGINT,
  removed_at        BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  UNIQUE (owner_user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_capability_items_owner_updated
  ON capability_items(owner_user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_capability_items_owner_name
  ON capability_items(owner_user_id, lower(name), id);

CREATE TABLE IF NOT EXISTS capability_versions (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  version_number     INTEGER NOT NULL CHECK (version_number > 0),
  artifact_digest   TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  blob_digest       TEXT CHECK (blob_digest ~ '^[0-9a-f]{64}$'),
  blob_byte_size    BIGINT CHECK (blob_byte_size > 0 AND blob_byte_size <= 16777216),
  audit_digest      TEXT NOT NULL CHECK (audit_digest ~ '^[0-9a-f]{64}$'),
  source_kind       TEXT NOT NULL,
  source_summary    TEXT NOT NULL DEFAULT '',
  manifest          JSONB NOT NULL DEFAULT '{}'::jsonb,
  definition        JSONB,
  permission_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  publication_state TEXT NOT NULL DEFAULT 'active' CHECK (publication_state IN (
    'pending', 'active', 'failed'
  )),
  created_at        BIGINT NOT NULL,
  UNIQUE (item_id, version_number),
  UNIQUE (item_id, artifact_digest),
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, item_id, id),
  CHECK ((blob_digest IS NULL) = (blob_byte_size IS NULL)),
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE
);

ALTER TABLE capability_items
  ADD CONSTRAINT capability_items_active_version_fk
  FOREIGN KEY (owner_user_id, id, active_version_id)
  REFERENCES capability_versions(owner_user_id, item_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_capability_versions_owner_item
  ON capability_versions(owner_user_id, item_id, version_number DESC);
