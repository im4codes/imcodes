-- Daemons own identity bytes. The metadata projection is safe to replicate
-- and is sufficient for hash/revision convergence without storing prompts.
CREATE TABLE IF NOT EXISTS session_identity_metadata (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mcp',
  source_file TEXT,
  PRIMARY KEY (user_id, scope, scope_key),
  CHECK (scope IN ('user', 'project', 'session')),
  CHECK (content_length >= 0)
);

INSERT INTO session_identity_metadata
  (user_id, scope, scope_key, content_hash, content_length, revision, updated_at, source, source_file)
SELECT user_id, scope, scope_key, content_hash, char_length(content), revision, updated_at, source, source_file
  FROM session_identity_profiles
ON CONFLICT (user_id, scope, scope_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_session_identity_metadata_user_updated
  ON session_identity_metadata(user_id, updated_at DESC);
