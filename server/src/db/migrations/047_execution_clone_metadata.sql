-- Dedicated execution clone sessions: persist first-class clone metadata on the
-- sub-session record (NEVER inside transport_config — the transport-identity
-- scrubber would silently drop identity-like keys).
--
-- Nullable for rolling-deploy tolerance: an older daemon that does not yet send
-- executionCloneMetadata simply leaves this NULL.

ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS execution_clone_metadata JSONB;
