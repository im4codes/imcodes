CREATE TABLE IF NOT EXISTS verification_machine_profiles (
  id                       TEXT    PRIMARY KEY,
  user_id                  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope                    TEXT    NOT NULL CHECK (scope IN ('user', 'project')),
  scope_key                TEXT    NOT NULL,
  alias                    TEXT    NOT NULL,
  kind                     TEXT    NOT NULL CHECK (kind IN ('controlled_node', 'ssh')),
  target                   TEXT    NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  revision                 BIGINT  NOT NULL DEFAULT 1,
  created_at               BIGINT  NOT NULL,
  updated_at               BIGINT  NOT NULL,
  last_verified_at         BIGINT,
  last_verification_status TEXT    NOT NULL DEFAULT 'unverified'
    CHECK (last_verification_status IN ('unverified', 'verified', 'unreachable', 'unauthorized')),
  source                   TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  UNIQUE (user_id, scope, scope_key, alias)
);

CREATE INDEX IF NOT EXISTS idx_verification_machine_profiles_user_scope
  ON verification_machine_profiles(user_id, scope, scope_key, updated_at DESC);
