-- Add project_dir to sessions so daemon can rebuild them after restart
ALTER TABLE sessions ADD COLUMN project_dir TEXT NOT NULL DEFAULT '';

-- Unique index so we can upsert by (server_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_server_name ON sessions(server_id, name);
