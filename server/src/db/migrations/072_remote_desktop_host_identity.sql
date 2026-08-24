-- Canonical physical-host identity for remote desktop.
--
-- A FULL daemon and the controlled-node endpoint it hosts are two `servers`
-- rows describing one physical desktop. Public identity, unattended password
-- authority, link authority and collaboration budget belong to the desktop, not
-- to either row, so this migration introduces a principal that both endpoints
-- attach to.
--
-- Purely additive. Nothing here enables guest access: no route reads these
-- tables until the access track lands.

-- Composite ownership target so an endpoint mapping can prove, in the schema,
-- that the endpoint and the host it attaches to belong to the same account.
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so guard it explicitly to keep
-- the file re-runnable like the rest of the migration set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'servers_user_id_id_key'
  ) THEN
    ALTER TABLE servers ADD CONSTRAINT servers_user_id_id_key UNIQUE (user_id, id);
  END IF;
END
$$;

-- One row per physical desktop.
--
-- `merge_state` is the guest-admission gate for the conflict case: when two
-- independently provisioned eligible endpoints are later declared to be one
-- desktop, admission stays closed until an owner picks the surviving authority.
-- Links and passwords are never silently combined, so the state is explicit
-- rather than inferred from endpoint topology.
CREATE TABLE IF NOT EXISTS remote_desktop_hosts (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merge_state   TEXT NOT NULL DEFAULT 'resolved'
                CHECK (merge_state IN ('resolved', 'conflict_pending')),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE (owner_user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_remote_desktop_hosts_owner
  ON remote_desktop_hosts (owner_user_id, id);

-- Which `servers` rows are this desktop. A server belongs to at most one host,
-- so `server_id` is the primary key rather than a plain column.
--
-- The composite foreign keys are the ownership-safety guarantee: an endpoint
-- cannot attach to another account's host even if a caller supplies a
-- well-formed host id.
CREATE TABLE IF NOT EXISTS remote_desktop_host_endpoints (
  server_id     TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  host_id       TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_role TEXT NOT NULL CHECK (endpoint_role IN ('full', 'controlled')),
  linked_at     BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id, host_id)
    REFERENCES remote_desktop_hosts(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, server_id)
    REFERENCES servers(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_desktop_host_endpoints_host
  ON remote_desktop_host_endpoints (host_id, endpoint_role);

-- Active and retired public IDs share one table, so `public_id` as the primary
-- key is the global non-reuse guarantee: a retired value can never be handed to
-- another desktop, and the allocator's collision retry is a plain unique
-- violation rather than a second history lookup.
--
-- `host_id` is nullable with ON DELETE SET NULL rather than CASCADE. Deleting a
-- host must not free its identifiers for reassignment; the row survives with no
-- host, permanently reserving the value. An orphaned row is inert because
-- readiness requires a non-null host.
CREATE TABLE IF NOT EXISTS remote_desktop_public_ids (
  public_id    TEXT PRIMARY KEY CHECK (public_id ~ '^[5-9][0-9]{9}$'),
  host_id      TEXT REFERENCES remote_desktop_hosts(id) ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  activated_at BIGINT NOT NULL,
  retired_at   BIGINT,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- At most one active identity per desktop. Retired rows are excluded, and rows
-- whose host was deleted hold a NULL host_id, which a unique index treats as
-- distinct — exactly the intended behaviour for inert reservations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_desktop_public_ids_active_host
  ON remote_desktop_public_ids (host_id)
  WHERE status = 'active' AND host_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_remote_desktop_public_ids_host_history
  ON remote_desktop_public_ids (host_id, status, activated_at DESC);

-- Owner-visible record of a linkage that two already-identified desktops cannot
-- resolve on their own. Retained after resolution so the audit trail shows which
-- authority survived and which public ID was retired.
CREATE TABLE IF NOT EXISTS remote_desktop_host_merge_conflicts (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id           TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  other_host_id     TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  resolution        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (resolution IN ('pending', 'resolved')),
  surviving_host_id TEXT REFERENCES remote_desktop_hosts(id) ON DELETE SET NULL,
  detected_at       BIGINT NOT NULL,
  resolved_at       BIGINT,
  CHECK ((resolution = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (host_id <> other_host_id)
);

-- One pending conflict per unordered host pair. The service always stores the
-- lexicographically smaller id in `host_id`, so a plain unique index is enough.
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_desktop_merge_conflicts_pending_pair
  ON remote_desktop_host_merge_conflicts (host_id, other_host_id)
  WHERE resolution = 'pending';

CREATE INDEX IF NOT EXISTS idx_remote_desktop_merge_conflicts_owner
  ON remote_desktop_host_merge_conflicts (owner_user_id, resolution, detected_at DESC);
