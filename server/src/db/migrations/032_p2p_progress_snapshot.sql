ALTER TABLE discussion_orchestration_runs
  ADD COLUMN IF NOT EXISTS progress_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
