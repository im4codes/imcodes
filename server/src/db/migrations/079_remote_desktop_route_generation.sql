-- Independent remote-desktop route incarnation fence.
--
-- A daemon connection generation identifies the authenticated node channel;
-- it is not a route identity.  One daemon connection may create several route
-- incarnations, and a route may be replaced while a management-privacy epoch
-- remains live.  Allocate route generations from PostgreSQL so every pod sees
-- one monotonic namespace and cannot accidentally reuse a daemon generation.
CREATE SEQUENCE IF NOT EXISTS remote_desktop_route_generation_seq
  AS BIGINT START WITH 1 INCREMENT BY 1
  MAXVALUE 9007199254740991 NO CYCLE;

-- `shielding` is a replacement route that is deliberately pre-PREPARE from
-- the browser's point of view.  It belongs to the privacy snapshot and may not
-- be activated until the exact replacement snapshot has produced a real
-- Worker acknowledgement.
ALTER TABLE remote_desktop_host_routes
  DROP CONSTRAINT IF EXISTS remote_desktop_host_routes_state_check;
ALTER TABLE remote_desktop_host_routes
  ADD CONSTRAINT remote_desktop_host_routes_state_check
  CHECK (state IN ('admitting', 'shielding', 'active', 'closed'));

COMMENT ON COLUMN remote_desktop_host_routes.route_generation IS
  'Independent route incarnation allocated by remote_desktop_route_generation_seq; never a daemon generation.';
