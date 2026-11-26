-- Which daemon a controlled node was enrolled from, when it was enrolled to give
-- that daemon's machine login-screen control.
--
-- Both installs then live on one physical machine, and the browser needs to know
-- they are the same machine: without this it would show two entries and let
-- someone open a session against each, putting two workers on one desktop.
--
-- Nullable throughout. A controlled node enrolled the ordinary way — its own
-- machine, no daemon involved — has no host, and that stays the common case.
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS host_server_id TEXT;

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS host_server_id TEXT;

-- Looked up per daemon when the browser decides where its remote-control button
-- should point.
CREATE INDEX IF NOT EXISTS idx_servers_host_server_id
  ON servers (host_server_id)
  WHERE host_server_id IS NOT NULL;
