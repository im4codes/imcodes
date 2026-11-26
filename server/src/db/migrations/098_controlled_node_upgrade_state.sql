-- Durable controlled-node upgrade state is shared by every API/WS process.
-- The bridge remains the source of transitions, while machine discovery can
-- report the authoritative state even when a request lands on another pod.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS controlled_upgrade_status TEXT,
  ADD COLUMN IF NOT EXISTS controlled_upgrade_target_version TEXT,
  ADD COLUMN IF NOT EXISTS controlled_upgrade_reason TEXT;
