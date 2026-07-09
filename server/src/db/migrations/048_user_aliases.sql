-- User-level "别名 / alias" quick-reference store.
-- One row per (user, alias name). Name is NFC, case-sensitive, validated by the
-- shared allowlist in shared/alias-types.ts. Value is the user's own exact text
-- (may be multi-line); never logged. See openspec/changes/alias-quick-insert.

CREATE TABLE IF NOT EXISTS user_aliases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  value       TEXT NOT NULL,
  description TEXT,
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  source      TEXT NOT NULL DEFAULT 'web',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_aliases_user
  ON user_aliases (user_id);
