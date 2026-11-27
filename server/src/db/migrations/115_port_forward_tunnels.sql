-- Authoritative cross-pod registry and bounded/ordered opaque message bus for P2P / relayed port-forwarding tunnels.

CREATE TABLE IF NOT EXISTS port_forward_endpoints (
  server_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS port_forward_tunnels (
  tunnel_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  coordinator_pod_id TEXT NOT NULL,
  listen_node TEXT NOT NULL,
  listen_server_id TEXT NOT NULL,
  listen_node_id TEXT,
  listen_generation BIGINT NOT NULL,
  requested_listen_port INTEGER NOT NULL,
  bound_listen_port INTEGER,
  target_node TEXT NOT NULL,
  target_server_id TEXT NOT NULL,
  target_node_id TEXT,
  target_generation BIGINT NOT NULL,
  target_host TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  transport_pref TEXT NOT NULL,
  transport_mode TEXT,
  status TEXT NOT NULL,
  active_connections INTEGER NOT NULL DEFAULT 0,
  bytes_sent BIGINT NOT NULL DEFAULT 0,
  bytes_received BIGINT NOT NULL DEFAULT 0,
  label TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pf_tunnels_user_status ON port_forward_tunnels (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pf_tunnels_listen ON port_forward_tunnels (listen_server_id, status);
CREATE INDEX IF NOT EXISTS idx_pf_tunnels_target ON port_forward_tunnels (target_server_id, status);

CREATE TABLE IF NOT EXISTS port_forward_bus_messages (
  seq BIGSERIAL PRIMARY KEY,
  target_pod_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tunnel_id TEXT,
  direction TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

ALTER TABLE port_forward_bus_messages ADD COLUMN IF NOT EXISTS tunnel_id TEXT;
ALTER TABLE port_forward_bus_messages ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE port_forward_bus_messages ADD COLUMN IF NOT EXISTS byte_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE port_forward_bus_messages ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pf_bus_target_seq ON port_forward_bus_messages (target_pod_id, seq);
CREATE INDEX IF NOT EXISTS idx_pf_bus_tunnel_dir ON port_forward_bus_messages (tunnel_id, direction) WHERE tunnel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pf_bus_expires ON port_forward_bus_messages (expires_at);
