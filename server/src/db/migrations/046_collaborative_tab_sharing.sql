-- Collaborative tab/server sharing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_server_name_key'
  ) THEN
    IF to_regclass('public.idx_sessions_server_name') IS NOT NULL THEN
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_server_name_key UNIQUE USING INDEX idx_sessions_server_name;
    ELSE
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_server_name_key UNIQUE (server_id, name);
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS server_shares (
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  expires_at     BIGINT,
  revoked_at     BIGINT,
  UNIQUE (server_id, target_user_id)
);

CREATE TABLE IF NOT EXISTS session_shares (
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL,
  session_name   TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  expires_at     BIGINT,
  revoked_at     BIGINT,
  FOREIGN KEY (server_id, session_name) REFERENCES sessions(server_id, name) ON DELETE CASCADE,
  UNIQUE (server_id, session_name, target_user_id)
);

CREATE TABLE IF NOT EXISTS sub_session_shares (
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL,
  sub_session_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  expires_at     BIGINT,
  revoked_at     BIGINT,
  FOREIGN KEY (sub_session_id, server_id) REFERENCES sub_sessions(id, server_id) ON DELETE CASCADE,
  UNIQUE (server_id, sub_session_id, target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_shares_target_user_active
  ON server_shares (target_user_id, server_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_session_shares_target_lookup_active
  ON session_shares (target_user_id, server_id, session_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sub_session_shares_target_lookup_active
  ON sub_session_shares (target_user_id, server_id, sub_session_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_server_shares_active_expiry
  ON server_shares (expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_shares_active_expiry
  ON session_shares (expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sub_session_shares_active_expiry
  ON sub_session_shares (expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_audit_events (
  id                   TEXT PRIMARY KEY,
  server_id            TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_user_id        TEXT REFERENCES users(id),
  target_user_id       TEXT REFERENCES users(id),
  effective_actor_role TEXT NOT NULL CHECK (effective_actor_role IN ('viewer', 'participant', 'server-manager', 'server-member', 'system')),
  target_kind          TEXT NOT NULL CHECK (target_kind IN ('server', 'main', 'subsession')),
  target_ref           TEXT NOT NULL,
  action_type          TEXT NOT NULL CHECK (action_type IN (
    'share.create', 'share.update', 'share.revoke', 'share.downgrade',
    'share.expire', 'share.target_delete', 'session.send', 'session.cancel',
    'discussion.comment', 'p2p.orchestration', 'rate_limit'
  )),
  decision             TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'updated', 'teardown')),
  reason               TEXT CHECK (reason IS NULL OR reason IN (
    'share-role-denied', 'share-direct-surface-denied', 'share-rate-limited',
    'share-revoked', 'share-expired', 'share-target-unavailable',
    'share-role-changed', 'share-ticket-invalid', 'share-cancel-unsupported',
    'share-audit-duplicate', 'share-comment-invalid'
  )),
  snapshot             JSONB NOT NULL,
  primary_share_id     TEXT,
  action_id            TEXT,
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           BIGINT NOT NULL,
  CHECK ((actor_kind = 'user' AND actor_user_id IS NOT NULL) OR (actor_kind = 'system' AND actor_user_id IS NULL)),
  CHECK (decision IN ('accepted', 'updated') OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_share_audit_events_server_created
  ON share_audit_events (server_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_audit_events_target
  ON share_audit_events (server_id, target_kind, target_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS discussion_comments (
  id                    TEXT PRIMARY KEY,
  server_id             TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  thread_id             TEXT,
  scope_kind            TEXT NOT NULL CHECK (scope_kind IN ('server', 'main', 'subsession')),
  scope_server_id       TEXT NOT NULL,
  scope_session_name    TEXT,
  scope_sub_session_id  TEXT,
  created_by_user_id    TEXT NOT NULL REFERENCES users(id),
  actor_envelope        JSONB NOT NULL,
  authorization_snapshot JSONB NOT NULL,
  primary_share_id      TEXT,
  covering_share_ids    JSONB NOT NULL DEFAULT '[]',
  visible_after_ms      BIGINT NOT NULL,
  history_cutoff_at_ms  BIGINT NOT NULL,
  body                  TEXT NOT NULL,
  created_at            BIGINT NOT NULL,
  CHECK (
    (scope_kind = 'server' AND scope_session_name IS NULL AND scope_sub_session_id IS NULL)
    OR (scope_kind = 'main' AND scope_session_name IS NOT NULL AND scope_sub_session_id IS NULL)
    OR (scope_kind = 'subsession' AND scope_session_name IS NULL AND scope_sub_session_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_discussion_comments_scope_visible
  ON discussion_comments (server_id, scope_kind, scope_session_name, scope_sub_session_id, visible_after_ms, created_at);

ALTER TABLE discussion_orchestration_runs
  ADD COLUMN IF NOT EXISTS scope_kind TEXT CHECK (scope_kind IS NULL OR scope_kind IN ('server', 'main', 'subsession')),
  ADD COLUMN IF NOT EXISTS scope_server_id TEXT,
  ADD COLUMN IF NOT EXISTS scope_session_name TEXT,
  ADD COLUMN IF NOT EXISTS scope_sub_session_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS authorization_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS primary_share_id TEXT,
  ADD COLUMN IF NOT EXISTS covering_share_ids JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS visible_after_ms BIGINT,
  ADD COLUMN IF NOT EXISTS history_cutoff_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS share_target_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_orch_runs_share_scope_visible
  ON discussion_orchestration_runs (server_id, scope_kind, scope_session_name, scope_sub_session_id, visible_after_ms);
