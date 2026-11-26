-- Persist only the controlled node's sanitized, versioned capability snapshot.
-- This keeps daemon-independent /api/machines discovery accurate across pods
-- without storing signaling/session authority.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS controlled_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
