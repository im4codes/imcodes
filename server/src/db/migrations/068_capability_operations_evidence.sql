-- Private workflow state. Draft/scan/audit/commit internals are not exposed as
-- independent AI tools; the operation row is the reconnect-safe public handle.

CREATE TABLE IF NOT EXISTS capability_operations (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id            TEXT REFERENCES capability_items(id) ON DELETE SET NULL,
  operation_kind    TEXT NOT NULL CHECK (operation_kind IN ('install', 'manage')),
  idempotency_key   TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
    'queued', 'acquiring', 'scanning', 'auditing', 'awaiting_confirmation',
    'installing', 'syncing', 'installed', 'rework', 'failed', 'cancelled'
  )),
  request_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_digest   TEXT,
  audit_digest      TEXT,
  error_code        TEXT,
  revision          BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  completed_at      BIGINT,
  UNIQUE (owner_user_id, idempotency_key),
  UNIQUE (owner_user_id, id),
  FOREIGN KEY (owner_user_id, item_id)
    REFERENCES capability_items(owner_user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_capability_operations_owner_updated
  ON capability_operations(owner_user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS capability_evidence (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id    TEXT NOT NULL REFERENCES capability_operations(id) ON DELETE CASCADE,
  evidence_kind   TEXT NOT NULL CHECK (evidence_kind IN ('scan', 'audit')),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  policy_version  TEXT NOT NULL,
  verdict         TEXT CHECK (verdict IN ('PASS', 'REWORK')),
  findings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      BIGINT NOT NULL,
  UNIQUE (operation_id, evidence_kind, evidence_digest),
  FOREIGN KEY (owner_user_id, operation_id)
    REFERENCES capability_operations(owner_user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capability_evidence_owner_operation
  ON capability_evidence(owner_user_id, operation_id, created_at);
