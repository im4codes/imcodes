CREATE TABLE IF NOT EXISTS session_identity_profiles (
  user_id     TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT   NOT NULL CHECK (scope IN ('user', 'project', 'session')),
  scope_key   TEXT   NOT NULL,
  content     TEXT   NOT NULL,
  content_hash TEXT  NOT NULL,
  source      TEXT   NOT NULL CHECK (source IN ('web', 'mcp')),
  revision    BIGINT NOT NULL DEFAULT 1,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, scope, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_session_identity_profiles_user_updated
  ON session_identity_profiles(user_id, updated_at DESC);
