-- Transport-backed agent metadata for sessions and sub-sessions.
-- Allows server to distinguish process vs transport sessions and persist
-- provider identity for session recovery after daemon restart.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_type TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS runtime_type TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS description TEXT;
