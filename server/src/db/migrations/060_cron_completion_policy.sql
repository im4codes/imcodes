-- Distinguish recurring schedules from repeat-until-complete workflows.
-- Existing jobs default to recurring so one successful occurrence cannot
-- silently delete the schedule.
ALTER TABLE cron_jobs
  ADD COLUMN IF NOT EXISTS completion_policy TEXT NOT NULL DEFAULT 'recurring';

ALTER TABLE cron_jobs
  DROP CONSTRAINT IF EXISTS cron_jobs_completion_policy_check;

ALTER TABLE cron_jobs
  ADD CONSTRAINT cron_jobs_completion_policy_check
  CHECK (completion_policy IN ('recurring', 'until_complete'));
