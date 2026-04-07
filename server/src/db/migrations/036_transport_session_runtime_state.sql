-- Persist transport runtime settings so model/thinking survive refresh,
-- cross-device loading, daemon reconnect, and session restart/rebuild.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS requested_model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS transport_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS requested_model TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS active_model TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS transport_config JSONB NOT NULL DEFAULT '{}'::jsonb;
