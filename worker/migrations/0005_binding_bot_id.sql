-- Add bot_id to channel_bindings for deterministic inbound routing.
-- Without this, a user with the same channel bound to multiple servers
-- gets LIMIT 1 ambiguity on webhook dispatch.

ALTER TABLE channel_bindings ADD COLUMN bot_id TEXT REFERENCES platform_bots(id);

-- Remove any pre-migration bindings that have no bot_id: they can never be routed to
-- after this migration, and users must re-bind their channels anyway (bot registration
-- is a new step in this release). Keeping NULL rows would leave dead routing state.
DELETE FROM channel_bindings WHERE bot_id IS NULL;

-- New unique constraint: one binding per (platform, channel_id, bot_id).
-- A channel can still be bound to different servers via different bots.
CREATE UNIQUE INDEX idx_channel_bindings_bot ON channel_bindings(platform, channel_id, bot_id);

-- Update the platform lookup index to include bot_id for the new query path.
DROP INDEX IF EXISTS idx_channel_bindings_platform;
CREATE INDEX idx_channel_bindings_platform ON channel_bindings(platform, channel_id, bot_id);
