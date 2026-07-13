-- Controlled-node v2 download attempts (admission control + crash recovery).
--
-- Each attempt against a download ticket goes through three observable states:
--   reserved  — admission row with a short lease. It counts against capacity
--                but does NOT increment the parent `consumed_count` yet.
--   committed — attempt transition + parent `consumed_count` increment +
--                semantic consume audit occur in one transaction immediately
--                before response bytes are exposed. Post-response failures are
--                therefore billed to the client.
--   released  — the reservation ended before response commitment (e.g.
--                decrypt, trailer, descriptor or audit failure). No parent
--                decrement is needed because reservation never consumed.
--
-- The retention sweep (run periodically by the same job that sweeps
-- `controlled_node_enrollments_v2`) reclaims stale `reserved` rows whose
-- `lease_expires_at` has elapsed so a crashed node never burns the ticket
-- budget forever.
--
-- ATOMICITY CONTRACT: the migration runner executes file SQL and records the
-- migration in separate calls. Keep this file as one DO statement so all DDL
-- runs in PostgreSQL's implicit transaction and any error rolls it all back.
-- Do not use file-level BEGIN/COMMIT: a failure before COMMIT can return an
-- aborted pooled connection to the runner.

DO $migration$
BEGIN

CREATE TABLE IF NOT EXISTS controlled_node_download_attempts (
  -- surrogate identity (UUID v4 minted server-side).
  attempt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- parent ticket (FK with ON DELETE CASCADE so ticket deletion reclaims
  -- attempt rows automatically).
  ticket_id           UUID NOT NULL REFERENCES controlled_node_enrollments_v2(id) ON DELETE CASCADE,
  -- owner copy: redundant with the parent but used by the retention sweep
  -- to filter by user without an additional join.
  owner_user_id       TEXT NOT NULL,
  -- attempt lifecycle.
  state               TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'committed', 'released')),
  -- lease deadline; reservations past this are fair game for the retention
  -- sweep to mark `released`.
  lease_expires_at    BIGINT NOT NULL,
  -- terminal timestamps (NULL while still in `reserved`).
  committed_at        BIGINT,
  released_at         BIGINT,
  -- bookkeeping. consumed_count_after is zero while reserved, then records
  -- the parent row's post-increment value in the same transaction that commits
  -- the attempt and writes the consume audit.
  consumed_count_after INTEGER NOT NULL,
  last_consume_ip     TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

-- Admission is serialized by SELECT ... FOR UPDATE on the parent ticket and
-- enforces `consumed_count + live reserved < max_consumes`. Up to three live
-- reservations may therefore coexist; this index supports admission/lease
-- lookups but is not unique.
CREATE INDEX IF NOT EXISTS idx_dl_attempts_ticket_reserved
  ON controlled_node_download_attempts(ticket_id)
  WHERE state = 'reserved';

-- Hot path: cleanup sweep scans expired leases ordered by deadline.
CREATE INDEX IF NOT EXISTS idx_dl_attempts_lease_expires
  ON controlled_node_download_attempts(lease_expires_at)
  WHERE state = 'reserved';

-- Hot path: per-user retention queries (operator reports / debugging).
CREATE INDEX IF NOT EXISTS idx_dl_attempts_owner_created
  ON controlled_node_download_attempts(owner_user_id, created_at DESC);

END
$migration$;
