-- Durable delivery claims and owning-pod acknowledgement metadata for the
-- typed remote-desktop guest outbox. This also adds the link commit revision
-- required by the shared event and makes delivery restart-safe.

ALTER TABLE remote_desktop_guest_outbox
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS acknowledged_by TEXT,
  ADD COLUMN IF NOT EXISTS slo_anchor_at BIGINT;

ALTER TABLE remote_desktop_guest_links
  ADD COLUMN IF NOT EXISTS commit_revision BIGINT NOT NULL DEFAULT 1;

UPDATE remote_desktop_guest_outbox
   SET slo_anchor_at = created_at
 WHERE slo_anchor_at IS NULL;

ALTER TABLE remote_desktop_guest_outbox
  ALTER COLUMN slo_anchor_at SET NOT NULL;

-- This feature has not previously had a consumer, but keep an additive
-- migration safe if an operator inserted acknowledged fixture rows manually.
UPDATE remote_desktop_guest_outbox
   SET acknowledged_by = 'legacy'
 WHERE state = 'acknowledged' AND acknowledged_by IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_outbox_claim_pair_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_outbox
      ADD CONSTRAINT remote_desktop_guest_outbox_claim_pair_check
      CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_outbox_payload_object_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_outbox
      ADD CONSTRAINT remote_desktop_guest_outbox_payload_object_check
      CHECK (jsonb_typeof(payload) = 'object') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_outbox_slo_anchor_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_outbox
      ADD CONSTRAINT remote_desktop_guest_outbox_slo_anchor_check
      CHECK (slo_anchor_at <= created_at) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_outbox_ack_owner_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_outbox
      ADD CONSTRAINT remote_desktop_guest_outbox_ack_owner_check
      CHECK ((state = 'acknowledged') = (acknowledged_by IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_outbox_shared_target_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_outbox
      ADD CONSTRAINT remote_desktop_guest_outbox_shared_target_check
      CHECK (
        (target_server_id IS NULL AND target_route_generation IS NULL)
        OR (target_server_id IS NOT NULL
          AND target_route_generation IS NOT NULL
          AND target_route_generation >= 0)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'remote_desktop_guest_links_commit_revision_check'
  ) THEN
    ALTER TABLE remote_desktop_guest_links
      ADD CONSTRAINT remote_desktop_guest_links_commit_revision_check
      CHECK (commit_revision > 0) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_rd_guest_outbox_claimable
  ON remote_desktop_guest_outbox(available_at, host_id, sequence, claim_expires_at)
  WHERE state = 'pending';
