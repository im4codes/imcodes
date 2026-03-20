-- P2P Quick Discussion orchestration runs
CREATE TABLE IF NOT EXISTS discussion_orchestration_runs (
  id                    TEXT PRIMARY KEY,
  discussion_id         TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  server_id             TEXT NOT NULL,
  main_session          TEXT NOT NULL,
  initiator_session     TEXT NOT NULL,
  current_target_session TEXT,
  final_return_session  TEXT NOT NULL,
  remaining_targets     JSONB NOT NULL DEFAULT '[]',
  mode_key              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','dispatched','running','awaiting_next_hop','completed','timed_out','failed','interrupted','cancelling','cancelled')),
  request_message_id    TEXT,
  callback_message_id   TEXT,
  context_ref           JSONB NOT NULL DEFAULT '{}',
  timeout_ms            INTEGER NOT NULL DEFAULT 300000,
  result_summary        TEXT,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orch_runs_discussion ON discussion_orchestration_runs(discussion_id);
CREATE INDEX IF NOT EXISTS idx_orch_runs_server_status ON discussion_orchestration_runs(server_id, status);
