-- One browser-originated decision per operation revision, plus content-safe
-- control-plane audit metadata. No approval credential or package body is stored.

CREATE TABLE IF NOT EXISTS capability_confirmations (
  id               TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id     TEXT NOT NULL REFERENCES capability_operations(id) ON DELETE CASCADE,
  operation_revision BIGINT NOT NULL CHECK (operation_revision > 0),
  decision         TEXT NOT NULL CHECK (decision IN ('install', 'cancel')),
  artifact_digest  TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  audit_digest     TEXT NOT NULL CHECK (audit_digest ~ '^[0-9a-f]{64}$'),
  target_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       BIGINT NOT NULL,
  UNIQUE (operation_id, operation_revision),
  FOREIGN KEY (owner_user_id, operation_id)
    REFERENCES capability_operations(owner_user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS capability_audit_events (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id         TEXT REFERENCES capability_items(id) ON DELETE SET NULL,
  operation_id    TEXT REFERENCES capability_operations(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  actor_kind      TEXT NOT NULL,
  scope           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id),
  FOREIGN KEY (owner_user_id, operation_id)
    REFERENCES capability_operations(owner_user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_capability_audit_owner_created
  ON capability_audit_events(owner_user_id, created_at DESC, id DESC);
