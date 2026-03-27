-- Add current_round tracking and participant info to discussions.

ALTER TABLE discussions ADD COLUMN IF NOT EXISTS current_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS current_speaker TEXT;
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS participants TEXT;  -- JSON array of { roleLabel, agentType, model }
