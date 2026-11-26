-- Account revision is the monotonic synchronization cursor. Readiness remains
-- machine-specific and never changes account authority.

CREATE TABLE IF NOT EXISTS capability_account_revisions (
  owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision      BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_machine_readiness (
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  server_id          TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  readiness_state    TEXT NOT NULL CHECK (readiness_state IN (
    'ready', 'runtime_pending', 'content_missing', 'integrity_failed',
    'dependency_missing', 'provider_unsupported', 'machine_offline'
  )),
  reason_code        TEXT,
  account_revision   BIGINT NOT NULL CHECK (account_revision >= 0),
  manifest_digest    TEXT,
  acknowledged_at    BIGINT NOT NULL,
  PRIMARY KEY (owner_user_id, item_id, server_id),
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capability_readiness_owner_server
  ON capability_machine_readiness(owner_user_id, server_id, acknowledged_at DESC);

CREATE TABLE IF NOT EXISTS capability_blobs (
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest          TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key      TEXT NOT NULL UNIQUE,
  byte_size       BIGINT NOT NULL CHECK (byte_size >= 0),
  storage_state   TEXT NOT NULL CHECK (storage_state IN ('pending', 'ready', 'failed', 'deleted')),
  content         BYTEA,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  CHECK (storage_state <> 'ready' OR (
    content IS NOT NULL AND octet_length(content) = byte_size
  )),
  PRIMARY KEY (owner_user_id, digest)
);

CREATE TABLE IF NOT EXISTS capability_blob_tokens (
  jti            TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  capability_id  TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('upload', 'download')),
  blob_digest    TEXT NOT NULL CHECK (blob_digest ~ '^[0-9a-f]{64}$'),
  expires_at     BIGINT NOT NULL,
  consumed_at    BIGINT,
  created_at     BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id, capability_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, version_id)
    REFERENCES capability_versions(owner_user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capability_blob_tokens_expiry
  ON capability_blob_tokens(expires_at);

CREATE TABLE IF NOT EXISTS capability_tombstones (
  id               TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id           TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('account', 'project', 'session', 'local')),
  server_id         TEXT REFERENCES servers(id) ON DELETE CASCADE,
  account_revision  BIGINT NOT NULL CHECK (account_revision >= 0),
  expires_at        BIGINT NOT NULL,
  created_at        BIGINT NOT NULL,
  UNIQUE NULLS NOT DISTINCT (owner_user_id, item_id, scope, server_id),
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capability_tombstones_owner_revision
  ON capability_tombstones(owner_user_id, account_revision, id);

-- A synchronized Skill is only a candidate until its exact reviewed archive
-- has reached private content storage. Keeping desired binding authority here
-- prevents ACTIVATE from switching an existing item before blob integrity is
-- proven. Local Skills and MCP definitions never enter this table.
CREATE TABLE IF NOT EXISTS capability_pending_activations (
  operation_id    TEXT PRIMARY KEY REFERENCES capability_operations(id) ON DELETE CASCADE,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  version_id       TEXT NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  binding_id       TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('account', 'project', 'session', 'local')),
  project_key      TEXT,
  session_key      TEXT,
  server_id        TEXT REFERENCES servers(id) ON DELETE CASCADE,
  provider_filter  JSONB NOT NULL DEFAULT '[]'::jsonb,
  machine_filter   JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorization_envelope JSONB,
  authority_item_revision BIGINT NOT NULL CHECK (authority_item_revision > 0),
  authority_binding_revision BIGINT NOT NULL CHECK (authority_binding_revision > 0),
  blob_ready       BOOLEAN NOT NULL,
  created_item     BOOLEAN NOT NULL,
  introduces_synchronized_item BOOLEAN NOT NULL,
  created_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  UNIQUE (owner_user_id, item_id, version_id),
  FOREIGN KEY (owner_user_id, operation_id)
    REFERENCES capability_operations(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id, version_id)
    REFERENCES capability_versions(owner_user_id, item_id, id) ON DELETE CASCADE,
  CHECK (
    (scope = 'account' AND project_key IS NULL AND session_key IS NULL AND server_id IS NULL)
    OR (scope = 'project' AND project_key IS NOT NULL AND session_key IS NULL AND server_id IS NULL)
    OR (scope = 'session' AND session_key IS NOT NULL AND server_id IS NULL)
    OR (scope = 'local' AND project_key IS NULL AND session_key IS NULL AND server_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_capability_pending_blob
  ON capability_pending_activations(owner_user_id, version_id);

CREATE INDEX IF NOT EXISTS idx_capability_pending_expiry
  ON capability_pending_activations(expires_at, owner_user_id);

-- Durable receipt for daemon COMMIT_RESULT. The daemon keeps its result in an
-- outbox until the matching COMMIT_ACK arrives; retaining this receipt makes a
-- replay idempotent after the pending candidate has been consumed.
CREATE TABLE IF NOT EXISTS capability_install_commits (
  operation_id      TEXT PRIMARY KEY REFERENCES capability_operations(id) ON DELETE CASCADE,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  item_id           TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  version_id        TEXT NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  binding_id        TEXT NOT NULL REFERENCES capability_bindings(id) ON DELETE CASCADE,
  operation_revision BIGINT NOT NULL CHECK (operation_revision > 0),
  item_revision     BIGINT NOT NULL CHECK (item_revision > 0),
  account_revision  BIGINT NOT NULL CHECK (account_revision >= 0),
  synchronized      BOOLEAN NOT NULL,
  committed_at      BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id, operation_id)
    REFERENCES capability_operations(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id, version_id)
    REFERENCES capability_versions(owner_user_id, item_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id, binding_id)
    REFERENCES capability_bindings(owner_user_id, item_id, id) ON DELETE CASCADE
);

-- Durable two-phase journal for exact local-scope mutations. Socket delivery
-- never advances authority: PREPARE, COMMIT/APPLIED, the DB commit and final
-- ACK are individually replayable after worker/pod/daemon failure.
CREATE TABLE IF NOT EXISTS capability_local_manage_requests (
  request_id       TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id           TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  binding_id        TEXT NOT NULL REFERENCES capability_bindings(id) ON DELETE CASCADE,
  server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  action            TEXT NOT NULL CHECK (action IN ('enable', 'disable', 'rollback', 'uninstall', 'restore')),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  authority_revision BIGINT NOT NULL CHECK (authority_revision > 0),
  target_version_id TEXT,
  authorization_envelope JSONB,
  phase             TEXT NOT NULL CHECK (phase IN (
    'prepare_sent', 'prepared', 'commit_sent', 'applied', 'committed', 'aborted'
  )),
  result_error_code TEXT,
  result_item_revision BIGINT,
  result_account_revision BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id, binding_id)
    REFERENCES capability_bindings(owner_user_id, item_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_local_manage_active_binding
  ON capability_local_manage_requests(owner_user_id, binding_id)
  WHERE phase NOT IN ('committed', 'aborted');

CREATE INDEX IF NOT EXISTS idx_capability_local_manage_replay
  ON capability_local_manage_requests(owner_user_id, server_id, phase, updated_at);
