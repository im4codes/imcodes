-- Add hop-level progress tracking to discussions table.
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS total_rounds INTEGER NOT NULL DEFAULT 1;
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS completed_hops INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS total_hops INTEGER NOT NULL DEFAULT 0;
