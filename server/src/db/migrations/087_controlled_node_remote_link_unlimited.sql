-- Remote install links remain valid for exactly their existing 24-hour ticket
-- window, but no longer have an unrelated consume-count ceiling inside that
-- window. SQL NULL is the authoritative "no count limit" representation; the
-- download transaction still enforces ticket_expires_at and revoked_at.

ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN max_consumes DROP NOT NULL;

-- Upgrade active links minted by the previous contract. Before this migration,
-- browser and remote-link rows both used max_consumes=3 and had no delivery
-- column. The exact historical 24-hour mint interval distinguishes a remote
-- link from the five-minute browser ticket; install-command rows have their own
-- install_code_hash and are excluded explicitly.
UPDATE controlled_node_enrollments_v2
   SET max_consumes = NULL
 WHERE max_consumes = 3
   AND reusable = TRUE
   AND revoked_at IS NULL
   AND install_code_hash IS NULL
   AND ticket_expires_at - created_at = 86400000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'controlled_node_enrollments_v2'::regclass
       AND conname = 'controlled_node_enrollments_v2_max_consumes_positive'
  ) THEN
    ALTER TABLE controlled_node_enrollments_v2
      ADD CONSTRAINT controlled_node_enrollments_v2_max_consumes_positive
      CHECK (max_consumes IS NULL OR max_consumes > 0);
  END IF;
END $$;

COMMENT ON COLUMN controlled_node_enrollments_v2.max_consumes IS
  'Bounded download count for browser/install-command tickets; NULL means a remote link is bounded only by expiry and revocation.';
