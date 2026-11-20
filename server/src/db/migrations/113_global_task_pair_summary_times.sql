-- Additive start/end timestamps for compact timing display on Global Task Mode cards.
ALTER TABLE global_task_pair_summaries ADD COLUMN IF NOT EXISTS started_at BIGINT;
ALTER TABLE global_task_pair_summaries ADD COLUMN IF NOT EXISTS ended_at BIGINT;
