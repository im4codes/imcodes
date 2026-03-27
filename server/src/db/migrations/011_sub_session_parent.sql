-- Add parent_session to sub_sessions for associating sub-sessions with their main session.
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS parent_session TEXT;

CREATE INDEX IF NOT EXISTS idx_sub_sessions_parent ON sub_sessions(parent_session);
