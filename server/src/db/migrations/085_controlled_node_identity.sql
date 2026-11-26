-- Canonical public controlled-node identity. Internal servers.id remains the
-- high-entropy routing/authentication and referential-integrity key.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS node_id TEXT;

-- The old hostname-derived ref_name grammar must remain disjoint from the new
-- canonical grammar. Refuse an unsafe historical database rather than silently
-- retargeting a legacy ^^(ref_name) marker.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM servers
     WHERE node_role = 'controlled' AND ref_name ~ '^[1-9][0-9]{9}$'
  ) THEN
    RAISE EXCEPTION 'controlled node legacy ref_name collides with canonical node_id grammar';
  END IF;
END $$;

-- Deterministic server-authoritative backfill for existing controlled nodes.
-- It depends only on the immutable internal server id, never hostname/OS, and
-- probes a bounded deterministic sequence to avoid silent collisions.
DO $$
DECLARE
  controlled RECORD;
  attempt INTEGER;
  candidate TEXT;
BEGIN
  FOR controlled IN
    SELECT id FROM servers
     WHERE node_role = 'controlled' AND node_id IS NULL
     ORDER BY id
  LOOP
    FOR attempt IN 0..31 LOOP
      candidate := (1000000000::bigint
        + (('x' || substr(md5(controlled.id || ':' || attempt::text), 1, 15))::bit(60)::bigint
          % 9000000000::bigint))::text;
      IF NOT EXISTS (SELECT 1 FROM servers WHERE node_id = candidate) THEN
        UPDATE servers SET node_id = candidate WHERE id = controlled.id;
        EXIT;
      END IF;
    END LOOP;
    IF (SELECT node_id FROM servers WHERE id = controlled.id) IS NULL THEN
      RAISE EXCEPTION 'controlled node_id deterministic backfill retry exhausted for %', controlled.id;
    END IF;
  END LOOP;
END $$;

ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_controlled_node_id_check;
ALTER TABLE servers ADD CONSTRAINT servers_controlled_node_id_check CHECK (
  (node_role = 'controlled' AND node_id ~ '^[1-9][0-9]{9}$')
  OR (node_role <> 'controlled' AND node_id IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_controlled_node_id
  ON servers(node_id) WHERE node_role = 'controlled';
