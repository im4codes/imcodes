-- Persist bound listen/target pod IDs so cross-pod local connection generations never alias across pods.
ALTER TABLE port_forward_tunnels ADD COLUMN IF NOT EXISTS listen_pod_id TEXT NOT NULL DEFAULT '';
ALTER TABLE port_forward_tunnels ADD COLUMN IF NOT EXISTS target_pod_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_pf_tunnels_listen_session
  ON port_forward_tunnels (listen_server_id, listen_pod_id, listen_generation, status);
CREATE INDEX IF NOT EXISTS idx_pf_tunnels_target_session
  ON port_forward_tunnels (target_server_id, target_pod_id, target_generation, status);
