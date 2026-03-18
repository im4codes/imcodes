-- Sub-sessions: independent tmux sessions (claude-code/codex/opencode/shell)
-- Stored in PG for cross-device sync.

CREATE TABLE IF NOT EXISTS sub_sessions (
  id           TEXT PRIMARY KEY,                        -- nanoid(8)
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                           -- 'claude-code' | 'codex' | 'opencode' | 'shell'
  shell_bin    TEXT,                                    -- e.g. '/opt/homebrew/bin/fish' (shell type only)
  cwd          TEXT,                                    -- working dir, NULL = daemon default
  label        TEXT,                                    -- user label, NULL = show type
  closed_at    BIGINT,                                  -- NULL = active, non-NULL = user closed
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_sessions_server ON sub_sessions(server_id);
