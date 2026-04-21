-- Enable pgvector extension (requires pgvector/pgvector Docker image).
-- Default compose/template image is pgvector/pgvector:pg18 (not postgres:16-alpine).
CREATE EXTENSION IF NOT EXISTS vector;

-- Migration 038 created shared_context_embeddings with either vector(1536) or JSONB fallback.
-- Now that pgvector is required:
-- 1. Drop the old table (it was unused — no data to preserve)
-- 2. Recreate with correct 384-dimension vector column + HNSW index
DROP TABLE IF EXISTS shared_context_embeddings;

CREATE TABLE shared_context_embeddings (
  id              TEXT PRIMARY KEY,
  source_kind     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding       vector(384) NOT NULL,
  created_at      BIGINT NOT NULL
);

CREATE INDEX idx_shared_context_embeddings_source
  ON shared_context_embeddings(source_kind, source_id);

-- HNSW index for fast approximate nearest neighbor search.
-- cosine distance operator: <=> (requires vector_cosine_ops)
CREATE INDEX idx_shared_context_embeddings_hnsw
  ON shared_context_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
