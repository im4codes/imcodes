-- Lightweight cross-server task summary projection for Global Task Mode.
-- Stores only compact metadata & dual checklist counts (never full brief text).
CREATE TABLE IF NOT EXISTS global_task_pair_summaries (
  server_id             TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  project_name          TEXT NOT NULL DEFAULT '',
  brain_session         TEXT NOT NULL DEFAULT '',
  brain_label           TEXT NOT NULL DEFAULT '',
  title                 TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL,
  flags_json            TEXT NOT NULL DEFAULT '[]',
  round                 INTEGER NOT NULL DEFAULT 0,
  checklist_total       INTEGER NOT NULL DEFAULT 0,
  checklist_implemented INTEGER NOT NULL DEFAULT 0,
  checklist_audited     INTEGER NOT NULL DEFAULT 0,
  executor_label        TEXT,
  auditor_label         TEXT,
  auditor               TEXT,
  live_summary          TEXT,
  is_terminal           BOOLEAN NOT NULL DEFAULT FALSE,
  needs_attention       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            BIGINT NOT NULL DEFAULT 0,
  updated_at            BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_global_task_pair_summaries_server_updated
  ON global_task_pair_summaries (server_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_global_task_pair_summaries_terminal_updated
  ON global_task_pair_summaries (is_terminal, updated_at DESC);
