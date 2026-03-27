-- Flag to distinguish user-created sessions from auto-synced provider sessions.
-- User-created sessions are protected from sync/health cleanup.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_created BOOLEAN DEFAULT FALSE;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS user_created BOOLEAN DEFAULT FALSE;
