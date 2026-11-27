-- Compact structured audit summary JSON for Global Task Mode cards.
ALTER TABLE global_task_pair_summaries ADD COLUMN IF NOT EXISTS last_audit_json TEXT;
