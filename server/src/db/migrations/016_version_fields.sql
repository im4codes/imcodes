-- Add version tracking fields for daemon and agent reporting

ALTER TABLE servers ADD COLUMN IF NOT EXISTS daemon_version TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_version TEXT;
