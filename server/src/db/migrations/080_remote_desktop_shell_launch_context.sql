-- One-use local presentation contexts for the separately signed controlled-
-- computer account shell.  The raw launch id/context is never persisted: the
-- Server stores only a domain-separated SHA-256 digest plus non-secret binding
-- metadata needed to re-check the current Owner/session/endpoint generation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_native_sessions_user_id_id_key'
  ) THEN
    ALTER TABLE remote_desktop_native_sessions
      ADD CONSTRAINT remote_desktop_native_sessions_user_id_id_key
      UNIQUE (user_id, id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_host_endpoints_owner_host_server_key'
  ) THEN
    ALTER TABLE remote_desktop_host_endpoints
      ADD CONSTRAINT remote_desktop_host_endpoints_owner_host_server_key
      UNIQUE (owner_user_id, host_id, server_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS remote_desktop_shell_launch_contexts (
  context_hash        TEXT PRIMARY KEY CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  native_session_id   TEXT NOT NULL,
  host_id             TEXT NOT NULL,
  execution_server_id TEXT NOT NULL,
  endpoint_generation BIGINT NOT NULL
                      CHECK (endpoint_generation BETWEEN 0 AND 9007199254740991),
  issued_at           BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at          BIGINT NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
  redeemed_at         BIGINT CHECK (redeemed_at BETWEEN 0 AND 9007199254740991),
  invalidated_at      BIGINT CHECK (invalidated_at BETWEEN 0 AND 9007199254740991),
  created_at          BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (owner_user_id, native_session_id)
    REFERENCES remote_desktop_native_sessions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, host_id)
    REFERENCES remote_desktop_hosts(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, host_id, execution_server_id)
    REFERENCES remote_desktop_host_endpoints(owner_user_id, host_id, server_id)
    ON DELETE CASCADE,
  CHECK (expires_at > issued_at),
  CHECK (expires_at - issued_at <= 60000),
  CHECK (redeemed_at IS NULL OR redeemed_at >= issued_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at),
  CHECK (NOT (redeemed_at IS NOT NULL AND invalidated_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rd_shell_launch_contexts_expiry
  ON remote_desktop_shell_launch_contexts(expires_at)
  WHERE redeemed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rd_shell_launch_contexts_native_session
  ON remote_desktop_shell_launch_contexts(owner_user_id, native_session_id, created_at DESC);
