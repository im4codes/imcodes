-- Persist transport provider connection status on the servers table.
-- Bridge updates this on provider.status messages from the daemon,
-- so browsers can read it on initial load without relying on WS timing.
-- Format: '{"openclaw": true}' — keys are provider IDs, values are booleans.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS connected_providers JSONB NOT NULL DEFAULT '{}';
