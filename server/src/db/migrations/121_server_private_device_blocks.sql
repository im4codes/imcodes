-- Per-user, per-host symmetric self-protection ("各自保护自己").
-- Allows any user (host owner or active collaborator) to block that host's
-- daemon from accessing, enumerating, or controlling their own unshared
-- private devices — even during their own turns.
CREATE TABLE IF NOT EXISTS server_private_device_blocks (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  block_private_devices BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
