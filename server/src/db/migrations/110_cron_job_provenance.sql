-- Track creator/share provenance for cron jobs created via shared access
-- so share revocation stops participant-created crons from continuing to fire.
CREATE TABLE IF NOT EXISTS cron_job_provenance (
  job_id          TEXT PRIMARY KEY REFERENCES cron_jobs(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL,
  server_id       TEXT NOT NULL,
  project_name    TEXT,
  shared          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_job_provenance_server_creator
  ON cron_job_provenance (server_id, creator_user_id)
  WHERE shared = TRUE;
