ALTER TABLE servers
ADD COLUMN IF NOT EXISTS shared_context_runtime_config JSONB NOT NULL DEFAULT '{}'::jsonb;
