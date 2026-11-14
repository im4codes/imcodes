-- Dispatch scheduler indexes for due cron job lookup and execution dispatch polling.
CREATE INDEX IF NOT EXISTS idx_cron_jobs_active_next_run
  ON cron_jobs(next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cron_executions_status_created
  ON cron_executions(status, created_at);
