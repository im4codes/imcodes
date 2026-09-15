-- First-class binding authority. Local bindings name one daemon and are never
-- included in account-wide synchronization batches.

CREATE TABLE IF NOT EXISTS capability_bindings (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE,
  version_id       TEXT NOT NULL REFERENCES capability_versions(id),
  scope            TEXT NOT NULL CHECK (scope IN ('account', 'project', 'session', 'local')),
  project_key      TEXT,
  session_key      TEXT,
  server_id        TEXT REFERENCES servers(id) ON DELETE CASCADE,
  provider_filter  JSONB NOT NULL DEFAULT '[]'::jsonb,
  machine_filter   JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorization_envelope JSONB,
  authority_state TEXT NOT NULL DEFAULT 'active'
    CHECK (authority_state IN ('active', 'disabled', 'removed')),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  revision         BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  CHECK (
    (scope = 'account' AND project_key IS NULL AND session_key IS NULL AND server_id IS NULL)
    OR (scope = 'project' AND project_key IS NOT NULL AND session_key IS NULL AND server_id IS NULL)
    OR (scope = 'session' AND session_key IS NOT NULL AND server_id IS NULL)
    OR (scope = 'local' AND server_id IS NOT NULL)
  ),
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, item_id, id),
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, item_id, version_id)
    REFERENCES capability_versions(owner_user_id, item_id, id)
);

CREATE INDEX IF NOT EXISTS idx_capability_bindings_owner_item
  ON capability_bindings(owner_user_id, item_id, enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_bindings_server
  ON capability_bindings(owner_user_id, server_id) WHERE server_id IS NOT NULL;
