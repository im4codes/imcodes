CREATE TABLE IF NOT EXISTS server_token_usage_facts (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_fact_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  usage_date_utc DATE NOT NULL,
  received_at_ms BIGINT NOT NULL,
  session_name TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('main', 'sub')),
  parent_session_name TEXT,
  metadata_completeness TEXT NOT NULL CHECK (metadata_completeness IN ('complete', 'partial')),
  provider TEXT,
  agent_type TEXT,
  model TEXT,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  cache_tokens BIGINT NOT NULL CHECK (cache_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  total_tokens BIGINT NOT NULL CHECK (total_tokens = input_tokens + cache_tokens + output_tokens),
  context_window BIGINT CHECK (context_window IS NULL OR context_window >= 0),
  cost_usd_micros BIGINT,
  source_event_id TEXT,
  UNIQUE (server_id, usage_fact_id)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_date
  ON server_token_usage_facts(user_id, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_server_date
  ON server_token_usage_facts(user_id, server_id, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_provider_model_date
  ON server_token_usage_facts(user_id, provider, model, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_agent_date
  ON server_token_usage_facts(user_id, agent_type, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_session_date
  ON server_token_usage_facts(user_id, server_id, session_name, session_kind, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_parent_date
  ON server_token_usage_facts(user_id, parent_session_name, usage_date_utc);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_session_model_date
  ON server_token_usage_facts(user_id, server_id, session_name, session_kind, model, usage_date_utc);
