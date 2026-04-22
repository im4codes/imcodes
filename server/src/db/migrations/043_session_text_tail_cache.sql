CREATE TABLE IF NOT EXISTS session_text_tail_cache (
  server_id TEXT NOT NULL,
  session_name TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_ts BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, session_name)
);

CREATE INDEX IF NOT EXISTS idx_session_text_tail_cache_updated_at
  ON session_text_tail_cache (updated_at DESC);
