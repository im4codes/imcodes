-- Durable semantic audit for controlled-node remote execution.
-- One row per correlation id is inserted BEFORE dispatch and then updated with
-- the truthful terminal/indeterminate outcome. A crash leaves `pending`, which
-- is evidence that dispatch intent existed rather than silently losing audit.
CREATE TABLE IF NOT EXISTS machine_exec_audit (
  correlation_id   TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_server_id  TEXT REFERENCES servers(id) ON DELETE SET NULL,
  target_server_id  TEXT REFERENCES servers(id) ON DELETE SET NULL,
  command_sha256    TEXT NOT NULL CHECK (length(command_sha256) = 64),
  command_length    INTEGER NOT NULL CHECK (command_length >= 0),
  shell             TEXT NOT NULL,
  outcome           TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'not_dispatched', 'dispatched_no_result', 'completed', 'node_timeout', 'spawn_error')),
  exit_code         INTEGER,
  timed_out         BOOLEAN NOT NULL DEFAULT false,
  duration_ms       BIGINT NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_machine_exec_audit_user_created
  ON machine_exec_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_machine_exec_audit_target_created
  ON machine_exec_audit(target_server_id, created_at DESC);
