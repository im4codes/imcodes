-- Remote processed shared-context storage.
-- Projections are the primary replicated artifact from daemon-local materialization.
-- Durable candidate records mirror durable-memory candidates for later promotion.
-- Embeddings table is reserved for pgvector-backed retrieval in later phases.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS shared_context_projections (
  id                    TEXT PRIMARY KEY,
  server_id             TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  scope                 TEXT NOT NULL,
  enterprise_id         TEXT REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id          TEXT REFERENCES shared_context_workspaces(id) ON DELETE SET NULL,
  user_id               TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id            TEXT NOT NULL,
  projection_class      TEXT NOT NULL,
  source_event_ids_json JSONB NOT NULL,
  summary               TEXT NOT NULL,
  content_json          JSONB NOT NULL,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  replicated_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_context_projections_namespace
  ON shared_context_projections(scope, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_context_projections_server
  ON shared_context_projections(server_id, replicated_at DESC);

CREATE TABLE IF NOT EXISTS shared_context_records (
  id             TEXT PRIMARY KEY,
  projection_id  TEXT NOT NULL UNIQUE REFERENCES shared_context_projections(id) ON DELETE CASCADE,
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  enterprise_id  TEXT REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id   TEXT REFERENCES shared_context_workspaces(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id     TEXT NOT NULL,
  record_class   TEXT NOT NULL,
  summary        TEXT NOT NULL,
  content_json   JSONB NOT NULL,
  status         TEXT NOT NULL,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_context_records_namespace
  ON shared_context_records(scope, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS shared_context_embeddings (
  id              TEXT PRIMARY KEY,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding       vector(1536),
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_context_embeddings_source
  ON shared_context_embeddings(source_kind, source_id);
