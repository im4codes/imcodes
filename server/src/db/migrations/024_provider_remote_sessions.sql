-- Cache remote sessions from transport providers (e.g., OpenClaw).
-- Updated when provider connects and when user manually refreshes.
-- Format: '{"openclaw": [{"key":"sess-1","displayName":"My session",...}]}'

ALTER TABLE servers ADD COLUMN IF NOT EXISTS provider_remote_sessions JSONB NOT NULL DEFAULT '{}';
