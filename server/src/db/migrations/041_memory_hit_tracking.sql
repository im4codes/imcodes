-- Memory hit tracking: usage stats + archive status for projections.

ALTER TABLE shared_context_projections ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shared_context_projections ADD COLUMN IF NOT EXISTS last_used_at BIGINT;
ALTER TABLE shared_context_projections ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_shared_context_projections_status ON shared_context_projections(status);
