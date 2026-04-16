-- Enable pg_trgm for fuzzy/similarity text search on memory summaries
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on summary column for fast similarity search
CREATE INDEX IF NOT EXISTS idx_shared_context_projections_summary_trgm
  ON shared_context_projections USING gin (summary gin_trgm_ops);
