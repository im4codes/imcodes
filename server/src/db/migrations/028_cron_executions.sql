CREATE TABLE IF NOT EXISTS cron_executions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  detail      TEXT,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_exec_job ON cron_executions(job_id, created_at DESC);
