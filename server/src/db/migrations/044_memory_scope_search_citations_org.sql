-- Post-1.1 memory scope/search/citation/org-authored server foundations.

CREATE TABLE IF NOT EXISTS owner_private_memories (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL DEFAULT 'user_private',
  kind              TEXT NOT NULL,
  origin            TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  text              TEXT NOT NULL,
  content_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   TEXT NOT NULL,
  source_server_id  TEXT REFERENCES servers(id) ON DELETE SET NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  replicated_at     BIGINT NOT NULL,
  CONSTRAINT owner_private_memories_scope_check CHECK (scope = 'user_private')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_private_memories_idempotency
  ON owner_private_memories(owner_user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_owner_private_memories_owner_updated
  ON owner_private_memories(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS shared_context_citations (
  id                       TEXT PRIMARY KEY,
  projection_id            TEXT NOT NULL REFERENCES shared_context_projections(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  citing_message_id        TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL UNIQUE,
  projection_content_hash  TEXT NOT NULL,
  created_at               BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_context_citations_projection
  ON shared_context_citations(projection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shared_context_projection_cite_counts (
  projection_id TEXT PRIMARY KEY REFERENCES shared_context_projections(id) ON DELETE CASCADE,
  cite_count    INTEGER NOT NULL DEFAULT 0,
  updated_at    BIGINT NOT NULL
);

ALTER TABLE shared_context_projections
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_context_projections_scope_no_user_private'
  ) THEN
    ALTER TABLE shared_context_projections
      ADD CONSTRAINT shared_context_projections_scope_no_user_private
      CHECK (scope IN ('personal', 'project_shared', 'workspace_shared', 'org_shared')) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_shared_context_document_bindings_runtime_specificity
  ON shared_context_document_bindings(
    enterprise_id,
    status,
    (CASE WHEN enrollment_id IS NOT NULL THEN 1 WHEN workspace_id IS NOT NULL THEN 2 ELSE 3 END),
    binding_mode,
    id
  );

-- Nullable/backfillable metadata for post-1.1 fingerprint/origin parity.
ALTER TABLE shared_context_projections
  ADD COLUMN IF NOT EXISTS summary_fingerprint TEXT;

ALTER TABLE shared_context_projections
  ADD COLUMN IF NOT EXISTS origin TEXT;

ALTER TABLE shared_context_records
  ADD COLUMN IF NOT EXISTS summary_fingerprint TEXT;

ALTER TABLE shared_context_records
  ADD COLUMN IF NOT EXISTS origin TEXT;

CREATE INDEX IF NOT EXISTS idx_shared_context_projections_fingerprint
  ON shared_context_projections(scope, project_id, projection_class, summary_fingerprint)
  WHERE summary_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shared_context_records_fingerprint
  ON shared_context_records(scope, project_id, record_class, summary_fingerprint)
  WHERE summary_fingerprint IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_context_projections_origin_check'
  ) THEN
    ALTER TABLE shared_context_projections
      ADD CONSTRAINT shared_context_projections_origin_check
      CHECK (origin IS NULL OR origin IN ('chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_context_records_origin_check'
  ) THEN
    ALTER TABLE shared_context_records
      ADD CONSTRAINT shared_context_records_origin_check
      CHECK (origin IS NULL OR origin IN ('chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest')) NOT VALID;
  END IF;
END
$$;

-- Server-side typed namespace/observation parity with daemon SQLite tables.
CREATE TABLE IF NOT EXISTS memory_context_namespaces (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  scope           TEXT NOT NULL,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  root_session_id TEXT,
  session_tree_id TEXT,
  session_id      TEXT,
  workspace_id    TEXT REFERENCES shared_context_workspaces(id) ON DELETE SET NULL,
  project_id      TEXT,
  org_id          TEXT REFERENCES teams(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  visibility      TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  CONSTRAINT memory_context_namespaces_scope_check CHECK (scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_context_namespaces_tenant_scope_key
  ON memory_context_namespaces(tenant_id, scope, key);

CREATE INDEX IF NOT EXISTS idx_memory_context_namespaces_lookup
  ON memory_context_namespaces(tenant_id, scope, user_id, project_id, workspace_id, org_id);

CREATE INDEX IF NOT EXISTS idx_memory_context_namespaces_session_tree
  ON memory_context_namespaces(root_session_id, session_tree_id, session_id);

CREATE TABLE IF NOT EXISTS memory_context_observations (
  id                    TEXT PRIMARY KEY,
  namespace_id          TEXT NOT NULL REFERENCES memory_context_namespaces(id) ON DELETE CASCADE,
  scope                 TEXT NOT NULL,
  class                 TEXT NOT NULL,
  origin                TEXT NOT NULL,
  fingerprint           TEXT NOT NULL,
  content_json          JSONB NOT NULL,
  text_hash             TEXT NOT NULL,
  source_event_ids_json JSONB NOT NULL,
  projection_id         TEXT REFERENCES shared_context_projections(id) ON DELETE SET NULL,
  state                 TEXT NOT NULL,
  confidence            DOUBLE PRECISION,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  promoted_at           BIGINT,
  CONSTRAINT memory_context_observations_scope_check CHECK (scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared')),
  CONSTRAINT memory_context_observations_class_check CHECK (class IN ('fact', 'decision', 'bugfix', 'feature', 'refactor', 'discovery', 'preference', 'skill_candidate', 'workflow', 'code_pattern', 'note')),
  CONSTRAINT memory_context_observations_origin_check CHECK (origin IN ('chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_context_observations_idempotency
  ON memory_context_observations(namespace_id, class, fingerprint, text_hash);

CREATE INDEX IF NOT EXISTS idx_memory_context_observations_projection
  ON memory_context_observations(projection_id);

CREATE INDEX IF NOT EXISTS idx_memory_context_observations_scope_state
  ON memory_context_observations(scope, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_observation_promotion_audit (
  id             TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES memory_context_observations(id) ON DELETE CASCADE,
  actor_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action         TEXT NOT NULL,
  from_scope     TEXT NOT NULL,
  to_scope       TEXT NOT NULL,
  reason         TEXT,
  created_at     BIGINT NOT NULL,
  CONSTRAINT memory_observation_promotion_audit_action_check CHECK (action IN ('web_ui_promote', 'cli_mem_promote', 'admin_api_promote')),
  CONSTRAINT memory_observation_promotion_audit_from_scope_check CHECK (from_scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared')),
  CONSTRAINT memory_observation_promotion_audit_to_scope_check CHECK (to_scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared'))
);

CREATE INDEX IF NOT EXISTS idx_memory_observation_promotion_audit_observation
  ON memory_observation_promotion_audit(observation_id, created_at);
