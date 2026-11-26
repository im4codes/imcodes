-- Additive, replayable after partial DDL; no ownership/user/node rows rewritten.
CREATE TABLE IF NOT EXISTS machine_group_invalidation_epoch (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision BIGINT NOT NULL DEFAULT 0
);
INSERT INTO machine_group_invalidation_epoch (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS machine_group_invalidation_receivers (
  id TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_group_invalidations (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  team_id TEXT,
  server_id TEXT,
  actor_id TEXT,
  recipients TEXT[] NOT NULL,
  acknowledgements TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS machine_group_invalidations_pending_idx
  ON machine_group_invalidations USING GIN (recipients)
  WHERE NOT recipients <@ acknowledgements;
