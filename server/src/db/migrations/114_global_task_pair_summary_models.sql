-- Additive executor/auditor model IDs for compact display on Global Task Mode cards.
ALTER TABLE global_task_pair_summaries ADD COLUMN IF NOT EXISTS executor_model TEXT;
ALTER TABLE global_task_pair_summaries ADD COLUMN IF NOT EXISTS auditor_model TEXT;
