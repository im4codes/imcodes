-- Push token notification types preference
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS notification_types TEXT[] DEFAULT ARRAY['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop'];

UPDATE push_tokens
SET notification_types = ARRAY['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop']
WHERE notification_types IS NULL;
