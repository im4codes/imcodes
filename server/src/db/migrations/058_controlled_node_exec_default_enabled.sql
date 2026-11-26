-- A controlled-node installation is an explicit owner action whose primary
-- purpose is remote execution. New nodes are executable immediately after
-- enrollment; owners can still disable execution later through the per-node
-- kill switch. Changing the default must not rewrite existing rows because a
-- stored false may represent an intentional owner decision.
ALTER TABLE servers ALTER COLUMN exec_enabled SET DEFAULT true;
