-- Stable remote-install links.
--
-- Browser tickets and install commands keep their existing bounded expiry.
-- A newly minted remote link is one durable credential per
-- owner/canonical OS/arch/optional host binding, is returned again on repeat
-- copy, and stops only when revoked_at is set. Existing 24-hour links remain
-- valid under their original contract; they have no encrypted_ticket and are
-- therefore deliberately outside the stable-link uniqueness index.

ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS delivery TEXT;

UPDATE controlled_node_enrollments_v2
   SET delivery = CASE
     WHEN install_code_hash IS NOT NULL THEN 'install_command'
     WHEN max_consumes IS NULL THEN 'remote_link'
     ELSE 'browser'
   END
 WHERE delivery IS NULL;

ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN delivery SET DEFAULT 'browser';
ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN delivery SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'controlled_node_enrollments_v2'::regclass
       AND conname = 'controlled_node_enrollments_v2_delivery_valid'
  ) THEN
    ALTER TABLE controlled_node_enrollments_v2
      ADD CONSTRAINT controlled_node_enrollments_v2_delivery_valid
      CHECK (delivery IN ('browser', 'remote_link', 'install_command'));
  END IF;
END $$;

-- AES-GCM ciphertext containing only the raw remote-link ticket. The ordinary
-- ticket_hash remains the authority lookup; plaintext is returned only to the
-- authenticated owner and is never logged or stored unencrypted.
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS encrypted_ticket TEXT;

ALTER TABLE controlled_node_enrollments_v2
  ALTER COLUMN ticket_expires_at DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'controlled_node_enrollments_v2'::regclass
       AND conname = 'controlled_node_enrollments_v2_stable_ticket_shape'
  ) THEN
    ALTER TABLE controlled_node_enrollments_v2
      ADD CONSTRAINT controlled_node_enrollments_v2_stable_ticket_shape
      CHECK (
        (encrypted_ticket IS NULL AND ticket_expires_at IS NOT NULL)
        OR (
          encrypted_ticket IS NOT NULL
          AND delivery = 'remote_link'
          AND ticket_expires_at IS NULL
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_v2_stable_remote_binding
  ON controlled_node_enrollments_v2
    (owner_user_id, os, arch, (COALESCE(host_server_id, '')))
  WHERE delivery = 'remote_link'
    AND revoked_at IS NULL
    AND encrypted_ticket IS NOT NULL;

COMMENT ON COLUMN controlled_node_enrollments_v2.delivery IS
  'Ticket delivery contract: browser, remote_link, or install_command.';
COMMENT ON COLUMN controlled_node_enrollments_v2.encrypted_ticket IS
  'AES-GCM encrypted raw bearer for stable remote links; NULL for all legacy and bounded tickets.';
COMMENT ON COLUMN controlled_node_enrollments_v2.ticket_expires_at IS
  'Download expiry; NULL only for a stable remote link whose authority ends at explicit revocation.';
