-- Extend cron_jobs for per-project targeting and expiration
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS project_name TEXT;
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS target_role TEXT NOT NULL DEFAULT 'brain';
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS updated_at BIGINT;

-- Drop redundant enabled column; status is authoritative
ALTER TABLE cron_jobs DROP COLUMN IF EXISTS enabled;

-- Pause orphaned jobs with no project_name (prevent deck__brain session names)
UPDATE cron_jobs SET status = 'paused' WHERE project_name IS NULL;

-- Convert existing plain-text action values to structured JSON (safe backfill)
UPDATE cron_jobs
SET action = '{"type":"command","command":' || to_json(action)::text || '}'
WHERE action IS NOT NULL AND action != '' AND LEFT(TRIM(action), 1) != '{';
