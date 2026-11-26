-- User-level notification type preferences synced across mobile tokens and desktop/PC-app clients.
-- NULL = fall back to existing push_tokens.notification_types or DEFAULT_PUSH_NOTIFICATION_TYPES.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_notification_types TEXT[] DEFAULT NULL;
