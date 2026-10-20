-- Durable status for the independently released remote-desktop worker.
-- This is separate from daemon self-upgrade state: a daemon may stay on the
-- same version while its worker sidecar is refreshed.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_phase TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_installed_version TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_target_version TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_artifact_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_reason TEXT,
  ADD COLUMN IF NOT EXISTS controlled_worker_refresh_recorded_at BIGINT;
