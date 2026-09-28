-- Keep the daemon's live-session identity snapshot selective and indexable.
CREATE INDEX IF NOT EXISTS idx_sessions_server_state_project_name
  ON sessions(server_id, state, project_name, name);
