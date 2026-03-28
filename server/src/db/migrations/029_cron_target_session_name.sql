-- Add target_session_name column for sub-session cron targeting
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS target_session_name TEXT DEFAULT NULL;
