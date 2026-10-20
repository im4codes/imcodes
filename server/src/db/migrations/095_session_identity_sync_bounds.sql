-- Bound the daemon's identity snapshot and support scoped-key lookups.
CREATE INDEX IF NOT EXISTS idx_sessions_server_state_project_name
  ON sessions(server_id, state, project_name, name);

CREATE INDEX IF NOT EXISTS idx_session_identity_profiles_user_scope_key
  ON session_identity_profiles(user_id, scope, scope_key);
