-- Add timezone column for user-local cron scheduling
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT NULL;
