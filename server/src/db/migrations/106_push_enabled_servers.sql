-- Per-user allowlist of server IDs permitted to send push notifications.
-- NULL = untouched auto-default (1 accessible server -> enabled; 0 or >1 -> all disabled until manually checked).
-- Non-null array (including '{}') = explicit user selection.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled_server_ids TEXT[] DEFAULT NULL;
