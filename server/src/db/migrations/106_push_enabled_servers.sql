-- Per-user opt-in allowlist of server IDs permitted to send push notifications (all disabled by default).
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled_server_ids TEXT[] NOT NULL DEFAULT '{}';
