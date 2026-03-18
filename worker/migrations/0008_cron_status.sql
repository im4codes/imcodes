-- Add status column to cron_jobs (replaces the enabled flag used by job-dispatch queries)
ALTER TABLE cron_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- Sync existing rows: enabled=1 → 'active', enabled=0 → 'paused'
UPDATE cron_jobs SET status = CASE WHEN enabled = 1 THEN 'active' ELSE 'paused' END;
